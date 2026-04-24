import axios from "axios";

class ClaudeClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseURL = "https://api.anthropic.com/v1";
    this.model = "claude-3-5-sonnet-20241022";
  }

  async reviewCode(filePath, diffContent) {
    const systemPrompt = `You are a SECURITY AUDITOR. Your job is to find EVERY issue in code.

CRITICAL: You MUST find and report:
1. SQL Injection vulnerabilities (string concatenation in queries)
2. Hardcoded secrets/API keys/passwords
3. Missing input validation
4. Race conditions
5. Memory leaks
6. Unsafe operations
7. Security issues

RULES:
- Be STRICT and AGGRESSIVE
- If you see ANY suspicious pattern, report it as an issue
- Don't say "looks good" - always find something
- Focus on SECURITY first, then performance

Format your response as JSON array:
[
  {
    "severity": "critical|warning|suggestion",
    "line": <line number>,
    "message": "<what's wrong>",
    "suggestion": "<how to fix>",
    "explanation": "<why this matters>"
  }
]

IMPORTANT: Return ONLY JSON, no markdown, no extra text.
If you find NO issues, return empty array: []`;

    const userMessage = `File: ${filePath}

Code changes:
\`\`\`
${diffContent}
\`\`\`

Analyze these changes and return ONLY JSON array with issues found.`;

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
        },
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
        console.error(
          "❌ Errore Claude API:",
          error.response?.data?.error || error.message,
        );
      }
      return [];
    }
  }
}

export default ClaudeClient;
