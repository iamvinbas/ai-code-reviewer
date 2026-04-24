import { Octokit } from "octokit";

class GitHubClient {
  constructor(token) {
    this.octokit = new Octokit({ auth: token });
    this.commitSha = null;
  }

  async getPRChanges(owner, repo, pull_number) {
    console.log(`📂 Scaricando cambiamenti PR #${pull_number}...`);
    
    try {
      const { data: files } = await this.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number,
      });

      const changes = [];

      for (const file of files) {
        if (this.shouldSkipFile(file.filename)) {
          console.log(`⏭️  Skipping ${file.filename}`);
          continue;
        }

        changes.push({
          filename: file.filename,
          patch: file.patch,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        });

        console.log(`✅ Aggiunto: ${file.filename} (+${file.additions}/-${file.deletions})`);
      }

      console.log(`\n📊 Totale file da revisionare: ${changes.length}`);
      return changes;
    } catch (error) {
      console.error("❌ Errore nel leggere i file della PR:", error.message);
      throw error;
    }
  }

  shouldSkipFile(filename) {
    const skipPatterns = [
      /\.lock$/,
      /\.min\.js$/,
      /\.min\.css$/,
      /node_modules/,
      /dist\//,
      /build\//,
      /\.md$/,
      /\.yml$/,
      /\.yaml$/,
      /\.json$/,
      /\.lock$/,
      /\.svg$/,
      /\.png$/,
      /\.jpg$/,
      /\.gif$/,
    ];

    return skipPatterns.some((pattern) => pattern.test(filename));
  }

  async postComment(owner, repo, pull_number, body, line, path) {
    try {
      const { data: prData } = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number,
      });

      const commitSha = prData.head.sha;

      console.log(`💬 Postando commento su ${path}:${line}`);

      return await this.octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number,
        body,
        commit_id: commitSha,
        path,
        line,
      });
    } catch (error) {
      console.error(
        `❌ Errore nel postare commento su ${path}:${line}:`,
        error.message
      );
    }
  }

  async postGeneralComment(owner, repo, pull_number, body) {
    try {
      console.log(`📝 Postando commento generale sulla PR...`);

      return await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pull_number,
        body,
      });
    } catch (error) {
      console.error("❌ Errore nel postare commento generale:", error.message);
      throw error;
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default GitHubClient;
