import("dotenv/config");
import fs from "fs";
import GitHubClient from "./github-client.js";
import ClaudeClient from "./claude-client.js";
import CodeAnalyzer from "./code-analyzer.js";

async function main() {
  console.log("\n🤖 AI Code Reviewer Bot - Starting...\n");

  const {
    GITHUB_TOKEN,
    CLAUDE_API_KEY,
    GITHUB_REPOSITORY,
    GITHUB_EVENT_PATH,
  } = process.env;

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

  let event;
  try {
    const eventContent = fs.readFileSync(GITHUB_EVENT_PATH, "utf8");
    event = JSON.parse(eventContent);
  } catch (error) {
    console.error("❌ Errore nel leggere GitHub event:", error.message);
    process.exit(1);
  }

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

  const github = new GitHubClient(GITHUB_TOKEN);
  const claude = new ClaudeClient(CLAUDE_API_KEY);
  const analyzer = new CodeAnalyzer(github, claude);

  try {
    const issues = await analyzer.analyzePR(
      owner,
      repo,
      pull_number,
      commitSha
    );

    if (issues.length > 0) {
      console.log(`\n✅ Trovati ${issues.length} problemi, posting commenti...`);
      await analyzer.postReviewComments(
        owner,
        repo,
        pull_number,
        issues,
        commitSha
      );
    } else {
      console.log("\n✅ Nessun problema trovato! PR looks good! 🎉");
      
      await github.postGeneralComment(
        owner,
        repo,
        pull_number,
        `## ✅ AI Code Review Complete\n\nNo issues found! Your code looks great! 🎉\n\n*Powered by AI Code Reviewer Bot* ⚙️`
      );
    }

    console.log("\n✅ Review completata con successo!\n");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Errore durante la review:", error.message);
    console.error(error.stack);

    try {
      await github.postGeneralComment(
        owner,
        repo,
        pull_number,
        `⚠️ **AI Code Review Error**\n\nAn error occurred during review. Check [workflow logs](https://github.com/${GITHUB_REPOSITORY}/actions) for details.`
      );
    } catch (e) {
      console.error("Couldn't post error comment:", e.message);
    }

    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
