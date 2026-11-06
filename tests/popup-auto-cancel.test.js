import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chooseRuns, gitHubContext, normalizeWorkflow, normalizeBranch } from "../extensions/actions-sweeper/selection.js";
import { scanLimitForMode, scanWorkflowPages } from "../extensions/actions-sweeper/scan-policy.js";
import { verifyCancellationResults } from "../extensions/actions-sweeper/verification.js";

const popupPath = fileURLToPath(new URL("../extensions/actions-sweeper/popup.js", import.meta.url));
const popupSource = readFileSync(popupPath, "utf8").replace(/^import .*;\s*$/gm, "");

class FakeElement {
  constructor(id = "") {
    this.id = id; this.value = ""; this.textContent = "";
    this.checked = false; this.disabled = false; this.hidden = false;
    this.children = []; this.events = {}; this.classList = { toggle() {} };
  }
  addEventListener(type, cb) { this.events[type] = cb; }
  replaceChildren(...items) { this.children = [...items]; }
  append(...items) { this.children.push(...items); }
  focus() {}
  querySelectorAll() { return []; }
}

const ids = [
  "repo","unsupported","tool","workflow","branch","mode","scanLimit",
  "limitLabel","limitHint","scan","progress","results","statRuns","statOld",
  "statQueued","protectedInfo","coverageInfo","candidateList","stop",
  "liveScan","livePages","liveRuns","liveOld","liveQueued","liveEligible",
  "showHistory","historyPanel"
];
const head = "a".repeat(40), old = "b".repeat(40), older = "c".repeat(40);
const makeRun = (id, sha, created) => ({
  id, sha, created, suite: String(id), page: 1,
  state: "WORKFLOW_RUN_STATUS_QUEUED",
  queueObserved: true, queued: true
});

async function harness({ noCandidates = false, failScan = false, stopDuringPage = false } = {}) {
  const elems = Object.fromEntries(ids.map(id => [id, new FakeElement(id)]));
  elems.mode.value = "fast";
  elems.scanLimit.value = "2";
  const document = {
    getElementById(id) { return elems[id] || null; },
    createElement(tag) { return new FakeElement(tag); }
  };
  const records = noCandidates ?
    [makeRun(33, head, "2026-11-06T12:00:00Z"), makeRun(22, old, "2026-11-06T11:00:00Z")] :
    [makeRun(33, head, "2026-11-06T12:00:00Z"), makeRun(22, old, "2026-11-06T11:00:00Z"),
      makeRun(11, older, "2026-11-06T10:00:00Z")];
  const ops = [];
  const accepted = new Set();
  const history = [];
  const chrome = {
    tabs: {
      async query() {
        return [{ id: 101, url: "https://github.com/example/repository/actions/workflows/ci.yml?query=branch%3Amaster" }];
      }
    },
    scripting: {
      async executeScript({ args: [req] }) {
        ops.push(req.op);
        if (req.op === "head") return [{ result: { head } }];
        if (req.op === "page") {
          if (stopDuringPage && !elems.stop.hidden) elems.stop.events.click();
          if (failScan) return [{ result: { __actionsSweeperError: true, message: "GitHub HTML unavailable" } }];
          const items = records.map(run => accepted.has(run.id) ?
            { ...run, state: "WORKFLOW_RUN_STATUS_COMPLETED",
              conclusion: "WORKFLOW_RUN_CONCLUSION_CANCELLED", queued: false } : run);
          return [{ result: { items, terminalPage: false, lastPage: true } }];
        }
        if (req.op === "cancel-one") {
          accepted.add(req.candidate.id);
          return [{ result: { accepted: true, status: 200 } }];
        }
        throw new Error("Unexpected operation " + req.op);
      }
    },
    storage: {
      local: {
        async get() { return { sweepHistory: history }; },
        async set(data) { history.unshift(...data.sweepHistory.slice(0, 1)); }
      }
    }
  };
  const init = new Function(
    "document","chrome","setTimeout","chooseRuns","gitHubContext",
    "normalizeWorkflow","normalizeBranch","scanLimitForMode","scanWorkflowPages",
    "verifyCancellationResults","DEFAULT_FAST_TERMINAL_PAGES","DEFAULT_FULL_MAX_PAGES",
    "pageOperation", popupSource
  );
  init(document,chrome,fn=>queueMicrotask(fn),chooseRuns,gitHubContext,
    normalizeWorkflow,normalizeBranch,scanLimitForMode,scanWorkflowPages,
    verifyCancellationResults,2,20,() => {});
  for (let i=0; i<5; i++) await Promise.resolve();
  return { elems, ops, accepted, history };
}

test("a single scan click automatically cancels eligible old QUEUED runs", async () => {
  const { elems, ops, accepted } = await harness();
  await elems.scan.events.click();
  assert.deepEqual(ops.filter(op => op === "cancel-one"), ["cancel-one"]);
  assert.deepEqual([...accepted], [11]);
  assert.equal(elems.statQueued.textContent, 1);
  assert.match(elems.progress.textContent, /已确认 Cancelled 1/);
});

test("a scan with no eligible old runs never sends cancellation requests", async () => {
  const { elems, ops } = await harness({ noCandidates: true });
  await elems.scan.events.click();
  assert.equal(ops.includes("cancel-one"), false);
  assert.match(elems.progress.textContent, /没有要取消/);
});

test("an incomplete or failed scan never sends cancellation requests", async () => {
  const { elems, ops } = await harness({ failScan: true });
  await elems.scan.events.click();
  assert.equal(ops.includes("cancel-one"), false);
  assert.match(elems.progress.textContent, /GitHub HTML unavailable/);
});

test("stop during scanning prevents automatic cancellation", async () => {
  const { elems, ops } = await harness({ stopDuringPage: true });
  await elems.scan.events.click();
  assert.equal(ops.includes("cancel-one"), false);
});

test("no Dry Run, second confirmation, or candidate-selection controls exist", async () => {
  const { elems } = await harness();
  assert.ok(!Object.hasOwn(elems, "cancel"));
  assert.ok(!Object.hasOwn(elems, "selectAll"));
  assert.ok(!Object.hasOwn(elems, "dryRun"));
  assert.ok(!Object.hasOwn(elems, "confirmation"));
});
