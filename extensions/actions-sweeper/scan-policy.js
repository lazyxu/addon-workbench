/** Independent scan rules: fast terminal streak N is not the full-scan page limit. */
export const DEFAULT_FAST_TERMINAL_PAGES = 2;
export const DEFAULT_FULL_MAX_PAGES = 20;
export const FAST_SCAN_HARD_CAP = 100;

export function scanLimitForMode(mode, rawValue) {
  if (mode !== "fast" && mode !== "full") throw new Error("未知扫描方式");
  if (rawValue === "" || rawValue === null || rawValue === undefined) {
    throw new Error("请输入页数");
  }
  const count = Number(rawValue);
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new Error("页数必须介于 1–100");
  }
  return mode === "fast" ?
    { terminalPages: count, maxPages: FAST_SCAN_HARD_CAP } :
    { terminalPages: null, maxPages: count };
}

export function scanStopDecision({ mode, page, maxPages, terminalPages, consecutiveTerminalPages, lastPage }) {
  if (lastPage) return { done: true, reason: "到达最后一页" };
  if (mode === "fast" && consecutiveTerminalPages >= terminalPages) {
    return { done: true, reason: `连续 ${terminalPages} 页终态；更早页面仍可能存在排队任务` };
  }
  if (page >= maxPages) {
    return { done: true, reason: mode === "fast" ?
      `达到快速扫描安全上限 ${maxPages} 页；尚未达到连续 ${terminalPages} 页终态` :
      `达到完整扫描上限 ${maxPages} 页；可能还有更早的任务` };
  }
  return { done: false, reason: null };
}
