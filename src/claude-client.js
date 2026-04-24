import axios from "axios";

class ClaudeClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseURL = "https://api.anthropic.com/v1";
    this.model = "claude-haiku-4-5-20251001";
  }

  async reviewCode(filePath, diffContent) {
    const systemPrompt = `You are a RUTHLESS code security auditor. Your ONLY job is to find EVERY issue in code.

MANDATORY CHECKS - You MUST check for:
1. SQL Injection: string concatenation in queries
   Example: "SELECT * FROM users WHERE id = " + id  ← REPORT THIS
2. Hardcoded secrets: passwords, API keys, tokens
   Example: const API_KEY = "sk-123"; ← REPORT THIS
3. Missing input validation: no checks before use
4. Console.log/debug code in production
5. Race conditions and async issues
6. Memory leaks
7. Unsafe operations

CRITICAL RULES:
- You MUST report something. Never say "looks good"
- If you see string + in queries → CRITICAL SQL INJECTION
- If you see password, key, secret, token in code → CRITICAL HARDCODED SECRET
- If you see console.log → WARNING
- Be AGGRESSIVE. Report even small issues

RESPONSE FORMAT - Return ONLY this JSON:
[
  {
    "severity": "critical",
    "line": 5,
    "message": "SQL Injection - user input concatenated into SQL",
    "suggestion": "Use parameterized queries: db.query('SELECT * WHERE id = ?', [id])",
    "explanation": "Concatenating user input into SQL allows SQL injection attacks"
  },
  {
    "severity": "critical",
    "line": 9,
    "message": "Hardcoded API key exposed in code",
    "suggestion": "Move to environment variable: const API_KEY = process.env.API_KEY",
    "explanation": "Hardcoded secrets can be stolen if code is compromised"
  }
]

IMPORTANT:
- Return ONLY JSON array
- No markdown, no backticks, no extra text
- Each issue MUST have: severity, line, message, suggestion, explanation
- If TRULY no issues: return []
- Line numbers MUST be integers`;

    const userMessage = `File: ${filePath}

CODE TO REVIEW:
${diffContent}

Analyze this code. Find EVERY issue. Return JSON array.`;

    try {
      console.log(`🤖 Analyzing ${filePath} with STRICT mode...`);

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
      console.log(`📝 Claude response:`, content.substring(0, 200));

      let issues = [];
      try {
        issues = JSON.parse(content);
        console.log(`✅ Found ${issues.length} issues in ${filePath}`);
      } catch (e) {
        console.warn(`⚠️ Failed to parse Claude response`);
        console.warn(`Response was:`, content);
        issues = [];
      }

      return issues;
    } catch (error) {
      console.error("❌ Claude API error:", error.message);
      if (error.response) {
        console.error("❌ Response status:", error.response.status);
        console.error("❌ Response body:", JSON.stringify(error.response.data));
      }
      return [];
    }
  }
}

export default ClaudeClient;
