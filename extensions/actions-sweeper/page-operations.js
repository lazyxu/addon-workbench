/** Same-origin page operation, injected from an MV3 extension into the active GitHub tab. */
export async function pageOperation(input) {
  // Chrome may discard an injected Promise rejection; always return a serializable error.
  try {
  const { op, owner, repo, branch, workflow, page = 1, expectedHead, candidate } = input || {};
  if (location.origin !== "https://github.com") throw new Error("仅支持 github.com");
  if (![owner, repo].every(x => typeof x === "string" && /^[a-zA-Z0-9_.-]+$/.test(x))) {
    throw new Error("仓库标识无效");
  }
  const segments = location.pathname.split("/").filter(Boolean);
  if (segments[0] !== owner || segments[1] !== repo) {
    throw new Error("当前标签页已经切换仓库，停止执行");
  }
  const root = `/${owner}/${repo}`;
  const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rootPattern = escapeRegExp(root);
  const read = async path => {
    if (!path.startsWith(root + "/") && path !== root) throw new Error("拒绝跨仓库请求");
    let response;
    try {
      response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
    } catch (cause) {
      const error = new Error(`GitHub 网络读取失败 (${path}): ${cause?.message || String(cause)}`);
      error.retryable = true;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`GitHub 读取失败：HTTP ${response.status} (${path})`);
      error.httpStatus = response.status;
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
      error.retryable = [429, 500, 502, 503, 504].includes(response.status) ||
        (response.status === 403 &&
         (error.retryAfterMs !== null || response.headers?.get?.("x-ratelimit-remaining") === "0"));
      throw error;
    }
    return response.text();
  };
  const checkBranch = () => {
    if (!branch || typeof branch !== "string" || branch.length > 150 ||
        /[\s~^:?*\[\\]/.test(branch) || branch.includes("..") || branch.includes("@{")) {
      throw new Error("分支名不合法");
    }
  };
  const getHead = async () => {
    checkBranch();
    const feed = await read(`${root}/commits/${encodeURIComponent(branch)}.atom`);
    const first = feed.match(/<entry\b[\s\S]*?<\/entry>/i)?.[0] || "";
    const sha = first.match(/Grit::Commit\/([0-9a-f]{40})/i)?.[1] ||
      first.match(/\/commit\/([0-9a-f]{40})/i)?.[1];
    if (!sha) throw new Error("无法从 Atom Feed 确认当前分支 SHA，拒绝操作");
    return sha.toLowerCase();
  };
  const findRuns = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 12) return null;
    if (Array.isArray(value.workflowRunsRoute?.workflowRuns)) return value.workflowRunsRoute.workflowRuns;
    for (const child of Object.values(value)) {
      const rows = findRuns(child, depth + 1);
      if (rows) return rows;
    }
    return null;
  };
  // GitHub's UI JSON can omit the optional commit link on terminal runs.
  // Only repository-scoped commit URLs and explicit full SHAs are trusted.
  const shaFromLink = (value, rootPattern) => {
    if (typeof value !== "string" || !value) return null;
    let url;
    try { url = new URL(value, location.origin); } catch { return null; }
    if (url.origin !== location.origin) return null;
    return url.pathname.match(new RegExp(`^${rootPattern}/commit/([0-9a-f]{40})/?$`, "i"))?.[1]?.toLowerCase() || null;
  };
  const exactSha = value => typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ?
    value.toLowerCase() : null;
  const runSha = (run, rootPattern) => {
    const values = [
      shaFromLink(run?.description?.linkUrl, rootPattern),
      shaFromLink(run?.headCommit?.url, rootPattern),
      exactSha(run?.headSha),
      exactSha(run?.head_sha),
      exactSha(run?.headCommit?.oid),
      exactSha(run?.headCommit?.sha),
      exactSha(run?.commit?.oid),
      exactSha(run?.commit?.sha),
      exactSha(run?.head_commit?.id)
    ].filter(Boolean);
    // Conflicting metadata must never make a queued run eligible.
    return values.length && values.every(value => value === values[0]) ? values[0] : null;
  };
  const runCreatedAt = run => {
    for (const value of [run?.createdAt?.timestamp, run?.createdAt?.isoDate,
      run?.createdAt?.date, run?.created_at]) {
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) &&
          Number.isFinite(Date.parse(value))) return value;
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        const ms = value < 1e11 ? value * 1000 : value;
        if (ms >= 946684800000 && ms < 4102444800000) return new Date(ms).toISOString();
      }
    }
    return null;
  };
  const parsePage = async pageNumber => {
    checkBranch();
    if (!/^[\w.-]+\.ya?ml$/i.test(workflow || "") || workflow.includes("..")) {
      throw new Error("工作流文件名无效");
    }
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 1000) {
      throw new Error("分页值不合法");
    }
    const qs = new URLSearchParams({ query: `branch:${branch}`, page: String(pageNumber) });
    const html = await read(`${root}/actions/workflows/${encodeURIComponent(workflow)}?${qs}`);
    const doc = new DOMParser().parseFromString(html, "text/html");
    let rows = null;
    for (const script of doc.querySelectorAll('script[type="application/json"]')) {
      try { rows = findRuns(JSON.parse(script.textContent)); } catch { /* not route data */ }
      if (rows) break;
    }
    if (!Array.isArray(rows)) throw new Error(`第 ${pageNumber} 页 GitHub 数据结构已改变，安全停止`);
    const targetRef = `refs/heads/${branch}`;
    const targetPath = `.github/workflows/${workflow}`;
    const runPattern = new RegExp(`^(?:${rootPattern})?/actions/runs/(\\d+)(?:[/?#]|$)`);
    const domIds = new Set();
    for (const link of doc.querySelectorAll('a[href*="/actions/runs/"]')) {
      const href = link.getAttribute("href") || "";
      const id = href.match(runPattern)?.[1];
      if (id) domIds.add(id);
    }
    const jsonIds = new Set(rows.map(run => String(run?.id)));
    if (domIds.size && (domIds.size !== jsonIds.size || [...domIds].some(x => !jsonIds.has(x)))) {
      throw new Error(`第 ${pageNumber} 页 DOM 与 JSON Run 列表不一致，安全停止`);
    }
    // The UI sometimes reports a conclusion (SUCCESS/FAILURE) rather than
    // COMPLETED. Normalize the visible state without treating UNKNOWN as done.
    const normalizeStatus = value => typeof value === "string" ?
      value.replace(/^WORKFLOW_RUN_STATUS_/i, "").trim().replace(/[\s-]+/g, "_").toUpperCase() : "UNKNOWN";
    const terminalStatuses = new Set([
      "COMPLETED", "CANCELLED", "CANCELED", "SUCCESS", "FAILURE",
      "FAILED", "SKIPPED", "NEUTRAL", "TIMED_OUT", "STALE", "ACTION_REQUIRED"
    ]);
    const items = [];
    const statuses = {};
    for (const run of rows) {
      const state = String(run?.state?.status || run?.status || "UNKNOWN");
      const normalizedStatus = normalizeStatus(state);
      statuses[normalizedStatus] = (statuses[normalizedStatus] || 0) + 1;
      if (run?.branch?.name !== targetRef || run?.workflowFilePath !== targetPath) {
        throw new Error(`第 ${pageNumber} 页返回了不匹配的分支或工作流，安全停止`);
      }
      const id = Number(run?.id);
      const sha = runSha(run, rootPattern);
      const suite = String(run?.actions?.cancelUrl || "")
        .match(new RegExp(`^${rootPattern}/suites/(\\d+)/cancel$`))?.[1] || null;
      const created = runCreatedAt(run);
      const terminal = terminalStatuses.has(normalizedStatus);
      const metadataIncomplete = !sha || !created;
      if (!Number.isSafeInteger(id) || id <= 0 || (!terminal && metadataIncomplete)) {
        throw new Error(`第 ${pageNumber} 页 Run 数据不完整：${String(run?.id)}`);
      }
      // GitHub uses WORKFLOW_RUN_TIMING_KIND_IN_PROGRESS for the *timer*
      // even when the run text says "Queued". That field is NOT proof of
      // any job actually starting. Only the user-facing timing text can
      // contradict the queued label; Run/HEAD are rechecked before PUT.
      const timingText = String(run?.timing?.text || "").trim();
      const hasStarted = /\bRUNNING\b|\bSTARTING\b|\bSTARTED\b|IN[\s_-]*PROGRESS/i.test(timingText);
      const queueObserved = normalizedStatus === "QUEUED";
      // A workflow can be QUEUED while some jobs have already started.
      // The original script considered the workflow-level queue status; so
      // this is eligible subject to HEAD and same-page revalidation.
      items.push({
        id, sha: metadataIncomplete ? null : sha, suite, created: metadataIncomplete ? null : created,
        state, conclusion: [run?.state?.conclusion, run?.conclusion,
          run?.state?.result, run?.result].filter(value => typeof value === "string" && value)[0] || null,
        queueObserved, startedEvidence: hasStarted,
        queued: !metadataIncomplete && queueObserved && !hasStarted,
        metadataIncomplete, page: pageNumber
      });
    }
    // The embedded workflow-run JSON is authoritative for each run's state.
    // Do not scan the entire page for generic "Queued"/"Running" strings:
    // hidden navigation, unrelated components, and stale timing labels can
    // otherwise prevent terminal-page detection indefinitely.
    const allRunsTerminal = items.every(item => terminalStatuses.has(normalizeStatus(item.state)));
    const domValidated = domIds.size > 0 && domIds.size === jsonIds.size &&
      [...domIds].every(id => jsonIds.has(id));
    // Some GitHub pages render run links only after hydration: when there are
    // no DOM anchors, rely on the already-validated route JSON for fast stop.
    const terminalPage = rows.length === 25 && allRunsTerminal;
    return { page: pageNumber, total: rows.length, items, statuses,
      terminalPage, lastPage: rows.length < 25, domValidated,
      allRunsTerminal, incompleteTerminalRuns: items.filter(item => item.metadataIncomplete).length };
  };
  if (op === "head") return { head: await getHead() };
  if (op === "default-branch") {
    const html = await read(root);
    const candidates = [
      html.match(/"defaultBranch"\s*:\s*"([^"\\]+)"/)?.[1],
      html.match(/"defaultBranch"\s*:\s*\{\s*"name"\s*:\s*"([^"\\]+)"/)?.[1],
      html.match(/"defaultBranchRef"\s*:\s*\{\s*"name"\s*:\s*"([^"\\]+)"/)?.[1],
      html.match(/<meta\s+name="octolytics-dimension-repository_default_branch"\s+content="([^"]+)"/i)?.[1]
    ];
    return { branch: candidates.find(x => x && !/[\s<>]/.test(x)) || null };
  }
  if (op === "page") return await parsePage(page);
  // Restore the original console-script policy: the workflow-level QUEUED
  // state is the criterion for selecting a cancellation, not whether *all*
  // jobs have remained untouched. This can interrupt already-running jobs.
  // Still revalidate exact HEAD, workflow/branch, Run ID, SHA, suite, page
  // and queued status immediately before any same-origin cancel PUT.
  if (op === "cancel-one") {
    if (!candidate || !Number.isSafeInteger(candidate.id) || candidate.id <= 0 ||
        !/^\d+$/.test(String(candidate.suite || "")) ||
        !/^[0-9a-f]{40}$/i.test(expectedHead || "")) {
      throw new Error("候选任务或 HEAD 信息无效");
    }
    const latest = await getHead();
    if (latest !== String(expectedHead).toLowerCase()) {
      throw new Error("分支 HEAD 已变化，停止取消操作；请重新扫描");
    }
    const snapshot = await parsePage(candidate.page);
    const actual = snapshot.items.find(item => item.id === candidate.id);
    if (!actual) throw new Error(`Run #${candidate.id} 已从原分页移动，请重新扫描`);
    if (actual.sha !== candidate.sha || actual.suite !== candidate.suite || actual.created !== candidate.created ||
        !actual.queued || actual.sha === latest) {
      throw new Error(`Run #${candidate.id} 已不满足未运行旧构建条件，安全停止`);
    }
    const response = await fetch(`${root}/suites/${actual.suite}/cancel`, {
      method: "PUT", credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "github-is-react": "true",
        "github-verified-fetch": "true",
        "x-requested-with": "XMLHttpRequest"
      }, body: null
    });
    const body = await response.text();
    const accepted = response.status === 200 && body.includes("successfully requested");
    return { accepted, status: response.status, detail: body.slice(0, 200),
      authOrRateLimited: [401, 403, 429].includes(response.status) };
  }
  throw new Error("未知操作类型");
  } catch (error) {
    return {
      __actionsSweeperError: true,
      message: String(error?.message || error).slice(0, 400),
      httpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : null,
      retryable: error?.retryable === true,
      retryAfterMs: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : null
    };
  }
}
