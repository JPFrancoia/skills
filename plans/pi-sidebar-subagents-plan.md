# Running subagents in the Pi sidebar

Status: Completed
Date: 2026-07-24

## 1. Brief

Add a **Subagents** section to the existing right sidebar so the active parent session shows which child agents are running. Reuse pi-subagents' process-local RPC/status protocol and Pi's existing tool progress events rather than adding a dependency or coupling the sidebar to pi-subagents' private in-memory state.

## 2. Current state / relevant context

- `extensions/pi-sidebar.ts` renders Conversation, Stats, optional MCP/extension rows, Todos, and Git, but it has no subagent state.
- pi-subagents keeps foreground and async state inside its own extension closure; another extension cannot read those maps directly.
- pi-subagents exposes a documented v1 event-bus RPC (`subagents:rpc:v1:request` and per-request replies). Its `status` method reports current foreground activity or all active async runs for the current Pi session.
- Async status output includes one line per chain/parallel child and distinguishes `running` from `pending`/finished children.
- Pi also emits `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` for the foreground `subagent` tool, so the sidebar can use the tool's structured live progress while that call is active.
- The installed package's native fleet collector is not part of its public exports. Importing `src/tui/fleet.ts`, reading its closure state, or scraping its widget would be brittle.
- Memory from the prior "Pi Sidebar Extension Tracker" work confirms this sidebar is intentionally one small extension with adjacent tests and durable docs.

Success criteria:

1. The sidebar contains a section titled `Subagents`.
2. Each currently running child is shown by agent/step label; parallel children can appear simultaneously.
3. Foreground tool progress and detached async runs from the active Pi session are both represented.
4. Completed, failed, paused, stopped, or merely pending children are not shown as running.
5. If pi-subagents is absent or its status RPC is unavailable, the section degrades to `(none running)` without warnings or crashes.
6. Rendering remains bounded by sidebar width/height and does not expose raw control sequences.

## 3. Proposed implementation

### State and rendering

Add a minimal `RunningSubagent` row to sidebar state, keyed by source/run/child index and containing only the display name. Render it directly after Stats as:

```text
Subagents
────────────────────────────────────────────────
● scout
● Validation (reviewer)
```

When empty, render `(none running)`. Reuse `section`, `fitSection`, `truncateToWidth`, theme colors, and the sidebar's existing one-second repaint loop. No separate panel component or animation is needed.

### Async runs

Use the stable pi-subagents v1 event-bus RPC rather than importing package internals:

1. On session start and each existing one-second tick, emit a `status` request when no prior request is pending.
2. Subscribe to that request's unique reply event and apply a short timeout so a missing/disabled pi-subagents extension cannot leak listeners or block refresh.
3. Parse only the status list's child rows (`<index>. <label> | running | ...`), ignoring queued, completed, failed, paused, and stopped rows.
4. Keep the previous async snapshot during a foreground `subagent` call because pi-subagents' default status response prioritizes foreground activity; refresh it again when that call ends.
5. Listen to `subagent:async-started` and `subagent:async-complete` only as repaint/refresh hints. The RPC remains the source of truth and automatically filters to the active parent session.

The parser will be small, strict, and covered by assertions. Unknown output shapes produce an empty/unchanged snapshot rather than guessed rows.

### Foreground runs

Track only the currently executing `subagent` tool call:

- `tool_execution_start`: seed an immediate row for a single agent or the first chain/parallel group when the arguments are recognizable.
- `tool_execution_update`: replace the seed with rows whose structured progress status is exactly `running`; use task labels when available.
- `tool_execution_end`: clear foreground rows and trigger an async status refresh.

Merge foreground and async rows by stable key before rendering. Existing tracking for all active tools remains unchanged.

### Simplicity boundary

Do not add a general fleet client, filesystem watcher, direct reads of temp `status.json`, package deep imports, nested transcript UI, controls, costs, tokens, or completed-run history. The native `/subagents-fleet` command already provides detailed inspection; this sidebar addition is only an always-visible running roster.

## 4. File-by-file impact

- `extensions/pi-sidebar.ts` — add running-subagent state, the small RPC/progress adapters, section rendering, refresh hooks, and cleanup.
- `extensions/pi-sidebar.test.ts` — add focused assertions for active async status parsing, foreground progress extraction, empty fallback, sanitization, and section placement.
- `docs/pi-sidebar.md` — document the running-only Subagents section, its active-session scope, and graceful fallback.
- `plans/pi-sidebar-subagents-plan.md` — retain decisions, checklist progress, deviations, and validation results.
- `docs/README.md` — no change expected because the existing sidebar guide remains the only documentation entry.

## 5. Risks and edge cases

- **RPC output is text:** v1 status replies do not expose structured fleet rows. Keep parsing narrow and tested; if pi-subagents later adds structured fleet data, prefer that and delete the parser.
- **Foreground precedence:** a no-target status call reports foreground state before async state. Preserve the last async snapshot during that window and use completion/start events as refresh hints.
- **Parallel/chain updates:** progress arrays may be partial. Replace foreground rows only when a valid structured progress collection is present; otherwise retain the seed briefly.
- **Extension load order/absence:** the RPC listener may not exist yet or at all. Use unique request IDs, unsubscribe/timeout cleanup, and no user-facing warning.
- **Session switches/reloads:** increment the existing generation, clear foreground/async rows, and ignore stale replies from the prior generation.
- **Short terminals:** the new always-present section competes for rows with Todos, Extensions, and Git. Update reserve calculations so lower-priority sections truncate through existing `fitSection` behavior rather than overflowing.
- **Control sequences:** sanitize agent names/labels before styling and width truncation.
- **Nested subagents:** nested children are outside the first version unless they appear as ordinary running child rows in the v1 status response. The native fleet remains the detailed nested view.

## 6. Validation / testing

Automated checks:

- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts`
- `git diff --check`
- `pre-commit run --all-files`

Focused test coverage:

- parse multiple async child rows and keep only `running`;
- preserve labels such as `Validation (reviewer)`;
- reject malformed/unrelated status text;
- extract multiple foreground running entries from structured progress;
- render `Subagents`, running rows, and `(none running)` within width/height limits;
- keep a blank row above the section title.

Manual TUI proof:

1. Launch Pi from this worktree with the sidebar extension.
2. Start one async scout and verify `● scout` appears under Subagents.
3. Start a parallel async run and verify simultaneous running children appear while pending/completed children do not.
4. Let runs finish and verify their rows disappear without `/sidebar refresh`.
5. Reload without pi-subagents enabled and verify the sidebar remains healthy with `(none running)`.

## 7. Step-by-step execution checklist

- [x] Read the complete sidebar extension, adjacent test, durable docs, relevant Pi extension/TUI docs, and pi-subagents status/fleet implementation.
- [x] Confirm implementation occurs in dedicated worktree `sidebar-subagents`.
- [x] Define success criteria and the smallest supported data flow.
- [x] Get plan approval; the user chose direct implementation without a grill pass.
- [x] Add focused parser/progress tests.
- [x] Add the Subagents state and section rendering.
- [x] Add RPC polling, foreground progress updates, generation checks, and cleanup.
- [x] Run the focused extension test.
- [x] Update implemented-behavior documentation.
- [x] Run repository hygiene checks.
- [x] Perform live TUI verification with real subagent launches.
- [x] Record deviations/results and mark this plan Completed.

## 8. Open questions / assumptions

- Interpretation: the user's "extra session" means an extra sidebar **section** titled `Subagents`.
- Decision: show only children whose status is `running`; queued and historical children stay out of this compact roster.
- Decision: show agent/step labels only. Detailed transcripts, controls, tokens, costs, and history remain in `/subagents-fleet`.
- Decision: place Subagents immediately after Stats so live execution state stays near the current tool/response metrics.
- Assumption: one-second updates are sufficient because that matches the sidebar's existing clock/tool repaint cadence.
- Assumption: v1 status list rows remain backward-compatible enough for a strict parser; malformed responses fail closed.
- Non-goal: replace or duplicate pi-subagents' own async widget/fleet inspector.
- Non-goal: change pi-subagents itself or add a new dependency.

## Implementation notes and validation results

- Added the Subagents section immediately after Stats with an explicit `(none running)` fallback.
- Async rows come from pi-subagents' v1 status RPC and are filtered to exact `running` child rows. The parser accepts the spawn-budget line that pi-subagents prepends to status output.
- Foreground tool rows use structured progress updates; single, parallel, and first chain-step arguments seed the display until the first update arrives.
- A fresh review found two issues worth fixing: parallel/chain foreground calls had no initial rows, and very short terminals could show a partial section. Initial argument handling and a four-row fit guard now cover both.
- Durable behavior documentation was updated by `docs-maintainer` in `docs/pi-sidebar.md`; the docs index did not need a new entry.
- Live tmux verification loaded only pi-subagents plus the worktree sidebar source. It showed `(none running)`, then `● scout` for a real async child, then simultaneous `● scout` and `● reviewer` rows for a parallel async run. Completed rows cleared on the next status refresh.

Checks completed:

- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts`
- `git diff --check`
- `pre-commit run --all-files` (`Detect hardcoded secrets` passed)
- Fresh-context implementation review, followed by fixes for both concrete findings.
- Manual 180×45 tmux TUI smoke test with one single and one two-child parallel async run.

Deviation from the initial plan:

- The v1 status response is prefixed with spawn-budget text, so the parser locates the active/no-active heading anywhere in the reply instead of requiring it at byte zero.
- Async completion can remain visible until the next one-second refresh; this is intentional and matches the sidebar's existing refresh cadence.

## Grill record

The user approved direct implementation without a grill pass.
