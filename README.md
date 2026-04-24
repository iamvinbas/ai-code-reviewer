# AI Code Reviewer Bot

Automatic AI code review on every pull request. No API keys. No cost. Powered by GitHub Models.

## How it works

When you open a PR, the bot reviews every changed file and posts inline comments for bugs, security issues, and bad practices. PRs with critical issues fail the check.

## Setup

### Option A — Fork (easiest)

Click **Fork** at the top of this page. Done. The bot is ready on your fork immediately — no configuration needed.

### Option B — Add to an existing repository

1. Copy the `src/` folder and `package.json` from this repo into your project root
2. Copy `.github/workflows/review.yml` into your project
3. Run `npm install` once to install dependencies
4. Push to GitHub — the bot activates on the next PR

No secrets, no tokens, no billing.

## How authentication works

The bot uses the `GITHUB_TOKEN` — a temporary token that GitHub automatically generates for every workflow run. You don't create it, store it, or pay for it.

- **It's scoped to your repo only** — no access to other repos or accounts
- **It expires after each run** — can't be leaked or reused
- **Each user gets their own** — forking the repo gives every user their independent token
- **No setup required** — GitHub injects it automatically via `${{ secrets.GITHUB_TOKEN }}`

If you ever need to inspect it: **Settings → Actions → General → Workflow permissions**.

**For local testing only** — if you want to run the bot on your machine instead of via GitHub Actions, you need a Personal Access Token (PAT):

1. Go to **https://github.com/settings/tokens/new**
2. Give it a name (e.g. `ai-code-reviewer-local`)
3. Select scopes: `repo` + `workflow` + `models` (if available)
4. Click **Generate token** and copy it
5. Paste it in your `.env` file as `GITHUB_TOKEN=ghp_your_token_here`

The PAT is only needed locally. In GitHub Actions, everything is automatic.

## Example

![Inline comment on SQL injection](assets/inline-comment.png)

![AI Code Review Summary](assets/review-summary.png)

## What it detects

| Severity | Examples |
|----------|---------|
| 🔴 Critical | SQL injection, XSS, `eval()`, hardcoded credentials, null dereference, division by zero |
| 🟡 Warning | Memory leaks, race conditions, missing error handling, performance issues |
| 💡 Suggestion | Code style, naming, best practices |

## Languages supported

JavaScript, TypeScript, Python, Java, Go, PHP, Ruby, C, C++, and more. Skips lock files, minified files, images, and docs.

## Blocking merges on critical issues

To prevent merging PRs with critical bugs:

1. Go to **Settings → Branches → Add branch protection rule**
2. Set branch name pattern to `main`
3. Enable **Require status checks to pass before merging**
4. Add `AI Code Review / review`

> Requires GitHub Pro for private repositories. Works for free on public repositories.

## Requirements

- GitHub repository (public or private)
- GitHub Actions enabled
- Node.js 18+
