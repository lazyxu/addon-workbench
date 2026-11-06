# Actions Sweeper

**Standalone GitHub Actions queue cleaner for Chrome / Edge.** No repository, service, or account is hard-coded.

Open any `github.com/OWNER/REPO` page and click the browser toolbar button. The workflow is prefilled with `ci.yml` (or inferred from the current workflow page). The branch is initially `master` and automatically updated to the repository default branch (`main`, `master`, etc.) when detectable. Verify the fallback if detection is unavailable. Click **Scan and cancel old CI** once. The extension first scans the workflow and updates live counts; after a valid scan it **automatically cancels up to 250 eligible old top-level Queued Runs**, just like the user-verified Console script (retained unchanged at `examples/xdrive-queued-ci-cleanup.console.js`). There is no Dry Run, extra Cancel button, or second confirmation. A top-level Queued workflow can already contain running Jobs; they may be interrupted. Before each cancellation the extension rechecks branch HEAD, the selected page, Run status, SHA and suite. It polls the logged-in workflow list for confirmed cancellation outcomes.

## Safety rules

- **Original workflow-level queue policy restored:** only workflow Runs whose *top-level* status is `QUEUED` for the exact workflow/branch are candidates. A queued workflow may have running/completed Jobs. Cancelling its suite can interrupt these Jobs. Fully terminal or non-queued Runs are excluded. Completed Runs with optional missing SHA/time are counted but excluded from candidate selection; incomplete active Runs stop scanning.
- Current HEAD's runs are never selected; the newest older run in the scanned set is protected.
- Fast mode stops after **N consecutive fully terminal pages** (N defaults to **2**, configurable 1–40), with a GitHub-imposed per-query cap of **1,000 runs / 40 pages**. Full mode scans until the last page or its **maximum scanned pages** limit (default **20**, configurable 1–40). Switching modes retains separate input values. Fast stopping or reaching a cap does not prove complete coverage. On page 40, the scan completes gracefully without requesting inaccessible page 41; already scanned candidates remain visible, with a warning that older records were not scanned. Narrow the query by creation date for older history. Network and parsing errors surface actionable details; incomplete scans keep read-only previews but disable cancellation. Transient 429/5xx failures are retried up to twice with bounded backoff.
- Branch/head SHA, page-data consistency, run ID, suite, workflow and queued status are checked again before every cancel request. If a run moves pages or changes state, processing stops.
- At most 250 cancellation requests per batch, 600 ms pacing, and early stop on authorization/rate-limit failures. Scans never send cancel PUTs until the scan completes and its results pass validation. Once they do, cancelling begins automatically. A short operation history is stored only in browser local storage.
- Runs for other branches/workflows or already non-queued workflow Runs are excluded; no branches are deleted. A top-level Queued workflow **may contain started Jobs**, which can be interrupted.
- No personal access token, remote extension code, or third-party telemetry is used.

## Live scan counters

After each validated page, the popup updates cumulative scanned Runs, confirmed old Runs, top-level Queued Runs, and preliminary old Queued candidates. These counts cover only scanned pages, not all history. The original workflow-level Queued policy is used; the candidate total is not a count of Jobs that have never started. The Stop button works during scanning and cancellation. Fast scanning uses validated route JSON even when GitHub omits pre-rendered run links.

## Cancellation and verification

- Clicking **Scan and cancel old CI** begins the read-only scan, followed automatically by cancellation on successful scan completion; no extra confirmation or selection is required. If scanning is stopped or incomplete, no cancel request is sent.
- Cancellation selection matches the exact user-provided, verified Console script (saved at `examples/xdrive-queued-ci-cleanup.console.js`): top-level workflow `QUEUED` status, exact workflow/branch, current HEAD protection, and protection of the most recent older Run. The extension rechecks the selected Run and HEAD immediately before each same-origin `PUT /suites/SUITE_ID/cancel`.
- **Important:** a workflow can be top-level `QUEUED` even when some Jobs have already run. Cancellation may interrupt these Jobs. If only never-started Jobs should be cancelled, do not use this workflow-level policy.
- After each accepted cancellation request, a read-only poll of same-origin workflow-list pages checks for an explicit `CANCELLED`/`CANCELED` Run status or conclusion. `COMPLETED` without a cancellation conclusion is **not** evidence of a successful cancellation. The UI separately reports accepted requests, confirmed cancelled, other finished outcomes, and unconfirmed outcomes. The poll is bounded and page movements or missing data can leave outcomes unconfirmed.

## Limitations

Only `github.com` authenticated same-origin endpoints are used. The extension does **not** call `api.github.com`, external analytics, or other services. The same-origin workflow-list JSON and `/suites/{id}/cancel` endpoint are undocumented GitHub interfaces and can change. There is a race between a queued state check and the actual cancellation; GitHub may start a Job during this window. Keep the popup open until the batch finishes. HTTP success or the phrase `successfully requested` indicates acceptance, **not** guaranteed cancellation. Check GitHub Actions for final terminal results when automatic verification cannot confirm them.

## Verified reference

`examples/xdrive-queued-ci-cleanup.console.js` is preserved verbatim from the user-verified script. It is **not imported or executed automatically by the extension**, and is hard-coded to `lazyxu/xdrive`. Pasting that example into GitHub's Console immediately scans and cancels eligible runs; treat it as a destructive, manual reference. The extension shares the core selection and cancellation semantics but supports other repositories/workflows from the popup.
