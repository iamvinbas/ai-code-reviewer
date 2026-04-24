import axios from "axios";

class AIClient {
  constructor(githubToken) {
    this.token = githubToken;
    this.baseURL = "https://models.inference.ai.azure.com";
    this.model = "gpt-4o-mini";
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
- critical: Security vulnerabilities, logic bugs, crashes, data loss
- warning: Performance problems, code smells, maintainability issues
- suggestion: Best practices, style improvements, refactoring opportunities

IMPORTANT:
- Return ONLY valid JSON array, no markdown, no code blocks, no extra text
- Be concise but specific
- If no issues found, return: []
- Focus on important issues, skip nitpicks
- Line numbers refer to the diff context`;

    const userMessage = `File: ${filePath}

Code changes:
\`\`\`
${diffContent}
\`\`\`

Analyze these changes and return ONLY a JSON array.`;

    try {
      console.log(`🤖 Analizzando ${filePath}...`);

      const response = await axios.post(
        `${this.baseURL}/chat/completions`,
        {
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          max_tokens: 2048,
          temperature: 0,
        },
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        }
      );

      const content = response.data.choices[0].message.content;

      let issues = [];
      try {
        const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
        issues = JSON.parse(cleaned);
        console.log(`✅ Trovati ${issues.length} problemi in ${filePath}`);
      } catch (e) {
        console.warn(`⚠️ Errore nel parsing risposta AI:`);
        console.warn(content);
        issues = [];
      }

      return issues;
    } catch (error) {
      if (error.response?.status === 429) {
        console.error("⏳ Rate limit raggiunto, aspetta un momento...");
      } else if (error.code === "ECONNABORTED") {
        console.error("⏱️ Timeout nella richiesta");
      } else {
        console.error("❌ Errore AI API:", error.response?.data?.error || error.message);
      }
      return [];
    }
  }
}

export default AIClient;
