# Running acr in CI

`acr` is built for local use before commit or push, but the same command works in any pipeline: review what a branch adds on top of its target branch, fail the job on blocking issues, and optionally post the report on the pull request.

```sh
npx acr review --range origin/main --format markdown > acr-report.md
```

Requirements:

- **Node.js 20+** and **git**.
- **Full history, or at least the merge base.** `--range <base>` diffs `merge-base(base, HEAD)..HEAD`. A shallow clone fails with `No common ancestor ...` (exit `3`).
- **The base branch must exist as a ref**, for example `origin/main`.
- **An AI provider.** Local Ollama is rarely practical on shared CI runners, so use a hosted preset with its key stored as a secret, or run the offline checks only with `--no-ai`.
- `npx acr` assumes `acr-review` is in your `devDependencies` and installed by `npm ci`. Otherwise run it with `npx --yes -p acr-review acr ...`.

The progress spinner is automatically disabled in CI (the `CI` variable or a non-TTY stderr), so logs stay clean.

## Exit codes

| Code | Meaning | Typical CI handling |
|---|---|---|
| `0` | No issue at or above `failOn`; the review was complete, or `onError: warn` | pass |
| `1` | At least one issue at or above `failOn` (default `critical`) | fail the job |
| `2` | The review was incomplete (provider unreachable, key missing, bad AI response, rate limit) **and** `onError: fail` | fail, or retry |
| `3` | Usage or config error: invalid `.acr.yml`, unknown ref, no merge base, not a git repo | fail. Fix the pipeline. |

Notes:

- `--fail-on` (or `ACR_FAIL_ON`) overrides `failOn` for the CI run, for example `--fail-on warning` for a stricter gate.
- `onError` has no flag or environment variable. It comes from the config files only. With the default `warn`, an incomplete review (for example a missing key on a fork PR, where secrets are not exposed) exits `0` and the report shows a "Review incomplete" warning. To detect this without changing `onError`, use `--format json` and check the `complete` field.

## GitHub Actions

Review every pull request with a hosted free tier, post the report as a PR comment, then fail the job if there are blocking issues:

```yaml
# .github/workflows/acr.yml
name: acr review
on: pull_request

permissions:
  contents: read
  pull-requests: write          # to post the comment

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # --range needs the merge base
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci

      - name: acr review
        id: acr
        env:
          ACR_PROVIDER: groq
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
        run: |
          set +e
          npx acr review --range "origin/${GITHUB_BASE_REF}" --format markdown > acr-report.md
          echo "exit=$?" >> "$GITHUB_OUTPUT"
          cat acr-report.md

      - name: Post report
        if: always()
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh pr comment "${{ github.event.pull_request.number }}" --body-file acr-report.md

      - name: Fail on blocking issues
        if: steps.acr.outputs.exit != '0'
        run: exit ${{ steps.acr.outputs.exit }}
```

Variants:

- **Offline checks only (no key, no provider):** replace the review command with `npx acr review --range "origin/${GITHUB_BASE_REF}" --no-ai --format markdown`. It takes milliseconds and still catches secrets, conflict markers, debug leftovers and large files.
- **Other providers:** set `ACR_PROVIDER` to `gemini`, `openrouter` or `cerebras`, and pass the matching `GEMINI_API_KEY`, `OPENROUTER_API_KEY` or `CEREBRAS_API_KEY` secret. Hosted free tiers may use your code under different data terms. See [PROVIDERS.md](PROVIDERS.md#free-tier-notes-and-caveats).
- **Fork PRs:** GitHub does not expose secrets to workflows triggered by forks. The AI step then falls back to the offline checks and the report says the review is incomplete.
- **Summary instead of a comment:** `cat acr-report.md >> "$GITHUB_STEP_SUMMARY"`.

## GitLab CI

```yaml
# .gitlab-ci.yml
acr:
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: 0                # full history for the merge base
    ACR_PROVIDER: groq          # add GROQ_API_KEY as a masked CI/CD variable
  script:
    - npm ci
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME:refs/remotes/origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - code=0; npx acr review --range "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" --format markdown > acr-report.md || code=$?; cat acr-report.md; exit $code
  artifacts:
    when: always
    paths:
      - acr-report.md
```

For offline checks only, drop `ACR_PROVIDER` and add `--no-ai`. To post the report on the merge request, send `acr-report.md` as a note with the GitLab API or the `glab` CLI.

## Posting the markdown report

`--format markdown` writes a self-contained report to stdout:

- a headline with issue counts, files reviewed, the provider and model (or "checks only"), and the duration
- a `> [!WARNING] Review incomplete` block listing the errors, when the review was partial
- a summary table of critical, warning and suggestion counts per file
- one collapsible `<details>` block per issue (critical issues expanded), with the explanation, the suggestion, an optional `suggestion` code block with the exact fix, and the issue id and rule id

It renders on GitHub, GitLab, Gitea and most chat tools that support Markdown with HTML. Post it however your platform allows, for example:

```sh
gh pr comment <number> --body-file acr-report.md
```

If there is nothing to review, the report is still valid Markdown ("No issues found").

## Machine-readable output

`--format json` prints `{ version: 1, target, complete, issues, errors, stats }`. Use it to build your own annotations or gates:

```sh
npx acr review --range origin/main --format json > acr.json
jq -e '.complete' acr.json > /dev/null || echo "review incomplete"
jq -r '.issues[] | "\(.file):\(.line // 0): \(.severity): \(.title)"' acr.json
```
