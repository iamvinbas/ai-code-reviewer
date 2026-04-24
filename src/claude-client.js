import axios from "axios";

class ClaudeClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseURL = "https://api.anthropic.com/v1"\;
    this.model = "claude-3-5-sonnet-20241022";
  }

  async reviewCode(filePath, diffContent) {
    const systemPrompt = `You are an expert code reviewer. Analyze code changes.

Find and report:
- Security issues (SQL injection, hardcoded secrets)
- Logic bugs
- Performance problems
- Code quality issues

Return ONLY JSON array:
[
  {
    "severity": "critical|warning|suggestion",
    "line": 42,
    "message": "Issue description",
    "suggestion": "How to fix",
    "explanation": "Why it matters"
  }
]

If no issues, return empty array: []`;

    const userMessage = `File: ${filePath}

Code:
${diffContent}

Return JSON array with issues found.`;

    try {
      console.log(`🤖 Analyzing ${filePath}...`);

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
        console.log(`✅ Found ${issues.length} issues in ${filePath}`);
      } catch (e) {
        console.warn(`Warning: Could not parse Claude response`);
        issues = [];
      }

      return issues;
    } catch (error) {
      console.error("Claude API error:", error.message);
      return [];
    }
  }
}

export default ClaudeClient;
