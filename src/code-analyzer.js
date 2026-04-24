class CodeAnalyzer {
  constructor(githubClient, claudeClient) {
    this.github = githubClient;
    this.claude = claudeClient;
  }

  async analyzePR(owner, repo, pull_number, commitSha) {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`🔍 INIZIO ANALISI PR #${pull_number}`);
    console.log(`${"=".repeat(50)}\n`);

    const changes = await this.github.getPRChanges(owner, repo, pull_number);

    if (changes.length === 0) {
      console.log("ℹ️  Nessun file da revisionare (tutti skippati)");
      return [];
    }

    const allIssues = [];

    for (const file of changes) {
      try {
        const issues = await this.claude.reviewCode(file.filename, file.patch);

        for (const issue of issues) {
          allIssues.push({
            ...issue,
            filename: file.filename,
            commitSha,
          });
        }
      } catch (error) {
        console.error(`❌ Errore nell'analizzare ${file.filename}:`, error.message);
      }

      await this.github.sleep(1000);
    }

    console.log(`\n📊 TOTALE PROBLEMI TROVATI: ${allIssues.length}\n`);
    return allIssues;
  }

  async postReviewComments(owner, repo, pull_number, issues, commitSha) {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`💬 POSTING COMMENTI`);
    console.log(`${"=".repeat(50)}\n`);

    const critical = issues.filter((i) => i.severity === "critical");
    const warnings = issues.filter((i) => i.severity === "warning");
    const suggestions = issues.filter((i) => i.severity === "suggestion");

    let postedCount = 0;

    for (const issue of issues) {
      try {
        const commentBody = this.formatComment(issue);

        await this.github.postComment(
          owner,
          repo,
          pull_number,
          commentBody,
          issue.line,
          issue.filename
        );

        postedCount++;
      } catch (error) {
        console.error("❌ Errore nel postare commento:", error.message);
      }

      await this.github.sleep(500);
    }

    const summaryBody = this.formatSummary(critical, warnings, suggestions);
    await this.github.postGeneralComment(owner, repo, pull_number, summaryBody);

    console.log(`\n✅ Postati ${postedCount} commenti\n`);
  }

  formatComment(issue) {
    const severityEmoji = {
      critical: "🔴",
      warning: "🟡",
      suggestion: "💡",
    };

    const severityText = {
      critical: "CRITICAL",
      warning: "WARNING",
      suggestion: "SUGGESTION",
    };

    return `${severityEmoji[issue.severity]} **${severityText[issue.severity]}**

${issue.message}

**Suggestion:** ${issue.suggestion}

<details>
<summary>Why?</summary>

${issue.explanation}
</details>`;
  }

  formatSummary(critical, warnings, suggestions) {
    let body = `## 🤖 AI Code Review Summary\n\n`;

    body += `**${critical.length}** critical | **${warnings.length}** warnings | **${suggestions.length}** suggestions\n\n`;

    if (critical.length > 0) {
      body += `### 🔴 Critical Issues\n`;
      critical.forEach((i, idx) => {
        body += `${idx + 1}. **${i.filename}:${i.line}** - ${i.message}\n`;
      });
      body += "\n";
    }

    if (warnings.length > 0) {
      body += `### 🟡 Warnings\n`;
      warnings.forEach((i, idx) => {
        body += `${idx + 1}. **${i.filename}:${i.line}** - ${i.message}\n`;
      });
      body += "\n";
    }

    if (suggestions.length > 0) {
      body += `### 💡 Suggestions\n`;
      suggestions.slice(0, 5).forEach((i, idx) => {
        body += `${idx + 1}. **${i.filename}:${i.line}** - ${i.message}\n`;
      });
      if (suggestions.length > 5) {
        body += `\n... and ${suggestions.length - 5} more suggestions (see inline comments)\n`;
      }
      body += "\n";
    }

    body += `---\n`;
    body += `*Powered by AI Code Reviewer Bot* ⚙️`;

    return body;
  }
}

export default CodeAnalyzer;
