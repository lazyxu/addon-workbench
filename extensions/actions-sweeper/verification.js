/**
 * Read-only final-state verification for cancellation requests. An HTTP 200
 * response to GitHub's cancel endpoint is only *acceptance*, not proof of a
 * final Cancelled result. Never infer cancellation from Completed alone.
 */
const normalized = value => String(value || "UNKNOWN")
  .replace(/^WORKFLOW_(?:RUN|JOB)_(?:STATUS|CONCLUSION)_/i, "")
  .replace(/^CHECK_RUN_(?:STATUS|CONCLUSION)_/i, "")
  .trim().replace(/[\s-]+/g, "_").toUpperCase();

export function cancellationState(item) {
  if (!item) return "unknown";
  const state = normalized(item.state);
  const conclusion = normalized(item.conclusion);
  if (state === "CANCELED" || state === "CANCELLED" ||
      conclusion === "CANCELED" || conclusion === "CANCELLED") {
    return "confirmed";
  }
  if (["COMPLETED", "SUCCESS", "FAILURE", "FAILED", "TIMED_OUT", "SKIPPED"].includes(state) &&
      conclusion !== "UNKNOWN" && conclusion !== "NONE" &&
      conclusion !== "NULL") {
    return "finished-other";
  }
  return "pending";
}

export async function verifyCancellationResults(acceptedRuns, readPage, {
  rounds = 4,
  pause = async () => {},
  onProgress = () => {},
  shouldStop = () => false,
  maxPage = 40
} = {}) {
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 20) {
    throw new Error("校验轮数无效");
  }
  const pending = new Map();
  for (const item of acceptedRuns) {
    if (!Number.isSafeInteger(item?.id) || item.id <= 0 ||
        !Number.isSafeInteger(item.page) || item.page < 1 || item.page > maxPage ||
        pending.has(item.id)) {
      throw new Error("取消请求校验含无效或重复 Run");
    }
    pending.set(item.id, item);
  }
  const confirmed = [];
  const finishedOther = [];
  const observed = new Map();

  for (let round = 1; round <= rounds && pending.size; round++) {
    if (round > 1) await pause();
    if (shouldStop()) break;
    const pages = [...new Set([...pending.values()].map(x => x.page))].sort((a,b) => a-b);
    const snapshots = new Map();
    const read = async page => {
      if (snapshots.has(page)) return snapshots.get(page);
      try {
        const result = await readPage(page);
        if (!Array.isArray(result?.items)) throw new Error("Invalid page response");
        snapshots.set(page, result.items);
      } catch {
        snapshots.set(page, []);
      }
      return snapshots.get(page);
    };
    for (const page of pages) {
      if (shouldStop()) break;
      await read(page);
    }
    // Github's list can shift when runs change state. Read adjacent pages
    // only for records not found at their original page.
    const idsFound = new Set([...snapshots.values()].flat().map(x => x.id));
    const missing = [...pending.values()].filter(x => !idsFound.has(x.id));
    const neighbors = [...new Set(missing.flatMap(x => [x.page-1,x.page+1])
      .filter(n => n>=1 && n<=maxPage))].filter(n => !snapshots.has(n));
    for (const page of neighbors) {
      if (shouldStop()) break;
      await read(page);
    }
    const latestById = new Map([...snapshots.values()].flat().map(x => [x.id, x]));
    for (const [id] of pending) {
      const latest = latestById.get(id);
      if (!latest) continue;
      observed.set(id, { state: latest.state, conclusion: latest.conclusion || null });
      const status = cancellationState(latest);
      if (status === "confirmed") {
        confirmed.push(id);
        pending.delete(id);
      } else if (status === "finished-other") {
        finishedOther.push(id);
        pending.delete(id);
      }
    }
    onProgress({
      round, total: acceptedRuns.length, confirmed: confirmed.length,
      finishedOther: finishedOther.length, unconfirmed: pending.size
    });
  }
  return {
    accepted: acceptedRuns.length, confirmed: confirmed.length,
    finishedOther: finishedOther.length, unconfirmed: pending.size,
    confirmedIds: confirmed, finishedOtherIds: finishedOther,
    unconfirmedIds: [...pending.keys()],
    observations: [...observed.entries()].map(([id, value]) => ({ id, ...value }))
  };
}
