/** GitHub Actions filtered queries return at most 1,000 runs (25 runs per UI page). */
export const GITHUB_FILTERED_RUN_LIMIT = 1000;
export const GITHUB_RUNS_PER_PAGE = 25;
export const GITHUB_MAX_FILTERED_PAGES = GITHUB_FILTERED_RUN_LIMIT / GITHUB_RUNS_PER_PAGE;
export const DEFAULT_FAST_TERMINAL_PAGES = 2;
export const DEFAULT_FULL_MAX_PAGES = 20;
export const FAST_SCAN_HARD_CAP = GITHUB_MAX_FILTERED_PAGES;
export const MAX_FULL_SCAN_PAGES = GITHUB_MAX_FILTERED_PAGES;

export function scanLimitForMode(mode, rawValue) {
  if (mode !== "fast" && mode !== "full") throw new Error("未知扫描方式");
  if (rawValue === "" || rawValue === null || rawValue === undefined) {
    throw new Error("请输入页数");
  }
  const count = Number(rawValue);
  if (!Number.isSafeInteger(count) || count < 1 || count > GITHUB_MAX_FILTERED_PAGES) {
    throw new Error("页数必须介于 1–40（GitHub 单次筛选查询最多返回 1,000 条）");
  }
  return mode === "fast" ?
    { terminalPages: count, maxPages: FAST_SCAN_HARD_CAP } :
    { terminalPages: null, maxPages: count };
}

export function scanStopDecision({ mode, page, maxPages, terminalPages, consecutiveTerminalPages, lastPage }) {
  if (lastPage) return { done: true, reason: "到达最后一页", limited: false };
  if (mode === "fast" && consecutiveTerminalPages >= terminalPages) {
    return { done: true, reason: `连续 ${terminalPages} 页终态；更早页面仍可能有排队任务`, limited: true };
  }
  if (page >= maxPages) {
    if (page >= GITHUB_MAX_FILTERED_PAGES) {
      return {
        done: true, limited: true,
        reason: "已到 GitHub 单次查询上限：1,000 条 / 40 页。已保留扫描结果；更早任务需按创建时间分段查询"
      };
    }
    return { done: true, limited: true, reason: `达到完整扫描设定上限 ${maxPages} 页；可能还有更早的任务` };
  }
  return { done: false, reason: null, limited: false };
}

/** Testable collector: errors retain safely scanned data, but never signal complete coverage. */
export async function scanWorkflowPages(settings, readPage, {
  onProgress = () => {}, shouldStop = () => false, pause = async () => {}
} = {}) {
  const all = [];
  const seen = new Set();
  let streak = 0;
  let pages = 0;
  for (let page = 1; page <= settings.maxPages; page++) {
    if (page > 1) await pause();
    if (shouldStop()) throw new Error("扫描已手动停止（没有执行取消操作）");
    onProgress(page, streak);
    let result;
    try {
      result = await readPage(page);
      if (!Array.isArray(result?.items) ||
          typeof result.terminalPage !== "boolean" ||
          typeof result.lastPage !== "boolean" ||
          result.items.some(item => !Number.isSafeInteger(item.id) || item.id <= 0)) {
        throw new Error(`第 ${page} 页返回了不完整或非法的工作流数据，安全停止`);
      }
      const fingerprint = result.items.map(item => item.id).join(",");
      if (seen.has(fingerprint) && !result.lastPage) {
        throw new Error(`第 ${page} 页出现重复分页，拒绝使用不完整结果`);
      }
      seen.add(fingerprint);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      error.failedPage = page;
      error.partialScan = { items: [...all], pages };
      throw error;
    }
    all.push(...result.items);
    pages = page;
    streak = result.terminalPage ? streak + 1 : 0;
    const decision = scanStopDecision({
      ...settings, page, consecutiveTerminalPages: streak, lastPage: result.lastPage
    });
    if (decision.done) return { items: all, pages, reason: decision.reason, limited: decision.limited };
  }
  throw new Error("扫描上限无效，未能安全结束");
}
