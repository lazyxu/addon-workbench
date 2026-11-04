/** Same-origin page operation, injected from an MV3 extension into the active GitHub tab. */
export async function pageOperation(input) {
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
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`GitHub 读取失败：HTTP ${response.status} (${path})`);
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
    const items = [];
    const statuses = {};
    for (const run of rows) {
      const state = String(run?.state?.status || "UNKNOWN");
      statuses[state.replace(/^WORKFLOW_RUN_STATUS_/, "")] =
        (statuses[state.replace(/^WORKFLOW_RUN_STATUS_/, "")] || 0) + 1;
      if (run?.branch?.name !== targetRef || run?.workflowFilePath !== targetPath) {
        throw new Error(`第 ${pageNumber} 页返回了不匹配的分支或工作流，安全停止`);
      }
      const id = Number(run?.id);
      const sha = String(run?.description?.linkUrl || "")
        .match(new RegExp(`^${rootPattern}/commit/([0-9a-f]{40})$`, "i"))?.[1]?.toLowerCase();
      const suite = String(run?.actions?.cancelUrl || "")
        .match(new RegExp(`^${rootPattern}/suites/(\\d+)/cancel$`))?.[1] || null;
      const created = run?.createdAt?.timestamp;
      if (!Number.isSafeInteger(id) || id <= 0 || !sha || !Number.isFinite(Date.parse(created))) {
        throw new Error(`第 ${pageNumber} 页 Run 数据不完整：${String(run?.id)}`);
      }
      const timing = [run?.timing?.text, run?.timing?.kind].filter(Boolean).join(" ");
      const hasStarted = /IN[_\s-]*PROGRESS|RUNNING|STARTING|IN_PROGRESS/i.test(timing);
      items.push({ id, sha, suite, created, state, queued: state === "WORKFLOW_RUN_STATUS_QUEUED" && !hasStarted,
        page: pageNumber });
    }
    const activeRe = /QUEUED|PENDING|WAITING|IN[_\s-]*PROGRESS|RUNNING|STARTING/i;
    const activeInJson = rows.some(run => activeRe.test([
      run?.state?.status, run?.timing?.kind, run?.timing?.text
    ].filter(Boolean).join(" ")));
    const terminalStatuses = new Set([
      "WORKFLOW_RUN_STATUS_COMPLETED",
      "WORKFLOW_RUN_STATUS_CANCELLED",
      "WORKFLOW_RUN_STATUS_CANCELED"
    ]);
    const renderedActive = [...doc.querySelectorAll("span, div, time, p, strong, [aria-label], [title]")]
      .some(node => {
        const val = String(node.textContent || "").trim();
        const label = String(node.getAttribute?.("aria-label") || node.getAttribute?.("title") || "").trim();
        return ((node.childElementCount === 0 && val.length < 40 &&
          /^(Queued|Pending|Waiting|Running|In[\s-]*progress)$/i.test(val)) ||
          /^(Queued|Pending|Waiting|Running|In[\s-]*progress)$/i.test(label));
      });
    const embeddedActive = /"text"\s*:\s*"(?:Queued|Pending|Waiting|Running|In[\s-]*progress)"/i.test(html);
    const terminalPage = rows.length === 25 &&
      rows.every(run => terminalStatuses.has(run?.state?.status)) &&
      !activeInJson && !renderedActive && !embeddedActive && domIds.size === jsonIds.size;
    return { page: pageNumber, total: rows.length, items, statuses,
      terminalPage, lastPage: rows.length < 25, domValidated: domIds.size === jsonIds.size,
      activeInJson, renderedActive, embeddedActive };
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
  if (op === "page") return parsePage(page);
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
}
