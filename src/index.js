require("dotenv").config();
const fs = require("fs");
const GitHubClient = require("./github-client");
const ClaudeClient = require("./claude-client");
const CodeAnalyzer = require("./code-analyzer");

async function main() {
  console.log("\n🤖 AI Code Reviewer Bot - Starting...\n");

  // Leggi variabili d'ambiente
  const { GITHUB_TOKEN, CLAUDE_API_KEY, GITHUB_REPOSITORY, GITHUB_EVENT_PATH } =
    process.env;

  // Validazione
  if (!GITHUB_TOKEN) {
    throw new Error("❌ Missing GITHUB_TOKEN");
  }

  if (!CLAUDE_API_KEY) {
    throw new Error("❌ Missing CLAUDE_API_KEY");
  }

  if (!GITHUB_EVENT_PATH) {
    throw new Error("❌ Missing GITHUB_EVENT_PATH (not in GitHub Action?)");
  }

  if (!GITHUB_REPOSITORY) {
    throw new Error("❌ Missing GITHUB_REPOSITORY");
  }

  console.log(`✅ GitHub Token: configured`);
  console.log(`✅ Claude API Key: configured`);
  console.log(`📦 Repository: ${GITHUB_REPOSITORY}`);

  // Parse GitHub event
  let event;
  try {
    const eventContent = fs.readFileSync(GITHUB_EVENT_PATH, "utf8");
    event = JSON.parse(eventContent);
  } catch (error) {
    console.error("❌ Errore nel leggere GitHub event:", error.message);
    process.exit(1);
  }

  // Estrai dati dalla PR
  const pullRequest = event.pull_request;
  if (!pullRequest) {
    console.log("ℹ️  No pull request in event, skipping");
    process.exit(0);
  }

  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  const pull_number = pullRequest.number;
  const commitSha = pullRequest.head.sha;

  console.log(`\n📋 Pull Request Info:`);
  console.log(`   - Number: #${pull_number}`);
  console.log(`   - Title: "${pullRequest.title}"`);
  console.log(`   - Author: @${pullRequest.user.login}`);
  console.log(`   - Commit: ${commitSha.substring(0, 7)}`);

  // Inizializza client
  const github = new GitHubClient(GITHUB_TOKEN);
  const claude = new ClaudeClient(CLAUDE_API_KEY);
  const analyzer = new CodeAnalyzer(github, claude);

  try {
    // 1. Analizza la PR
    const issues = await analyzer.analyzePR(
      owner,
      repo,
      pull_number,
      commitSha,
    );

    // 2. Posta commenti se ci sono problemi
    if (issues.length > 0) {
      console.log(
        `\n✅ Trovati ${issues.length} problemi, posting commenti...`,
      );
      await analyzer.postReviewComments(
        owner,
        repo,
        pull_number,
        issues,
        commitSha,
      );
    } else {
      console.log("\n✅ Nessun problema trovato! PR looks good! 🎉");

      // Posta commento positivo
      await github.postGeneralComment(
        owner,
        repo,
        pull_number,
        `## ✅ AI Code Review Complete\n\nNo issues found! Your code looks great! 🎉\n\n*Powered by AI Code Reviewer Bot* ⚙️`,
      );
    }

    console.log("\n✅ Review completata con successo!\n");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Errore durante la review:", error.message);
    console.error(error.stack);

    // Prova a postare un commento di errore
    try {
      await github.postGeneralComment(
        owner,
        repo,
        pull_number,
        `⚠️ **AI Code Review Error**\n\nErrr occurred during review. Check [workflow logs](https://github.com/${GITHUB_REPOSITORY}/actions) for details.`,
      );
    } catch (e) {
      console.error("Couldn't post error comment:", e.message);
    }

    process.exit(1);
  }
}

// Esegui
main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
