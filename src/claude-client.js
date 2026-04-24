import axios from "axios";

class ClaudeClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseURL = "https://api.anthropic.com/v1"\;
    this.model = "claude-3-5-sonnet-20241022";
  }

  async reviewCode(filePath, diffContent) {
    const systemPrompt = `You are a PROFESSIONAL SECURITY CODE REVIEWER.

YOUR JOB: Find EVERY security issue, bug, and code smell.

CRITICAL - You MUST report:
1. SQL Injection (string concatenation in queries)
2. Hardcoded secrets/API keys/passwords
3. Missing input validation
4. Unsafe operations
5. Poor error handling
6. Performance issues

EXAMPLES OF ISSUES YOU MUST FIND:
- "SELECT * FROM users WHERE id = " + userInput  ← SQL INJECTION
- const API = "sk-123456"  ← HARDCODED SECRET
- function process(x) { doSomething(x); }  ← NO VALIDATION

YOUR RESPONSE FORMAT:
Return a JSON array. Each issue object MUST have:
- severity: "critical" | "warning" | "suggestion"
- line: line number (integer)
- message: short description of the issue
- suggestion: how to fix it
- explanation: why it matters

EXAMPLE RESPONSE:
[
  {
    "severity": "critical",
    "line": 5,
    "message": "SQL Injection vulnerability - user input concatenated into SQL query",
    "suggestion": "Use parameterized queries: database.query('SELECT * FROM users WHERE id = ?', [id])",
    "explanation": "Concatenating user input into SQL allows attackers to execute arbitrary queries"
  }
]

RULES:
- Return ONLY valid JSON array
- No markdown, no code blocks, no explanation text
- If no issues, return: []
- Be thorough and strict
- Report security issues first

CODE TO REVIEW:`;

    const userMessage = `${diffContent}

Analyze this code. Return JSON array with issues.`;

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
