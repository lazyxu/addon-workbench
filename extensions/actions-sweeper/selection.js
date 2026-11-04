/** Pure, testable selection rules. Never select anything besides confirmed queued runs. */
export function chooseRuns(items, headSha) {
  const head = String(headSha || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("未能确认当前分支 HEAD");
  const byId = new Map();
  for (const item of items) {
    if (Number.isSafeInteger(item?.id) && item.id > 0) {
      const previous = byId.get(item.id);
      if (previous && (previous.sha !== item.sha || previous.suite !== item.suite ||
        previous.state !== item.state || previous.queued !== item.queued || previous.created !== item.created)) {
        throw new Error(`Run #${item.id} 在不同页面的数据不一致`);
      }
      byId.set(item.id, item);
    }
  }
  const runs = [...byId.values()];
  const older = runs.filter(x => x.sha?.toLowerCase() !== head)
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created) || b.id - a.id);
  const protectedLatestOld = older[0] ?? null;
  const eligible = older.slice(1).filter(x => x.queued === true && /^\d+$/.test(x.suite || ""));
  return {
    total: runs.length,
    currentHead: runs.filter(x => x.sha?.toLowerCase() === head).length,
    older: older.length,
    protectedLatestOld,
    eligible,
    skippedNonQueued: older.slice(1).filter(x => !x.queued).length,
    skippedNoCancelLink: older.slice(1).filter(x => x.queued && !/^\d+$/.test(x.suite || "")).length
  };
}

export function gitHubContext(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || !parts.slice(0, 2).every(x => /^[a-zA-Z0-9_.-]+$/.test(x))) return null;
  const owner = parts[0], repo = parts[1];
  const workflow = parts[2] === "actions" && parts[3] === "workflows" && parts[4] ?
    decodeURIComponent(parts[4]) : "";
  const query = url.searchParams.get("query") || "";
  const branch = query.match(/(?:^|\s)branch:(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  return { owner, repo, workflow, branch: branch ? (branch[1] || branch[2] || branch[3]) : "" };
}

export function normalizeWorkflow(value) {
  const input = String(value || "").trim();
  const file = input.replace(/^\.github\/workflows\//, "");
  if (!/^[\w.-]+\.ya?ml$/i.test(file) || file.includes("..")) {
    throw new Error("请输入工作流文件名，例如 ci.yml（或 .github/workflows/ci.yml）");
  }
  return file;
}

export function normalizeBranch(value) {
  const branch = String(value || "").trim();
  if (!branch || branch.length > 150 || /[\s~^:?*\[\\]/.test(branch) ||
      branch.startsWith("/") || branch.endsWith("/") || branch.includes("..") || branch.includes("@{") ||
      branch.split("/").some(part => !part || part.startsWith("."))) {
    throw new Error("请输入有效的 Git 分支名称，例如 main 或 master");
  }
  return branch;
}
