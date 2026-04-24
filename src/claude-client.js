import axios from "axios";

class ClaudeClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseURL = "https://api.anthropic.com/v1";
    this.model = "claude-3-5-sonnet-20241022";
  }

  async reviewCode(filePath, diffContent) {
    const systemPrompt = `You are an expert code reviewer. Analyze the following code changes and identify issues.

For EACH issue, respond ONLY with a JSON array (no markdown, no extra text):
[
  {
    "severity": "critical|warning|suggestion",
    "line": 42,
    "message": "Clear explanation of the issue",
    "suggestion": "How to fix it",
    "explanation": "Why this matters"
  }
]

Guidelines:
- 🔴 Critical: Security vulnerabilities, logic bugs, crashes, data loss
- 🟡 Warning: Performance problems, code smells, maintainability issues
- 💡 Suggestion: Best practices, style improvements, refactoring opportunities

IMPORTANT:
- Return ONLY valid JSON, no markdown, no code blocks, no extra text
- Be concise but specific
- If no issues found, return: []
- Focus on important issues, skip nitpicks
- Line numbers refer to the diff context`;

    const userMessage = `File: ${filePath}

Code changes:
\`\`\`
${diffContent}
\`\`\`

Analyze these changes and return ONLY JSON array.`;

    try {
      console.log(`🤖 Analizzando ${filePath} con Claude...`);

      const response = await axios.post(
        `${this.baseURL}/messages`,
        {
          model: this.model,
          max_tokens: 2048,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: userMessage,
            },
          ],
        },
        {
          headers: {
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          timeout: 30000,
        }
      );

      const content = response.data.content[0].text;

      let issues = [];
      try {
        issues = JSON.parse(content);
        console.log(`✅ Trovati ${issues.length} problemi in ${filePath}`);
      } catch (e) {
        console.warn(`⚠️ Errore nel parsing della risposta Claude:`);
        console.warn(content);
        issues = [];
      }

      return issues;
    } catch (error) {
      if (error.response?.status === 429) {
        console.error("⏳ Rate limit raggiunto, aspetta un momento...");
      } else if (error.code === "ECONNABORTED") {
        console.error("⏱️ Timeout nella richiesta a Claude");
      } else {
        console.error("❌ Errore Claude API:", error.response?.data?.error || error.message);
      }
      return [];
    }
  }
}

export default ClaudeClient;
