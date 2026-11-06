
(async () => {
  "use strict";

  const root = "/lazyxu/xdrive";
  const workflow = "ci.yml";
  const branch = "master";
  const maxPages = 40;
  const maxCancel = 250;
  const intervalMs = 600;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const validSHA = s => typeof s === "string" &&
    /^[a-f0-9]{40}$/i.test(s);

  const normalize = s => String(s || "UNKNOWN")
    .replace(/^WORKFLOW_RUN_(STATUS|CONCLUSION)_/i, "")
    .replace(/[\s-]+/g, "_")
    .toUpperCase();

  const terminal = new Set([
    "COMPLETED", "CANCELLED", "CANCELED",
    "SUCCESS", "FAILURE", "SKIPPED",
    "TIMED_OUT", "NEUTRAL"
  ]);

  if (location.origin !== "https://github.com" ||
      !location.pathname.startsWith(root + "/")) {
    throw new Error("请在 lazyxu/xdrive GitHub 页面执行");
  }

  async function read(path) {
    if (!path.startsWith(root + "/")) {
      throw new Error("拒绝跨仓库请求");
    }

    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store"
    });

    const url = new URL(response.url);
    if (url.origin !== location.origin ||
        !url.pathname.startsWith(root + "/")) {
      throw new Error("GitHub 请求发生异常重定向");
    }

    if (!response.ok) {
      throw new Error(`GET ${path}: HTTP ${response.status}`);
    }

    return response.text();
  }

  async function currentHead() {
    const atom = await read(`${root}/commits/${branch}.atom`);
    const entry = atom.match(
      /<entry\b[\s\S]*?<\/entry>/i
    )?.[0] || "";

    const sha = (
      entry.match(/Grit::Commit\/([a-f0-9]{40})/i)?.[1] ||
      entry.match(/\/commit\/([a-f0-9]{40})/i)?.[1] ||
      ""
    ).toLowerCase();

    if (!validSHA(sha)) throw new Error("无法确认 master HEAD");
    return sha;
  }

  function findRuns(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 15) {
      return null;
    }

    if (Array.isArray(obj.workflowRunsRoute?.workflowRuns)) {
      return obj.workflowRunsRoute.workflowRuns;
    }

    for (const child of Object.values(obj)) {
      const found = findRuns(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function extractSHA(run) {
    const values = [];
    const link = run.description?.linkUrl;

    if (typeof link === "string") {
      try {
        const url = new URL(link, location.origin);
        if (url.origin === location.origin) {
          const sha = url.pathname.match(
            /^\/lazyxu\/xdrive\/commit\/([a-f0-9]{40})\/?$/i
          )?.[1];
          if (sha) values.push(sha.toLowerCase());
        }
      } catch {}
    }

    for (const sha of [
      run.headSha, run.head_sha,
      run.headCommit?.oid, run.headCommit?.sha
    ]) {
      if (validSHA(sha)) values.push(sha.toLowerCase());
    }

    return values.length &&
      values.every(x => x === values[0])
      ? values[0] : null;
  }

  async function readPage(page) {
    const query = new URLSearchParams({
      query: `branch:${branch}`,
      page: String(page)
    });

    const html = await read(
      `${root}/actions/workflows/${workflow}?${query}`
    );

    const doc = new DOMParser().parseFromString(
      html, "text/html"
    );

    let rows = null;
    for (const script of doc.querySelectorAll(
      'script[type="application/json"]'
    )) {
      try {
        rows = findRuns(JSON.parse(script.textContent));
      } catch {}
      if (rows) break;
    }

    if (!Array.isArray(rows)) {
      throw new Error(`第 ${page} 页缺少 GitHub Run JSON`);
    }

    const items = rows.map(run => {
      if (run.branch?.name !== "refs/heads/master" ||
          run.workflowFilePath !== ".github/workflows/ci.yml") {
        throw new Error(`第 ${page} 页工作流或分支不匹配`);
      }

      const id = Number(run.id);
      const state = normalize(run.state?.status || run.status);
      const conclusion = normalize(
        run.state?.conclusion || run.conclusion ||
        run.state?.result || run.result
      );
      const created = run.createdAt?.timestamp ||
        run.created_at || null;

      const suite = String(run.actions?.cancelUrl || "")
        .match(/^\/lazyxu\/xdrive\/suites\/(\d+)\/cancel$/)?.[1]
        || null;

      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error("非法 Run ID");
      }

      return {
        id, state, conclusion, created, suite,
        sha: extractSHA(run),
        queued: state === "QUEUED",
        page
      };
    });

    if (new Set(items.map(x => x.id)).size !== items.length) {
      throw new Error(`第 ${page} 页出现重复 Run`);
    }

    return items;
  }

  console.log("========== 开始扫描旧 master CI ==========");

  const head = await currentHead();
  const all = new Map();
  const fingerprints = new Set();
  let terminalStreak = 0;

  console.log("当前 master HEAD:", head);

  for (let page = 1; page <= maxPages; page++) {
    const items = await readPage(page);
    const fingerprint = items.map(x => x.id).join(",");

    if (items.length && fingerprints.has(fingerprint)) {
      throw new Error(`第 ${page} 页重复分页，安全停止`);
    }
    fingerprints.add(fingerprint);

    for (const item of items) {
      if (all.has(item.id)) {
        const prev = all.get(item.id);
        if (prev.sha !== item.sha ||
            prev.state !== item.state ||
            prev.suite !== item.suite) {
          throw new Error(`Run ${item.id} 跨页数据冲突`);
        }
      }
      all.set(item.id, item);
    }

    const isTerminalPage = items.length === 25 &&
      items.every(x => terminal.has(x.state));

    terminalStreak = isTerminalPage
      ? terminalStreak + 1 : 0;

    console.log(
      `第 ${page} 页：本页 ${items.length}，` +
      `累计 ${all.size}，` +
      `Queued ${[...all.values()].filter(x => x.queued).length}，` +
      `连续终态 ${terminalStreak}/2`
    );

    if (items.length < 25 || terminalStreak >= 2) break;

    if (page === maxPages) {
      console.warn("达到 1000 条查询上限，更早记录未覆盖");
      break;
    }
    await sleep(200);
  }

  const runs = [...all.values()];
  const old = runs.filter(x =>
    x.sha && x.created && x.sha !== head
  ).sort((a, b) =>
    Date.parse(b.created) - Date.parse(a.created) ||
    b.id - a.id
  );

  const protectedOld = old[0] || null;

  // 恢复原始规则：以顶层 Workflow QUEUED 为准。
  const candidates = old.slice(1).filter(x => x.queued);

  if (candidates.some(x =>
    !x.suite || !validSHA(x.sha) ||
    !Number.isFinite(Date.parse(x.created))
  )) {
    throw new Error("候选 Run 缺少关键字段，安全停止");
  }

  const selected = candidates.slice(0, maxCancel);

  console.log("========== 扫描结果 ==========");
  console.table({
    scanned: runs.length,
    queued: runs.filter(x => x.queued).length,
    oldRuns: old.length,
    protectedOld: protectedOld?.id || null,
    toCancel: selected.length
  });

  if (!selected.length) {
    console.log("没有符合条件的旧 Queued CI");
    return;
  }

  // 不弹二次确认，直接处理。
  let accepted = 0;
  let failed = 0;
  let processed = 0;
  const acceptedRuns = [];

  console.log("========== 开始取消 ==========");

  for (const item of selected) {
    // 每次取消前重新确认当前 HEAD。
    if (await currentHead() !== head) {
      console.warn("master HEAD 已变化，停止");
      break;
    }

    // 重新确认原分页 Run 未移动、未变为其他状态。
    const fresh = (await readPage(item.page))
      .find(x => x.id === item.id);

    if (!fresh || fresh.sha !== item.sha ||
        fresh.suite !== item.suite ||
        fresh.created !== item.created ||
        !fresh.queued ||
        fresh.id === protectedOld?.id ||
        fresh.sha === head) {
      console.warn(`Run ${item.id} 状态已变化，停止`);
      break;
    }

    const path = `${root}/suites/${fresh.suite}/cancel`;
    let response, body;

    try {
      response = await fetch(path, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "github-is-react": "true",
          "github-verified-fetch": "true",
          "x-requested-with": "XMLHttpRequest"
        },
        body: null
      });
      body = await response.text();
    } catch (e) {
      console.error("请求异常，停止:", e);
      failed++;
      break;
    }

    processed++;

    if (response.status === 200 &&
        body.includes("successfully requested")) {
      accepted++;
      acceptedRuns.push(item);
    } else {
      failed++;
      console.warn(
        `Run ${item.id} HTTP ${response.status}`,
        body.slice(0, 200)
      );
      if ([401, 403, 429].includes(response.status)) break;
    }

    console.log(
      `取消进度 ${processed}/${selected.length} | ` +
      `GitHub 已接受 ${accepted} | 失败 ${failed}`
    );

    await sleep(intervalMs);
  }

  console.log("========== 开始确认取消终态 ==========");

  const pending = new Map(acceptedRuns.map(x => [x.id, x]));
  const confirmed = new Set();
  const otherFinished = new Set();

  for (let round = 1; round <= 5 && pending.size; round++) {
    await sleep(4000);

    const pages = new Set();
    for (const item of pending.values()) {
      pages.add(item.page);
      if (item.page > 1) pages.add(item.page - 1);
      if (item.page < maxPages) pages.add(item.page + 1);
    }

    const latest = new Map();

    for (const page of [...pages].sort((a, b) => a - b)) {
      try {
        const items = await readPage(page);
        for (const x of items) latest.set(x.id, x);
      } catch (e) {
        console.warn(`复查第 ${page} 页失败：`, e.message);
      }
    }

    for (const [id] of pending) {
      const current = latest.get(id);
      if (!current) continue;

      const canceled =
        ["CANCELED", "CANCELLED"].includes(current.state) ||
        ["CANCELED", "CANCELLED"].includes(current.conclusion);

      if (canceled) {
        confirmed.add(id);
        pending.delete(id);
      } else if (
        terminal.has(current.state) &&
        current.conclusion !== "UNKNOWN" &&
        current.conclusion !== "NULL"
      ) {
        otherFinished.add(id);
        pending.delete(id);
      }
    }

    console.log(
      `终态复查 ${round}/5 | ` +
      `确认取消 ${confirmed.size} | ` +
      `其他终态 ${otherFinished.size} | ` +
      `尚未确认 ${pending.size}`
    );
  }

  const result = {
    selected: selected.length,
    requestsProcessed: processed,
    requestAccepted: accepted,
    requestFailed: failed,
    confirmedCancelled: confirmed.size,
    finishedOther: otherFinished.size,
    unconfirmed: pending.size,
    confirmedIds: [...confirmed],
    unconfirmedIds: [...pending.keys()]
  };

  console.log("========== 最终结果 ==========");
  console.table({
    selected: result.selected,
    requestsProcessed: result.requestsProcessed,
    requestAccepted: result.requestAccepted,
    requestFailed: result.requestFailed,
    confirmedCancelled: result.confirmedCancelled,
    finishedOther: result.finishedOther,
    unconfirmed: result.unconfirmed
  });

  window.xdriveCancelResult = result;

  if (pending.size) {
    console.warn(
      "部分请求已被接受，但尚未确认最终 Cancelled；" +
      "不能将这些记录算作取消成功。"
    );
  }

  return result;
})();