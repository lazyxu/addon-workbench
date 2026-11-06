import { chooseRuns, gitHubContext, normalizeWorkflow, normalizeBranch } from "./selection.js";
import { pageOperation } from "./page-operations.js";
import { verifyCancellationResults } from "./verification.js";
import { DEFAULT_FAST_TERMINAL_PAGES, DEFAULT_FULL_MAX_PAGES, scanLimitForMode, scanWorkflowPages } from "./scan-policy.js";

(function initializePopup() {
  const $ = id => document.getElementById(id);
  const ui = Object.fromEntries([
    "repo", "unsupported", "tool", "workflow", "branch", "mode", "scanLimit", "limitLabel", "limitHint", "scan", "progress",
    "results", "statRuns", "statOld", "statQueued", "protectedInfo", "coverageInfo",
    "candidateList", "stop",
    "liveScan", "livePages", "liveRuns", "liveOld", "liveQueued", "liveEligible",
    "showHistory", "historyPanel"
  ].map(id => [id, $(id)]));
  let context = null;
  let tabId = null;
  let snapshot = null;
  let busy = false;
  let stopRequested = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const MAX_BATCH = 250;
  const savedLimits = { fast: DEFAULT_FAST_TERMINAL_PAGES, full: DEFAULT_FULL_MAX_PAGES };
  let previousMode = "fast";
  let branchEdited = false;

  function updateModeUI() {
    const mode = ui.mode.value;
    savedLimits[previousMode] = ui.scanLimit.value;
    ui.scanLimit.value = savedLimits[mode];
    ui.limitLabel.textContent = mode === "fast" ? "连续终态页数 N" : "最多扫描页数";
    ui.limitHint.textContent = mode === "fast" ?
      "快速扫描：连续 N 页全部终态即停止，默认 N=2；受 GitHub 限制，一次查询最多 40 页。" :
      "完整扫描：扫描到末页或设置上限，默认最多 20 页；单次查询最多 40 页，达到上限不代表扫完。";
    previousMode = mode;
    resetResults();
  }

  function status(message, error = false) {
    ui.progress.textContent = message;
    ui.progress.classList.toggle("error", error);
  }
  function errorText(error) { return error?.message || String(error); }
  function switchBusy(next) {
    busy = next;
    ui.scan.disabled = next;
    ui.workflow.disabled = next;
    ui.branch.disabled = next;
    ui.mode.disabled = next;
    ui.scanLimit.disabled = next;
    ui.stop.hidden = !next;
    if (next) ui.stop.textContent = snapshot ? "停止后续取消请求" : "停止扫描";
  }
  function resetResults() {
    if (busy) return;
    snapshot = null;
    ui.liveScan.hidden = true;
    ui.results.hidden = true;
    ui.candidateList.replaceChildren();
  }
  function getSettings() {
    const workflow = normalizeWorkflow(ui.workflow.value);
    const branch = normalizeBranch(ui.branch.value);
    const limit = scanLimitForMode(ui.mode.value, ui.scanLimit.value);
    return { ...context, workflow, branch, ...limit, mode: ui.mode.value };
  }
  async function requestPage(details) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active || active.id !== tabId) throw new Error("GitHub 标签页已切换，请重新打开插件");
    const nextContext = gitHubContext(active.url);
    if (!nextContext || nextContext.owner !== context.owner || nextContext.repo !== context.repo) {
      throw new Error("当前 GitHub 仓库已变化，安全停止");
    }
    let injection;
    try {
      [injection] = await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN", func: pageOperation,
        args: [details]
      });
    } catch (error) {
      throw new Error(`无法向 GitHub 标签页注入脚本：${errorText(error)}`);
    }
    const result = injection?.result;
    if (result?.__actionsSweeperError) {
      const error = new Error(result.message);
      error.httpStatus = result.httpStatus;
      error.retryable = result.retryable;
      error.retryAfterMs = result.retryAfterMs;
      throw error;
    }
    if (!result || typeof result !== "object") {
      const label = details.op === "page" ? `第 ${details.page} 页` : details.op;
      throw new Error(`${label}：GitHub 页面脚本没有返回可用数据，请检查页面控制台或刷新标签页`);
    }
    return result;
  }
  // Match the user-verified Console cleaner: after scanning, automatically
  // cancel the first MAX_BATCH old top-level QUEUED workflow Runs.
  function selectedRuns() {
    return snapshot?.selection.eligible.slice(0, MAX_BATCH) || [];
  }
  function renderResults() {
    const selection = snapshot.selection;
    ui.results.hidden = false;
    ui.statRuns.textContent = selection.total;
    ui.statOld.textContent = selection.older;
    ui.statQueued.textContent = selection.eligible.length;
    ui.protectedInfo.textContent = selection.protectedLatestOld ?
      `保护最近一次旧 Run #${selection.protectedLatestOld.id}；当前 HEAD ${snapshot.head.slice(0, 12)} 全部保护。` :
      `当前 HEAD ${snapshot.head.slice(0, 12)} 全部保护；未发现旧 Run。`;
    ui.coverageInfo.textContent = `扫描 ${snapshot.pages} 页（${snapshot.reason}）· ` +
      `跳过运行中/完成 ${selection.skippedNonQueued}，缺少取消权限/链接 ${selection.skippedNoCancelLink}。` +
      (selection.skippedMetadata ?
        ` 另有 ${selection.skippedMetadata} 条终态 Run 缺少提交或时间字段，已排除旧 Run 统计及取消候选。` : "");
    ui.candidateList.replaceChildren();
    for (const item of selection.eligible.slice(0, MAX_BATCH)) {
      const label = document.createElement("div"); label.className = "candidate";
      const details = document.createElement("span"); details.className = "candidateText";
      const title = document.createElement("b"); title.textContent = `Run #${item.id} · ${item.sha.slice(0, 12)}`;
      const small = document.createElement("small");
      small.textContent = `${new Date(item.created).toLocaleString()} · 第 ${item.page} 页 · Queued`;
      details.append(title, small);
      label.append(details);
      ui.candidateList.append(label);
    }
  }
  function showLiveCounts({ page, items, consecutiveTerminalPages }, head, settings) {
    // Counts describe only pages already read, never the whole GitHub history.
    // Reusing chooseRuns also applies HEAD and newest-old protection.
    const selection = chooseRuns(items, head);
    const queued = new Set(items.filter(item => item.queueObserved === true || item.queued === true).map(item => item.id)).size;
    ui.livePages.textContent = String(page);
    ui.liveRuns.textContent = String(selection.total);
    ui.liveOld.textContent = String(selection.older);
    ui.liveQueued.textContent = String(queued);
    ui.liveEligible.textContent = String(selection.eligible.length);
    status(`已完成第 ${page} 页 · ${settings.owner}/${settings.repo}
已扫描 ${selection.total} Run，确认旧 Run ${selection.older}，排队状态 ${queued}，可取消候选暂估 ${selection.eligible.length}` +
      (settings.mode === "fast" ?
        ` · 连续终态 ${consecutiveTerminalPages}/${settings.terminalPages}` : ""));
  }

  async function scan() {
    if (busy) return;
    resetResults();
    let settings;
    try { settings = getSettings(); } catch (error) { status(errorText(error), true); return; }
    switchBusy(true);
    stopRequested = false;
    ui.liveScan.hidden = false;
    for (const key of ["livePages", "liveRuns", "liveOld", "liveQueued", "liveEligible"]) {
      ui[key].textContent = "0";
    }
    let confirmedHead = null;
    let autoCancel = false;
    try {
      status("正在确认最新分支 SHA…");
      const { head } = await requestPage({ op: "head", ...settings });
      confirmedHead = head;
      const fetchWithRetry = async page => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return await requestPage({ op: "page", ...settings, page });
          } catch (error) {
            if (!error.retryable || attempt === 2 || error.retryAfterMs > 12000 || stopRequested) throw error;
            const wait = Math.max(error.retryAfterMs || 0, 800 * (2 ** attempt));
            status(`第 ${page} 页暂时无法读取（${errorText(error)}），${wait / 1000} 秒后重试…`);
            await delay(wait);
          }
        }
      };
      const outcome = await scanWorkflowPages(settings, fetchWithRetry, {
        onProgress: (page, streak) => status(`扫描 ${settings.owner}/${settings.repo} · ${settings.workflow} · ${settings.branch}\n` +
          (settings.mode === "fast" ? `正在读取第 ${page} 页 · 连续终态 ${streak}/${settings.terminalPages}` :
            `正在读取第 ${page}/${settings.maxPages} 页`) +
          ` · 已完成 ${page - 1} 页…`),
        onPage: info => showLiveCounts(info, head, settings),
        shouldStop: () => stopRequested,
        pause: () => delay(250)
      });
      if (!outcome.items.length) throw new Error("没有找到符合筛选条件的工作流 Run");
      const selection = chooseRuns(outcome.items, head);
      snapshot = { settings, head, selection, pages: outcome.pages, reason: outcome.reason,
        limited: outcome.limited, incomplete: false };
      renderResults();
      autoCancel = !stopRequested && selectedRuns().length > 0;
      status(autoCancel ?
        `扫描完成：旧 Queued 候选 ${selection.eligible.length} 条，将自动取消前 ${selectedRuns().length} 条。\n部分已开始的 Job 可能被中断；${outcome.reason}` :
        `扫描完成：没有要取消的旧 Queued Run。\n${outcome.reason}`);
    } catch (error) {
      const partial = error.partialScan;
      if (confirmedHead && partial?.items?.length) {
        try {
          snapshot = {
            settings, head: confirmedHead, selection: chooseRuns(partial.items, confirmedHead),
            pages: partial.pages, reason: `第 ${error.failedPage} 页扫描失败，结果不完整`,
            incomplete: true
          };
          renderResults();
          status(`第 ${error.failedPage} 页失败：${errorText(error)}\n已保留前 ${partial.pages} 页的只读预览；为安全起见，禁止从不完整结果执行取消。`, true);
        } catch (invalidPartial) {
          snapshot = null;
          ui.results.hidden = true;
          status(`扫描失败：${errorText(error)}；部分数据校验失败：${errorText(invalidPartial)}`, true);
        }
      } else {
        snapshot = null;
        ui.results.hidden = true;
        status(errorText(error), true);
      }
    } finally {
      ui.liveScan.hidden = true;
      switchBusy(false);
    }
    // The scan itself is read-only; after successful, complete validation
    // immediately run the selected batch without a second button or prompt.
    if (autoCancel && !stopRequested) {
      await runCancellation().catch(error => status(errorText(error), true));
    }
  }
  async function saveHistory(item) {
    try {
      const data = await chrome.storage.local.get("sweepHistory");
      const history = Array.isArray(data.sweepHistory) ? data.sweepHistory : [];
      await chrome.storage.local.set({ sweepHistory: [item, ...history].slice(0, 40) });
    } catch (error) { console.warn("无法写入本地操作历史", error); }
  }
  async function runCancellation() {
    if (busy || !snapshot || snapshot.incomplete) return;
    const runs = selectedRuns();
    if (!runs.length) return;
    if (runs.length > MAX_BATCH) {
      status(`一次最多取消 ${MAX_BATCH} 条，请减少选择数量。`, true);
      return;
    }
    const { settings, head } = snapshot;
    if (settings.workflow !== normalizeWorkflow(ui.workflow.value) ||
        settings.branch !== normalizeBranch(ui.branch.value)) {
      resetResults();
      status("设置已变化，请重新扫描", true);
      return;
    }
    switchBusy(true);
    let accepted = 0, failed = 0, skipped = 0, stopReason = "";
    const acceptedRuns = [];
    let verified = null;
    let verificationError = "";
    try {
      for (let i = 0; i < runs.length; i++) {
        if (stopRequested) { stopReason = "用户停止"; break; }
        const candidate = runs[i];
        status(`取消请求 ${i + 1}/${runs.length} · Run #${candidate.id}\nGitHub 已接受 ${accepted} · 失败 ${failed}`);
        try {
          const result = await requestPage({
            op: "cancel-one", ...settings, expectedHead: head, candidate
          });
          if (result.accepted) {
            accepted++;
            acceptedRuns.push(candidate);
          } else {
            failed++;
            if (result.authOrRateLimited) {
              stopReason = `HTTP ${result.status}：授权或限流，停止后续操作`;
              break;
            }
          }
        } catch (error) {
          skipped++;
          stopReason = `Run #${candidate.id}：${errorText(error)}`;
          break;
        }
        if (i + 1 < runs.length) await delay(600);
      }
    } finally {
      if (acceptedRuns.length) {
        try {
          status(`已向 GitHub 提交 ${acceptedRuns.length} 条取消请求，开始核验实际终态…`);
          // Read-only status verification reuses the same logged-in github.com
          // workflow pages. It never sends another cancellation request.
          verified = await verifyCancellationResults(acceptedRuns,
            page => requestPage({ op: "page", ...settings, page }), {
              rounds: 4, maxPage: settings.maxPages,
              pause: () => delay(2500), shouldStop: () => stopRequested,
              onProgress: progress => status(
                `取消终态复查 ${progress.round}/4：GitHub 已接受 ${progress.total}，` +
                `明确 Cancelled ${progress.confirmed}，其他终态 ${progress.finishedOther}，` +
                `尚未确认 ${progress.unconfirmed}…`
              )
            });
        } catch (error) {
          verificationError = errorText(error);
        }
      }
      switchBusy(false);
      resetResults();
      const header = `操作结束：GitHub 已接受 ${accepted}，响应失败 ${failed}，安全停止 ${skipped}。`;
      const state = verified ?
        `\n已确认 Cancelled ${verified.confirmed}；其他终态 ${verified.finishedOther}；仍未确认 ${verified.unconfirmed}。` :
        (accepted ? "\n已接受取消请求，但还没有可靠的最终状态。" : "\n没有发送成功的取消请求。");
      const note = verified?.unconfirmed ?
        "\n仍未确认的 Run 不能算取消成功，请在 GitHub Actions 核对。" : "";
      status(header + state + note + (stopReason ? "\n" + stopReason : "") +
        (verificationError ? "\n终态检查失败：" + verificationError : ""), Boolean(stopReason || verificationError));
      await saveHistory({
        repo: `${settings.owner}/${settings.repo}`, workflow: settings.workflow,
        branch: settings.branch, time: new Date().toISOString(), total: runs.length,
        accepted, failed, skipped, stopReason,
        confirmedCancelled: verified?.confirmed ?? 0,
        otherTerminal: verified?.finishedOther ?? 0,
        unconfirmed: verified?.unconfirmed ?? accepted
      });
    }
  }

  ui.scan.addEventListener("click", scan);
  for (const elem of [ui.workflow, ui.branch, ui.scanLimit]) elem.addEventListener("input", resetResults);
  ui.branch.addEventListener("input", () => { branchEdited = true; });
  ui.scanLimit.addEventListener("input", () => { savedLimits[ui.mode.value] = ui.scanLimit.value; });
  ui.mode.addEventListener("change", updateModeUI);
  ui.stop.addEventListener("click", () => {
    stopRequested = true;
    status(snapshot ? "正在停止后续取消请求；已发送的请求仍可能被 GitHub 接受…" :
      "正在停止扫描；当前页读取完成后会保留只读预览。");
  });
  ui.showHistory.addEventListener("click", async () => {
    ui.historyPanel.hidden = !ui.historyPanel.hidden;
    if (ui.historyPanel.hidden) return;
    const { sweepHistory = [] } = await chrome.storage.local.get("sweepHistory");
    ui.historyPanel.replaceChildren();
    if (!sweepHistory.length) { ui.historyPanel.textContent = "还没有取消操作历史。"; return; }
    for (const item of sweepHistory.slice(0, 8)) {
      const div = document.createElement("div"); div.className = "historyEntry";
      div.textContent = `${new Date(item.time).toLocaleString()} · ${item.repo}\n已接受 ${item.accepted}/${item.total}，确认取消 ${item.confirmedCancelled ?? "未核验"}，失败 ${item.failed}`;
      ui.historyPanel.append(div);
    }
  });
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      context = gitHubContext(tab?.url);
      if (!context) throw new Error("请先打开 https://github.com/组织/仓库");
      tabId = tab.id;
      ui.repo.textContent = `${context.owner}/${context.repo}`;
      ui.workflow.value = context.workflow || "ci.yml";
      ui.branch.value = context.branch || "master";
      if (!context.branch) {
        ui.scan.disabled = true;
        try {
          const result = await requestPage({ op: "default-branch", ...context });
          if (!branchEdited && result.branch) ui.branch.value = result.branch;
          status(result.branch ? "已识别仓库默认分支，可以扫描。" :
            "默认填写 master；未识别仓库默认分支，请确认后扫描。");
        } catch {
          status("默认填写 master；未能读取仓库默认分支，请确认后扫描。");
        } finally {
          ui.scan.disabled = false;
        }
      } else {
        status("已识别当前 GitHub 工作流及筛选分支，可以扫描。");
      }
    } catch (error) {
      ui.repo.textContent = "未选择 GitHub 仓库";
      ui.tool.hidden = true;
      ui.unsupported.hidden = false;
      status(errorText(error), true);
    }
  })();
})();
