import { chooseRuns, gitHubContext, normalizeWorkflow, normalizeBranch } from "./selection.js";
import { pageOperation } from "./page-operations.js";
import { DEFAULT_FAST_TERMINAL_PAGES, DEFAULT_FULL_MAX_PAGES, scanLimitForMode, scanStopDecision } from "./scan-policy.js";

(function initializePopup() {
  const $ = id => document.getElementById(id);
  const ui = Object.fromEntries([
    "repo", "unsupported", "tool", "workflow", "branch", "mode", "scanLimit", "limitLabel", "limitHint", "scan", "progress",
    "results", "statRuns", "statOld", "statQueued", "protectedInfo", "coverageInfo",
    "candidateList", "selectAll", "dryRun", "cancel", "stop", "confirmation", "repoConfirmLabel",
    "repoConfirmInput", "confirmCancel", "dismissConfirm", "showHistory", "historyPanel"
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
      "快速扫描：连续 N 页全部终态即停止，默认 N=2；额外设有 100 页安全上限。" :
      "完整扫描：扫描到末页或设置上限，默认最多 20 页；达到上限不代表扫完。";
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
    ui.cancel.disabled = next || !snapshot?.selection.eligible.length;
    ui.workflow.disabled = next;
    ui.branch.disabled = next;
    ui.mode.disabled = next;
    ui.scanLimit.disabled = next;
    ui.selectAll.disabled = next;
    ui.dryRun.disabled = next;
    ui.stop.hidden = !next;
  }
  function resetResults() {
    if (busy) return;
    snapshot = null;
    ui.results.hidden = true;
    ui.confirmation.hidden = true;
    ui.candidateList.replaceChildren();
    ui.cancel.disabled = true;
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
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN", func: pageOperation,
      args: [details]
    });
    if (!injection || !injection.result) throw new Error("页面没有返回有效结果");
    return injection.result;
  }
  function selectedRuns() {
    const ids = new Set([...ui.candidateList.querySelectorAll("input[type=checkbox]:checked")]
      .map(node => Number(node.value)));
    return snapshot?.selection.eligible.filter(item => ids.has(item.id)) || [];
  }
  function updateCancelButton() {
    if (!snapshot) return;
    const count = selectedRuns().length;
    ui.cancel.disabled = busy || count === 0;
    ui.cancel.textContent = count === 0 ? "没有选中的任务" :
      (ui.dryRun.checked ? `预演 ${count} 条取消操作` : `取消选中的 ${count} 条旧 CI`);
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
      `跳过运行中/完成 ${selection.skippedNonQueued}，缺少取消权限/链接 ${selection.skippedNoCancelLink}。`;
    ui.candidateList.replaceChildren();
    for (const item of selection.eligible) {
      const label = document.createElement("label"); label.className = "candidate";
      const check = document.createElement("input"); check.type = "checkbox";
      check.value = String(item.id); check.checked = true;
      check.addEventListener("change", updateCancelButton);
      const details = document.createElement("span"); details.className = "candidateText";
      const title = document.createElement("b"); title.textContent = `Run #${item.id} · ${item.sha.slice(0, 12)}`;
      const small = document.createElement("small");
      small.textContent = `${new Date(item.created).toLocaleString()} · 第 ${item.page} 页 · Queued`;
      details.append(title, small);
      label.append(check, details);
      ui.candidateList.append(label);
    }
    updateCancelButton();
  }
  async function scan() {
    if (busy) return;
    resetResults();
    let settings;
    try { settings = getSettings(); } catch (error) { status(errorText(error), true); return; }
    switchBusy(true);
    stopRequested = false;
    try {
      status("正在确认最新分支 SHA…");
      const { head } = await requestPage({ op: "head", ...settings });
      const all = [];
      const seen = new Set();
      let terminals = 0;
      let reason = "尚未完成扫描";
      let pageCount = 0;
      for (let page = 1; page <= settings.maxPages; page++) {
        if (stopRequested) throw new Error("扫描已手动停止（没有执行取消操作）");
        status(`扫描 ${settings.owner}/${settings.repo} · ${settings.workflow} · ${settings.branch}\n` +
          (settings.mode === "fast" ? `第 ${page} 页 · 连续终态 ${terminals}/${settings.terminalPages}` :
            `第 ${page}/${settings.maxPages} 页`) + "…");
        const result = await requestPage({ op: "page", ...settings, page });
        pageCount = page;
        const fingerprint = result.items.map(row => row.id).join(",");
        if (seen.has(fingerprint) && !result.lastPage) {
          throw new Error(`第 ${page} 页出现重复分页，拒绝使用不完整结果`);
        }
        seen.add(fingerprint);
        all.push(...result.items);
        terminals = result.terminalPage ? terminals + 1 : 0;
        const decision = scanStopDecision({ ...settings, page, consecutiveTerminalPages: terminals, lastPage: result.lastPage });
        if (decision.done) { reason = decision.reason; break; }
      }
      if (!all.length) throw new Error("没有找到符合筛选条件的工作流 Run");
      const selection = chooseRuns(all, head);
      snapshot = { settings, head, selection, pages: pageCount, reason };
      renderResults();
      status(`扫描完成：找到 ${selection.eligible.length} 条可取消的旧排队任务。\n尚未向 GitHub 发送任何取消请求。`);
    } catch (error) {
      resetResults();
      status(errorText(error), true);
    } finally { switchBusy(false); updateCancelButton(); }
  }
  async function saveHistory(item) {
    try {
      const data = await chrome.storage.local.get("sweepHistory");
      const history = Array.isArray(data.sweepHistory) ? data.sweepHistory : [];
      await chrome.storage.local.set({ sweepHistory: [item, ...history].slice(0, 40) });
    } catch (error) { console.warn("无法写入本地操作历史", error); }
  }
  async function runCancellation(isDryRun) {
    if (busy || !snapshot) return;
    const runs = selectedRuns();
    if (!runs.length) return;
    if (runs.length > MAX_BATCH) {
      status(`一次最多取消 ${MAX_BATCH} 条，请减少选择数量。`, true);
      return;
    }
    const { settings, head } = snapshot;
    if (settings.workflow !== normalizeWorkflow(ui.workflow.value) || settings.branch !== normalizeBranch(ui.branch.value)) {
      resetResults(); status("设置已变化，请重新扫描", true); return;
    }
    if (isDryRun) {
      status(`Dry Run：${runs.length} 条旧排队 CI 符合候选规则。\n没有向 GitHub 发送取消请求。`);
      return;
    }
    switchBusy(true);
    stopRequested = false;
    let accepted = 0, failed = 0, skipped = 0, stopReason = "";
    try {
      for (let i = 0; i < runs.length; i++) {
        if (stopRequested) { stopReason = "用户停止"; break; }
        const candidate = runs[i];
        status(`取消请求 ${i + 1}/${runs.length} · Run #${candidate.id}\n已接受 ${accepted} · 失败 ${failed}`);
        try {
          const result = await requestPage({ op: "cancel-one", ...settings, expectedHead: head, candidate });
          if (result.accepted) accepted++;
          else {
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
      ui.confirmation.hidden = true;
      switchBusy(false);
      resetResults();
      const summary = `操作结束：GitHub 已接受 ${accepted}，响应失败 ${failed}，安全停止 ${skipped}。`;
      status(summary + (stopReason ? `\n${stopReason}` : "") +
        "\n已接受不等于最终变为 Cancelled；请在 GitHub 检查终态。", Boolean(stopReason));
      await saveHistory({ repo: `${settings.owner}/${settings.repo}`, workflow: settings.workflow,
        branch: settings.branch, time: new Date().toISOString(), total: runs.length,
        accepted, failed, skipped, stopReason });
    }
  }

  ui.scan.addEventListener("click", scan);
  for (const elem of [ui.workflow, ui.branch, ui.scanLimit]) elem.addEventListener("input", resetResults);
  ui.branch.addEventListener("input", () => { branchEdited = true; });
  ui.scanLimit.addEventListener("input", () => { savedLimits[ui.mode.value] = ui.scanLimit.value; });
  ui.mode.addEventListener("change", updateModeUI);
  ui.selectAll.addEventListener("click", () => {
    const checkboxes = [...ui.candidateList.querySelectorAll('input[type="checkbox"]')];
    const newValue = !checkboxes.every(node => node.checked);
    for (const box of checkboxes) box.checked = newValue;
    updateCancelButton();
  });
  ui.dryRun.addEventListener("change", () => { ui.confirmation.hidden = true; updateCancelButton(); });
  ui.cancel.addEventListener("click", () => {
    if (!snapshot || busy || !selectedRuns().length) return;
    if (ui.dryRun.checked) return void runCancellation(true);
    ui.confirmation.hidden = false;
    ui.repoConfirmLabel.textContent = context.repo;
    ui.repoConfirmInput.value = "";
    ui.confirmCancel.disabled = true;
    ui.repoConfirmInput.focus();
  });
  ui.repoConfirmInput.addEventListener("input", () => {
    ui.confirmCancel.disabled = ui.repoConfirmInput.value.trim() !== context.repo;
  });
  ui.confirmCancel.addEventListener("click", () => {
    if (ui.repoConfirmInput.value.trim() !== context.repo || ui.confirmCancel.disabled) return;
    runCancellation(false).catch(error => status(errorText(error), true));
  });
  ui.dismissConfirm.addEventListener("click", () => { ui.confirmation.hidden = true; });
  ui.stop.addEventListener("click", () => { stopRequested = true; status("正在停止，当前已发出的请求可能仍被 GitHub 接受…"); });
  ui.showHistory.addEventListener("click", async () => {
    ui.historyPanel.hidden = !ui.historyPanel.hidden;
    if (ui.historyPanel.hidden) return;
    const { sweepHistory = [] } = await chrome.storage.local.get("sweepHistory");
    ui.historyPanel.replaceChildren();
    if (!sweepHistory.length) { ui.historyPanel.textContent = "还没有取消操作历史。"; return; }
    for (const item of sweepHistory.slice(0, 8)) {
      const div = document.createElement("div"); div.className = "historyEntry";
      div.textContent = `${new Date(item.time).toLocaleString()} · ${item.repo}\n已接受 ${item.accepted}/${item.total}，失败 ${item.failed}`;
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
