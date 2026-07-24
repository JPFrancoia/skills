# Persistent subagent status and session totals in the Pi sidebar

Status: Completed
Date: 2026-07-24

## 1. Brief

Keep every top-level subagent name used by the current Pi session visible in the sidebar, even after that child stops. Each row will show a green dot while any child with that agent name is running, a red dot otherwise, plus the agent's cumulative child runtime and dollar cost for the session.

## 2. Current state / relevant context

- `extensions/pi-sidebar.ts` currently stores only running foreground and async rows. Finished children disappear and no per-agent runtime or cost is retained.
- Foreground `subagent` progress/final details already expose each child's exact agent name, `durationMs`, and `usage.cost`.
- Async runs persist versioned `status.json` artifacts. Each step exposes its agent, lifecycle state, `durationMs`, and `totalCost.costUsd`; the async-start event supplies the run ID, parent session ID, and artifact directory.
- The stable pi-subagents RPC returns formatted status text, not structured historical cost data. Reading the versioned JSON artifact supplied by the lifecycle event is smaller and more accurate than parsing text or reconstructing model pricing.
- Pi custom entries (`pi.appendEntry`) can store a compact sidebar-owned ledger in the parent session. Replaying the active branch makes the rows survive `/reload`, resume, compaction, and `/tree` navigation without a global database.
- The installed pi-subagents package exports only its extension entry point, so the sidebar must not import private source helpers.

Success criteria:

1. A newly started top-level child immediately creates a row keyed by its agent name.
2. The row's dot uses the theme's `success` color while at least one child with that name runs and `error` otherwise.
3. A stopped, completed, failed, or paused child leaves its agent row visible and red.
4. Runtime and cost sum across repeated uses of the same agent name in the current parent session.
5. Live foreground and async snapshots update the displayed runtime/cost when the underlying progress exposes newer values.
6. Repeated snapshots, reloads, and completion events do not double-count a child run.
7. Parallel children with the same agent name contribute separately; their child runtimes are summed.
8. Existing width, height, sanitization, session-switch, and no-pi-subagents fallbacks remain safe.

## 3. Proposed implementation

### Session ledger

Add one custom entry type, `pi-sidebar-subagent-run`, containing a latest-known snapshot for one child invocation:

```ts
{
  key: "foreground:<run-or-tool-call-id>:<child-index>",
  agent: "worker",
  durationMs: 60000,
  cost: 0.2337,
  asyncDir?: "/tmp/..."
}
```

The key identifies one invocation, not the agent name. Replaying the active branch keeps only the latest snapshot for each key; rendering then groups snapshots by sanitized agent name. This prevents update snapshots from being added twice while still allowing repeated and parallel uses of `worker` to accumulate.

Persist only meaningful lifecycle points: first observation and terminal/final snapshots. Keep one-second running updates in memory so the session file does not grow every second. If Pi reloads during an async run, the persisted `asyncDir` lets the sidebar resume reading its current status.

### Foreground runs

Replace the running-name-only foreground state with per-child snapshots:

- `tool_execution_start`: seed the currently starting single/parallel/first-chain children with zero totals, mark them running, and append first-observation ledger entries.
- `tool_execution_update`: read structured `details.results[]` and `details.progress[]`; update each child's agent, running state, duration, and cost in memory.
- `tool_result`: store final child snapshots from `details.results[]` and append them to the ledger.
- `tool_execution_end`: mark any remaining seeded child snapshots stopped, preserving their last totals.

Use `details.runId` when available and the Pi tool call ID as the fallback key. Do not infer pricing from token counts.

### Async runs

Keep the existing RPC polling only as a graceful running-roster fallback, but make versioned async artifacts the metrics source:

- On `subagent:async-started`, accept only events matching the current parent session, remember `runId -> asyncDir`, and persist that path once.
- Recover async directories from ledger entries and persisted async launch tool results on session replay.
- Once per existing one-second sidebar tick, read each known `status.json` with `readFile`/`JSON.parse`; ignore malformed, missing, unsupported, or foreign-session files.
- For every non-pending top-level step, update the matching child snapshot from `status`, `durationMs`, and `totalCost.costUsd`.
- When a step becomes terminal, append its final snapshot once. Completion events trigger an immediate refresh but are not separately added, avoiding double counting.

If an artifact disappears before a final read, keep the last persisted snapshot and show the agent red once no current running source reports it.

### Aggregation and rendering

Group latest invocation snapshots by exact agent name:

- `running`: true if any current invocation for that name is running;
- `durationMs`: sum each child invocation's latest duration;
- `cost`: sum each child invocation's latest cost.

Render one line per first-use order:

```text
● worker 1m46s · $0.2337
● reviewer 42s · $0.0812
```

Use `theme.fg("success", "●")` for running and `theme.fg("error", "●")` for not running. Use a compact duration formatter that omits zero seconds after whole minutes (`1m`, not `1m0s`) and four decimal places for cost. Sanitize names before styling and let the existing compositor truncate the finished line to sidebar width.

### Scope boundary

Aggregate by configured top-level agent name, not task label, model, run ID, or nested descendant. Do not add a database, package dependency, model-price table, filesystem watcher, controls, token totals, or historical data outside the active Pi session branch.

## 4. File-by-file impact

- `extensions/pi-sidebar.ts` — replace running-only subagent rows with invocation snapshots, ledger replay/persistence, structured foreground extraction, async artifact refresh, per-agent aggregation, and green/red metric rendering.
- `extensions/pi-sidebar.test.ts` — cover ledger replay/deduplication, foreground and async snapshot extraction, repeated/parallel aggregation, status colors, duration/cost formatting, terminal persistence, and unsafe artifact input.
- `docs/pi-sidebar.md` — update the Subagents section to describe persistent rows, dot meanings, cumulative child runtime/cost, active-session scope, and top-level-only aggregation.
- `plans/pi-sidebar-subagent-metrics-plan.md` — retain decisions, checklist progress, deviations, and validation evidence.
- `docs/README.md` — no change expected because this updates the existing sidebar guide rather than adding a document.

## 5. Risks and edge cases

- **Double counting:** foreground progress/final details and async status/completion events describe the same invocation repeatedly. Latest-snapshot-by-key replacement is required before grouping by agent.
- **Concurrent same-name children:** sum each child's duration, even when wall-clock intervals overlap. This is child compute time and aligns with cumulative cost; it is intentionally not unique elapsed wall time.
- **Pending chain steps:** do not create a used-agent row until the step starts. Merely appearing later in a chain declaration is not usage.
- **Paused/stopped/failed children:** retain their totals and show red. A resumed child is a new invocation and adds to the same agent total.
- **Live cost lag:** providers report usage at completed model turns. Runtime can tick continuously, while cost may update in steps; do not estimate missing cost.
- **Nested subagents:** top-level status/result totals can include nested cost. Do not recursively add nested children, which would double-count. Nested names remain outside this compact section.
- **Artifact cleanup/corruption:** tolerate missing or invalid JSON and retain the last ledger snapshot. Validate session ID and accepted primitive fields before applying data.
- **Session branches:** replay only `getBranch()` so `/tree` follows the active history. Do not use global run history, which lacks parent-session identity and cost.
- **Reload during foreground execution:** Pi normally cannot reload cleanly inside an active tool call. Seed entries still preserve membership; any unavailable final metrics remain at the last observed value.
- **Extension absence:** if pi-subagents is not loaded, the section remains empty until a real `subagent` tool call is observed; no warnings or crashes.

## 6. Validation / testing

Automated checks:

- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts`
- `git diff --check`
- `pre-commit run --all-files`

Focused assertions:

- replay replaces duplicate snapshots by invocation key and preserves first-use order;
- two completed `worker` invocations aggregate duration/cost correctly;
- two concurrent `worker` children both count, while one running child keeps the grouped dot green;
- terminal states render red without removing the row;
- foreground structured progress/final result fields produce exact snapshots;
- async `status.json` step states/durations/costs produce exact snapshots and reject a foreign session;
- whole-minute and minute/second durations format as `1m` and `1m46s`;
- names/control sequences remain sanitized and lines remain width-bounded;
- malformed/missing artifact data leaves prior state intact.

Manual TUI proof:

1. Launch Pi from the task worktree with the sidebar and pi-subagents extensions.
2. Start `worker` asynchronously and verify a green `worker` row with increasing runtime.
3. Let it complete and verify the row stays, turns red, and shows final runtime/cost.
4. Resume or launch `worker` again and verify the row turns green; after completion verify both invocation totals are summed.
5. Launch a different agent and verify it gets an independent row.
6. Run `/reload` and verify prior rows/totals remain and all inactive dots are red.

## 7. Step-by-step execution checklist

- [x] Search conversation memory and recover the existing sidebar/subagent implementation history.
- [x] Read the complete sidebar extension, adjacent test, existing plan/docs, Pi extension/TUI docs, and pi-subagents skill/docs.
- [x] Inspect pi-subagents foreground result shapes, async lifecycle events, RPC limits, and versioned artifacts.
- [x] Create dedicated worktree `sidebar-subagent-metrics` from current `master`.
- [x] Get user approval for this implementation-ready plan; the user chose direct implementation without a grill pass.
- [x] Add focused assertions for ledger replay, extraction, aggregation, and rendering.
- [x] Implement the smallest ledger/snapshot state change in `extensions/pi-sidebar.ts`.
- [x] Run the adjacent extension test and fix only failures caused by this change.
- [x] Run a fresh-context correctness/simplicity review and apply accepted fixes.
- [x] Perform live TUI verification with repeated use of one agent.
- [x] Update `docs/pi-sidebar.md` to match implemented behavior.
- [x] Run repository hygiene checks.
- [x] Mark this plan Completed with final validation results and any deviations.

## 8. Open questions / assumptions

- Assumption: cumulative runtime means the sum of each child invocation's own runtime. Concurrent children therefore add both durations rather than counting only unique wall time.
- Assumption: rows aggregate by configured agent name (`worker`, `reviewer`), ignoring task labels.
- Assumption: runtime includes failed, paused, and stopped attempts because they consumed time and cost.
- Assumption: live cost may lag until a model turn reports usage; missing cost is displayed as `$0.0000`, never estimated.
- Assumption: display uses four decimal places consistently, so the example's `$0.466` would render as `$0.4660`.
- Non-goal: show nested descendant names separately or split totals by model/task.
- Non-goal: retain totals across different Pi sessions.

## Grill record

The user approved direct implementation without a grill pass.

## Implementation notes

- Foreground invocations use structured Pi tool progress/results and persist first/final snapshots in the parent session.
- Async invocations persist their run directory, then read lifecycle artifact version 2 with exact run/session identity checks. Negative or malformed metrics are rejected.
- A fresh review found two concrete issues: floating-point test equality and insufficient async artifact validation. The test now uses a tolerance, and artifact parsing now requires the supported version, matching run ID/session ID, and non-negative finite metrics.
- The docs-maintainer confirmed `docs/README.md` does not need changing and supplied the updated `docs/pi-sidebar.md` behavior text.
- A 180×45 tmux TUI smoke test launched `scout` twice through `/run ... --bg`. The row was green while running, red after completion, changed from `51s · $0.0350` after the first run to `1m16s · $0.0529` after the second, and retained those totals after `/reload`.
- ProofShot was not used because it only drives browser UIs and is not installed in this environment; raw ANSI tmux capture verified the terminal theme colors (`success` green and `error` red).

Validation completed:

- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts`
- `git diff --check`
- `pre-commit run --all-files` (`Detect hardcoded secrets` passed)
- Fresh-context correctness review and docs-maintainer pass
- Live repeated-agent and reload TUI smoke test
