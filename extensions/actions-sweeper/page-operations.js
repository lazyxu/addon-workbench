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
      // contradict the queued label; same-origin job verification occurs
      // immediately before any cancellation request.
      const timingText = String(run?.timing?.text || "").trim();
      const hasStarted = /\bRUNNING\b|\bSTARTING\b|\bSTARTED\b|IN[\s_-]*PROGRESS/i.test(timingText);
      const queueObserved = normalizedStatus === "QUEUED";
      // Queue is a provisional page-level candidate only. A real cancel
      // re-reads the run and checks every job's status, failing closed.
      items.push({
        id, sha: metadataIncomplete ? null : sha, suite, created: metadataIncomplete ? null : created,
        state, queueObserved, startedEvidence: hasStarted,
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
  // Only GitHub's logged-in, same-origin HTML pages are used. Never call
  // a cross-origin REST API: browser login does not grant API authorization.
  // Job verification is deliberately fail-closed if the GitHub UI changes.
  const verifyNeverStarted = async actual => {
    const html = await read(root + "/actions/runs/" + actual.id);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const parsed = [];
    for (const script of doc.querySelectorAll('script[type="application/json"]')) {
      try { parsed.push(JSON.parse(script.textContent)); } catch { /* unrelated JSON */ }
    }
    if (!parsed.length) {
      throw new Error("Run #" + actual.id + " 缺少 GitHub 页面 JSON，拒绝取消");
    }
    const normalized = value => typeof value === "string" ?
      value.replace(/^(?:(?:WORKFLOW_(?:RUN|JOB)_|CHECK_RUN_|JOB_)?STATUS_)/i, "")
        .trim().replace(/[\s-]+/g, "_").toUpperCase() : "UNKNOWN";
    const jobState = job => [job?.status, job?.state?.status,
      job?.checkRun?.status, job?.check_run?.status, job?.jobStatus,
      job?.currentStatus].find(v => typeof v === "string" && v.trim()) || null;
    const jobConclusion = job => job?.conclusion ?? job?.state?.conclusion ??
      job?.checkRun?.conclusion ?? job?.check_run?.conclusion;
    const jobKey = job => job?.id ?? job?.databaseId ?? job?.checkRun?.id ??
      job?.name ?? job?.displayName;
    const hasStarted = job => {
      const state = normalized(jobState(job));
      const conclusion = jobConclusion(job);
      return state !== "QUEUED" || (conclusion != null && conclusion !== "") ||
        (Array.isArray(job?.steps) && job.steps.some(step =>
          ["IN_PROGRESS", "COMPLETED", "RUNNING"].includes(normalized(
            step?.status ?? step?.state?.status))));
    };

    const observations = [];
    const findCount = (container, parent) => {
      for (const value of [
        container?.totalCount, container?.total_count, container?.jobsCount,
        container?.jobCount, container?.totalJobs, container?.count,
        parent?.jobsCount, parent?.jobCount, parent?.totalJobs,
        parent?.totalJobCount, parent?.total_job_count
      ]) {
        if (Number.isSafeInteger(value) && value >= 0) return value;
      }
      return null;
    };
    const listFrom = value => Array.isArray(value) ? value :
      Array.isArray(value?.nodes) ? value.nodes :
      Array.isArray(value?.items) ? value.items :
      Array.isArray(value?.edges) ? value.edges.map(edge => edge?.node) : null;
    const visit = (node, path = "$", depth = 0) => {
      if (!node || typeof node !== "object" || depth > 20) return;
      if (Array.isArray(node)) {
        for (const item of node.slice(0, 150)) visit(item, path + "[]", depth + 1);
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        const childPath = path + "." + key;
        if (/^(?:jobs|workflowJobs|checkRuns|workflowRunJobs|jobList|jobItems)$/i.test(key)) {
          const jobs = listFrom(value);
          if (jobs) {
            const count = findCount(value, node);
            const hasMore = value?.pageInfo?.hasNextPage === true ||
              value?.pagination?.hasNextPage === true ||
              value?.hasMore === true || value?.hasNextPage === true;
            const endOfPages = value?.pageInfo?.hasNextPage === false ||
              value?.pagination?.hasNextPage === false ||
              value?.hasMore === false || value?.hasNextPage === false;
            observations.push({
              path: childPath, jobs, count, hasMore, endOfPages
            });
          }
        }
        visit(value, childPath, depth + 1);
      }
    };
    parsed.forEach(tree => visit(tree));

    // Any started Job shown in the run detail page is enough to refuse,
    // even when the list is partial. Never trust a smaller queued subset.
    const allObserved = observations.flatMap(o => o.jobs);
    const started = allObserved.find(job => job && typeof job === "object" &&
      jobState(job) && hasStarted(job));
    if (started) {
      throw new Error("Run #" + actual.id +
        " 的 Job 已开始/完成或状态不确定（" +
        String(jobKey(started) || "unknown") + "），拒绝取消");
    }
    const valid = observations.filter(o =>
      o.jobs.length > 0 && o.jobs.length <= 100 &&
      o.jobs.every(job => job && typeof job === "object" &&
        jobKey(job) != null && jobState(job) && !hasStarted(job)));
    const domIds = new Set();
    const jobPath = new RegExp("^" + rootPattern +
      "/actions/runs/" + actual.id + "/job/(\\d+)(?:[/?#]|$)");
    for (const link of doc.querySelectorAll('a[href*="/job/"]')) {
      const href = link.getAttribute("href") || "";
      const path = href.startsWith("https://github.com") ?
        href.slice(location.origin.length) : href;
      const id = path.match(jobPath)?.[1];
      if (id) domIds.add(id);
    }
    // A list is complete only when an explicit count/end marker, or an exact
    // DOM-to-JSON job-ID match, demonstrates coverage. Missing totalCount
    // alone must not reject a complete route list.
    const complete = valid.filter(o => !o.hasMore && (
      (o.count !== null && o.count === o.jobs.length) ||
      (o.endOfPages && (o.count === null || o.count === o.jobs.length)) ||
      (domIds.size > 0 && domIds.size === o.jobs.length &&
        o.jobs.every(job => domIds.has(String(jobKey(job)))))
    ));
    if (!complete.length) {
      const hints = observations.slice(0, 3).map(o =>
        o.path + " " + o.jobs.length + "/" + (o.count ?? "?") +
        (o.hasMore ? " more" : "")
      ).join("; ");
      throw new Error("Run #" + actual.id +
        " 的 Job 列表缺少完整性证据，拒绝取消。" +
        (hints ? " 已发现: " + hints : " 页面未返回 Job 列表"));
    }
    const signatures = complete.map(o => JSON.stringify(o.jobs.map(job => [
      String(jobKey(job)), normalized(jobState(job)),
      String(jobConclusion(job) || "")
    ]).sort((a, b) => a[0].localeCompare(b[0]))));
    if (new Set(signatures).size !== 1) {
      throw new Error("Run #" + actual.id + " 存在互相冲突的完整 Job 列表，拒绝取消");
    }
    // A partial list must not introduce unknown/unverified extra jobs.
    const allowedIds = new Set(complete[0].jobs.map(job => String(jobKey(job))));
    if (allObserved.some(job => !job || typeof job !== "object" ||
        jobKey(job) == null || !allowedIds.has(String(jobKey(job))) ||
        !jobState(job))) {
      throw new Error("Run #" + actual.id + " 的 Job 列表有未核验条目，拒绝取消");
    }

  };
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
    await verifyNeverStarted(actual);
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
