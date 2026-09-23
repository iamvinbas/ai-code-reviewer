/*
 * Tiny fake LLM server for e2e tests. Speaks both dialects:
 *  - OpenAI-compatible: POST /v1/chat/completions, GET /v1/models
 *  - Ollama native:     POST /api/chat, GET /api/tags
 * Chat replies are scripted (queue or function) and every request is recorded.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  raw: string;
  /** Parsed JSON body, or undefined. */
  body: any;
}

export interface ChatMessageLike {
  role: string;
  content: string;
}

/** Full control of the HTTP response. `raw` wins over `content`. */
export interface FakeHttpReply {
  status?: number;
  headers?: Record<string, string>;
  /** Assistant message content; wrapped in the endpoint's response shape. */
  content?: string;
  /** Raw response body, sent as-is (e.g. to simulate a broken server). */
  raw?: string;
  delayMs?: number;
}

/** A plain string is the assistant content. */
export type FakeReply = string | FakeHttpReply;
export type ChatHandler = (req: RecordedRequest, messages: ChatMessageLike[]) => FakeReply | Promise<FakeReply>;

export interface FakeIssue {
  severity: string;
  file?: string;
  line?: number | null;
  title: string;
  message?: string;
  suggestion?: string;
  category?: string;
  endLine?: number;
  fix?: { startLine: number; endLine: number; replacement: string };
}

/** Assistant content the review engine accepts. */
export function issuesReply(issues: FakeIssue[]): string {
  return JSON.stringify({ issues: issues.map((i) => ({ message: `${i.title} (details)`, ...i })) });
}

export const NO_ISSUES = issuesReply([]);

export class FakeLLM {
  readonly requests: RecordedRequest[] = [];
  /** Models listed by /v1/models and /api/tags. */
  models: string[] = ["fake"];
  private queue: FakeReply[] = [];
  private handler: ChatHandler | null = null;
  private fallback: FakeReply = NO_ISSUES;
  private server: Server | null = null;
  private sockets = new Set<import("node:net").Socket>();
  port = 0;

  static async start(): Promise<FakeLLM> {
    const fake = new FakeLLM();
    await fake.listen();
    return fake;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** OpenAI-compatible base URL. */
  get baseUrl(): string {
    return `${this.origin}/v1`;
  }

  /** Only chat requests (either dialect). */
  get chatRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === "POST" && (r.path === "/v1/chat/completions" || r.path === "/api/chat"));
  }

  /** Replies consumed in order; when empty, the handler (or the fallback) answers. */
  enqueue(...replies: FakeReply[]): this {
    this.queue.push(...replies);
    return this;
  }

  onChat(handler: ChatHandler | null): this {
    this.handler = handler;
    return this;
  }

  setFallback(reply: FakeReply): this {
    this.fallback = reply;
    return this;
  }

  reset(): void {
    this.requests.length = 0;
    this.queue = [];
    this.handler = null;
    this.fallback = NO_ISSUES;
    this.models = ["fake"];
  }

  private async listen(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      });
    });
    server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const recorded: RecordedRequest = { method: req.method ?? "GET", path, headers: req.headers, raw, body };
    this.requests.push(recorded);

    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };

    if (req.method === "GET" && path === "/v1/models") {
      return json(200, { object: "list", data: this.models.map((id) => ({ id, object: "model" })) });
    }
    if (req.method === "GET" && path === "/api/tags") {
      const names = this.models.map((m) => (m.includes(":") ? m : `${m}:latest`));
      return json(200, { models: names.map((name) => ({ name, model: name })) });
    }
    const isOpenAI = req.method === "POST" && path === "/v1/chat/completions";
    const isOllama = req.method === "POST" && path === "/api/chat";
    if (!isOpenAI && !isOllama) return json(404, { error: `not found: ${req.method} ${path}` });

    const messages = ((body as { messages?: ChatMessageLike[] } | undefined)?.messages ?? []) as ChatMessageLike[];
    const next = this.queue.shift() ?? (this.handler ? await this.handler(recorded, messages) : this.fallback);
    const reply: FakeHttpReply = typeof next === "string" ? { content: next } : next;
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;
    const status = reply.status ?? 200;
    if (reply.raw !== undefined) {
      res.writeHead(status, { "Content-Type": "application/json", ...reply.headers });
      res.end(reply.raw);
      return;
    }
    if (status < 200 || status >= 300) {
      return json(status, { error: { message: `fake error ${status}` } }, reply.headers);
    }
    const content = reply.content ?? NO_ISSUES;
    const model = (body as { model?: string } | undefined)?.model ?? "fake";
    if (isOllama) {
      return json(
        status,
        {
          model,
          created_at: "2026-01-01T00:00:00Z",
          message: { role: "assistant", content },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 10,
          eval_count: 5,
        },
        reply.headers,
      );
    }
    return json(
      status,
      {
        id: `chatcmpl-${this.requests.length}`,
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      reply.headers,
    );
  }
}

/** A port on which nothing is listening (bound then released). */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Extracts the diff between the BEGIN/END DIFF markers of the user message. */
export function diffOf(messages: ChatMessageLike[]): string {
  const user = messages.filter((m) => m.role === "user")[0]?.content ?? "";
  const m = /===== BEGIN DIFF (\w+) =====\n([\s\S]*?)\n===== END DIFF \1 =====/.exec(user);
  return m?.[2] ?? "";
}

/** File paths ("### <path> (<status>)" headers) present in the diff of a chat request. */
export function filesInPrompt(messages: ChatMessageLike[]): string[] {
  return [...diffOf(messages).matchAll(/^### (.+?) \((?:added|modified|deleted|renamed)[^)]*\)$/gm)].map((m) => m[1] ?? "");
}
