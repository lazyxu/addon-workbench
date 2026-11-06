# Actions Sweeper

**Standalone GitHub Actions queue cleaner for Chrome / Edge.** No repository, service, or account is hard-coded.

Open any `github.com/OWNER/REPO` page and click the browser toolbar button. The workflow is prefilled with `ci.yml` (or inferred from the current workflow page). The branch is initially `master` and automatically updated to the repository default branch (`main`, `master`, etc.) when detectable. Verify the fallback if detection is unavailable. Click **Scan** to preview candidates. Scanning is read-only. Select the old queued runs and click **Cancel selected** once to start verified cancellation immediately, without a Dry Run toggle or secondary confirmation. Every request is still validated against branch HEAD, run state, and the logged-in GitHub run details.

## Safety rules

- Only queued runs from the exact workflow/branch are eligible; runs that have started, completed or been cancelled are excluded. If GitHub omits optional SHA/time fields on terminal runs, these are counted as scanned but excluded from older-run statistics and cancellation selection; incomplete queued runs still stop scanning. The popup reports how many terminal records were skipped.
- Current HEAD's runs are never selected; the newest older run in the scanned set is protected.
- Fast mode stops after **N consecutive fully terminal pages** (N defaults to **2**, configurable 1–40), with a GitHub-imposed per-query cap of **1,000 runs / 40 pages**. Full mode scans until the last page or its **maximum scanned pages** limit (default **20**, configurable 1–40). Switching modes retains separate input values. Fast stopping or reaching a cap does not prove complete coverage. On page 40, the scan completes gracefully without requesting inaccessible page 41; already scanned candidates remain visible, with a warning that older records were not scanned. Narrow the query by creation date for older history. Network and parsing errors surface actionable details; incomplete scans keep read-only previews but disable cancellation. Transient 429/5xx failures are retried up to twice with bounded backoff.
- Branch/head SHA, page-data consistency, run ID, suite, workflow and queued status are checked again before every cancel request. If a run moves pages or changes state, processing stops.
- At most 250 requests per batch, 600 ms pacing, and early stop on authorization/rate-limit failures. A short operation history is stored only in browser local storage.
- No PR runs from other branches, running jobs, or completed jobs are cancelled; no branches are deleted.
- No personal access token, remote extension code, or third-party telemetry is used.

## Live scan counters

After each fully validated page, the popup updates the cumulative scanned Run count, old Run count, GitHub-queued status count, and estimated cancellable candidate count. These are **scanned-page** counts, not all workflow history. GitHub can label a workflow run as queued while some jobs have already started; the queue count is deliberately separate from cancellation eligibility, which also checks page timing evidence, full metadata, branch/HEAD, and a same-origin per-run recheck. The candidates are provisional until the scan completes. The Stop button is available during scanning and leaves already validated pages in a read-only preview. The fast terminal-page stopping rule uses validated route JSON even when GitHub has not pre-rendered run links in the HTML; unexpected status values never count as terminal.

## Limitations

A workflow **Run** can be labeled `queued` while one or more **Jobs** are already running or completed. For an actual cancellation, the extension rechecks the workflow list and then loads `/OWNER/REPO/actions/runs/RUN_ID` from **github.com** using `credentials: "same-origin"`. No requests to the GitHub REST API are made by the extension. It accepts a cancellation only if the run detail page exposes one complete, consistent, unambiguously queued Job list (at most 100 entries), and the branch HEAD, run SHA, suite and original queue state still match. If GitHub's undocumented page structure omits or changes this data, the extension refuses the cancellation rather than guessing; in that case inspect the page schema before adapting the parser. Dry Run only tests the initial page-derived candidates, not final Job verification. A Job can still start between the final check and the cancellation request.

GitHub's internal page JSON and same-origin `/suites/{id}/cancel` endpoint are not stable public APIs. GitHub changes can break the extension; in that situation it refuses the operation. There is an unavoidable race between last-minute status validation and an HTTP cancellation request. Keep the popup open until a batch finishes. Verify final run states in GitHub Actions afterwards.
