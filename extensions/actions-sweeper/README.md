# Actions Sweeper

**Standalone GitHub Actions queue cleaner for Chrome / Edge.** No repository, service, or account is hard-coded.

Open any `github.com/OWNER/REPO` page and click the browser toolbar button. Supply a workflow file (`ci.yml`, `build.yaml`, etc.) and branch (`main`, `master`, or another). Both can be inferred when a workflow page is open. Click **Scan** to preview candidates. **Dry Run** starts enabled; to actually cancel, uncheck it, select runs, and enter the repository name to confirm.

## Safety rules

- Only queued runs from the exact workflow/branch are eligible; runs that have started, completed or been cancelled are excluded.
- Current HEAD's runs are never selected; the newest older run in the scanned set is protected.
- Fast mode stops after **two consecutive fully terminal pages** and warns that older queued jobs might remain. Full mode stops at the last page or a configurable limit (default 20; maximum 100). Reaching the limit is not proof of completeness.
- Branch/head SHA, page-data consistency, run ID, suite, workflow and queued status are checked again before every cancel request. If a run moves pages or changes state, processing stops.
- At most 250 requests per batch, 600 ms pacing, and early stop on authorization/rate-limit failures. A short operation history is stored only in browser local storage.
- No PR runs from other branches, running jobs, or completed jobs are cancelled; no branches are deleted.
- No personal access token, remote extension code, or third-party telemetry is used.

## Limitations

GitHub's internal page JSON and same-origin `/suites/{id}/cancel` endpoint are not stable public APIs. GitHub changes can break the extension; in that situation it refuses the operation. There is an unavoidable race between last-minute status validation and an HTTP cancellation request. Keep the popup open until a batch finishes. Verify final run states in GitHub Actions afterwards.
