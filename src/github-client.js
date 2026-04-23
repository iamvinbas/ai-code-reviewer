const { Octokit } = require("octokit");

class GitHubClient {
  constructor(token) {
    this.octokit = new Octokit({ auth: token });
    this.commitSha = null;
  }

  /**
   * Scarica tutti i file modificati nella PR
   */
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
        // Salta file binari e non-codice
        if (this.shouldSkipFile(file.filename)) {
          console.log(`⏭️  Skipping ${file.filename}`);
          continue;
        }

        changes.push({
          filename: file.filename,
          patch: file.patch, // Diff completo
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        });

        console.log(
          `✅ Aggiunto: ${file.filename} (+${file.additions}/-${file.deletions})`,
        );
      }

      console.log(`\n📊 Totale file da revisionare: ${changes.length}`);
      return changes;
    } catch (error) {
      console.error("❌ Errore nel leggere i file della PR:", error.message);
      throw error;
    }
  }

  /**
   * Determina se un file deve essere saltato
   */
  shouldSkipFile(filename) {
    const skipPatterns = [
      /\.lock$/, // package-lock.json, yarn.lock
      /\.min\.js$/, // File minimizzati
      /\.min\.css$/,
      /node_modules/, // Dipendenze
      /dist\//, // Build folder
      /build\//,
      /\.md$/, // Markdown
      /\.yml$/, // YAML config
      /\.yaml$/,
      /\.json$/, // JSON (config, package.json)
      /\.lock$/, // Lock files
      /\.svg$/, // SVG (spesso auto-generati)
      /\.png$/, // Immagini
      /\.jpg$/,
      /\.gif$/,
    ];

    return skipPatterns.some((pattern) => pattern.test(filename));
  }

  /**
   * Posta un commento su una linea specifica della PR
   */
  async postComment(owner, repo, pull_number, body, line, path) {
    try {
      // Ottieni l'ultimo commit della PR
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
        error.message,
      );
      // Non throw, continua con altri commenti
    }
  }

  /**
   * Posta un commento generale sulla PR
   */
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

  /**
   * Utility: sleep
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = GitHubClient;
