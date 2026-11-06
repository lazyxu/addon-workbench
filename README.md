# AddonWorkbench

A monorepo for small, independent productivity add-ons. Each add-on has its own directory, version and installable package.

## Extensions

| Extension | Purpose | Status |
| --- | --- | --- |
| [Actions Sweeper](extensions/actions-sweeper/README.md) | Review and safely cancel stale **queued** GitHub Actions workflow runs on the current repository | Chrome Manifest V3 / beta (v0.1.8) |

## Install (Chrome / Edge)

1. Open the [Package extensions workflow](actions/workflows/package.yml), select a successful **master** run, and download the `chrome-extensions-...` artifact.
2. Extract the downloaded artifact **once**. It contains one directly loadable folder per extension; for Actions Sweeper, use the `actions-sweeper` folder containing `manifest.json`.
3. In `chrome://extensions` or `edge://extensions`, enable **Developer mode** and select **Load unpacked**.
4. Choose the `actions-sweeper` folder, pin **Actions Sweeper** to the toolbar, and open a GitHub repository.

There is no second, nested extension ZIP to extract. For development, you can load `extensions/actions-sweeper` directly without building.

## Development

Requirements: Node.js 22+ and the `zip` program.

```sh
npm test
npm run package
```

`npm run package` discovers all `extensions/*/manifest.json` folders, validates referenced assets and creates independently installable ZIPs under `dist/`. No third-party runtime dependencies or build secrets are required.

## CI

`.github/workflows/package.yml` runs tests and packages **every extension** for pull requests, manual dispatches, and each push to `master`. CI verifies the installable ZIPs in `dist/`, then uploads the extension directories from `extensions/` as the downloadable artifact. GitHub wraps the artifact in a ZIP, so extracting it once exposes the extension folders directly. Artifact names include the commit SHA; artifacts are kept for 30 days. CI artifacts are **not** a Chrome Web Store publication or GitHub Release.

## Security boundaries

Actions Sweeper runs only on user action on the active GitHub repository and requests just `activeTab`, `scripting`, and `storage`. It uses the logged-in GitHub session, not a personal access token. GitHub's page JSON and same-origin `/suites/{id}/cancel` URL are **undocumented interfaces** and can change. The tool fails closed when validation fails. Current HEAD and one recent old workflow run are protected; only still-queued runs are cancellable after selection and manual confirmation. No automatic or scheduled cancellation happens.

Keep the popup open for a cancellation batch; a request already sent could complete after the popup closes. GitHub accepting a request is not the same as the workflow reaching `Cancelled`.
