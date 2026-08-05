# Custom Pi sidebar extension plan

Status: Completed
Date: 2026-07-24

## 1. Brief

Build a full-height right sidebar tailored to this Pi setup, then move the existing footer statuses and `rpiv-todo` list into it so the main editor area stays clean. The sidebar will show the conversation name, model and thinking level, cwd, context usage, session statistics, MCP servers, todos, extension indicators, and Git changes across a root repository plus independent nested repositories. Pi has no public API for a persistent non-overlapping side column, so this deliberately uses the same private terminal-width/render shim as the two reference packages, with narrower scope and explicit cleanup.

## 2. Current state / relevant context

### Confirmed requirements

- Rendering: fixed reserved right column; Pi content must reflow rather than sit underneath it.
- Relocation: hide the native footer and the `rpiv-todo` above-editor widget; render their useful data only in the sidebar.
- Git scope: show the root repository plus nested independent repositories with their own `.git` directories; exclude linked worktrees (`.git` files) and their root-container noise.
- Delivery: add the extension to this repository, validate it, land it on the task branch, and install the stable repository path into live Pi settings.
- Keep the sidebar visible while the model works so live tool/speed information remains useful.

### Pi and package constraints

- Pi exposes model, thinking, context, session entries, lifecycle events, widgets, custom footers, and extension status data.
- Pi does **not** expose a supported persistent side-region API. Both reference extensions replace `terminal.columns`, hook private `tui.doRender`, and paint the reserved columns with ANSI cursor movement.
- Both references have avoidable defects: hard-coded widths, source/docs drift, stale MCP assumptions, and Git handling limited to one repository.
- Only one extension should own this compositor and the `pi-sidebar` widget key.
- `rpiv-todo` persists the complete task snapshot in `toolResult.details` for tool name `todo`. The latest valid snapshot on the active branch is authoritative.
- Footer indicators such as Ponytail use `ctx.ui.setStatus(key, text)`. They are available only through the `footerData` object passed to `ctx.ui.setFooter()`.
- The reference container repository has independent nested repositories and linked task worktrees; it has no `.gitmodules` declaration.

### Success criteria

- The right column never overlaps Pi transcript/editor content at supported terminal widths.
- Session title, model/thinking, cwd, context, and stats update after session/model/message events.
- Footer indicators such as Ponytail appear in the sidebar and no longer consume a footer row.
- `rpiv-todo` task subjects/statuses replay correctly on resume/tree/compaction and update after tool results; its original widget stays hidden.
- In a container repository, Git groups dirty files by the root and dirty independent nested repositories, excludes linked worktrees, and preserves file names when truncating paths.
- All timers and terminal monkey-patches are restored on reload/session shutdown, including the hardware cursor.

## 3. Proposed implementation

### 3.1 Extension shape

Create one extension file and one adjacent test:

- `extensions/pi-sidebar.ts`
- `extensions/pi-sidebar.test.ts`

The extension file will keep the compositor, state collection, parsing, and rendering together. Splitting a one-consumer implementation into a module tree would add navigation without reducing dependencies; exports under `__test__` will expose only pure helpers needed by the test.

### 3.2 Reserved-column compositor

On UI-bearing `session_start`:

1. Register a zero-line custom footer to receive Pi's `tui`, theme, and footer-status provider while removing duplicated footer rows.
2. Save the original `terminal.columns` descriptor and `tui.doRender` method.
3. Replace `terminal.columns` with a getter that subtracts the configured sidebar width plus separator only when the raw terminal is wide enough.
4. Wrap `tui.doRender`; call Pi's renderer first, then paint every sidebar row using synchronized output, cursor save/restore, disabled auto-wrap, ANSI-safe truncation, and the current theme.
5. Skip painting while the TUI is stopped (for example, an external editor).
6. On dispose/shutdown, restore the exact descriptor/method, clear timers, clear custom UI, and emit the hardware-cursor restore sequence.

Defaults:

- width: 42 columns;
- minimum main-content width: 70 columns;
- refresh interval for external Git/MCP state: 15 seconds, plus relevant Pi events;
- no auto-hide while working.

Commands:

- `/sidebar` or `/sidebar toggle`
- `/sidebar on`
- `/sidebar off`
- `/sidebar width <20-80>`
- `/sidebar refresh`
- `/sidebar status`

Runtime width changes reuse the compositor's dynamic width getter and request a full Pi render. No persistent config format or new dependency is added for v1.

### 3.3 Footer and existing-widget relocation

- Call `ctx.ui.setFooter(...)` with a zero-line component. This both hides the native footer and captures `footerData.getExtensionStatuses()` for sidebar rendering.
- Render the MCP status inside the MCP section.
- Render all other non-empty status values in an `Extensions` section, sorted by status key. Preserve their theme ANSI while removing embedded line/control characters.
- Suppress the `rpiv-todos` widget after startup and after finalized `todo` results. A deferred startup clear avoids extension load-order races; shutdown clears its pending timer.
- Do not suppress unrelated above/below-editor widgets because they may be interactive or multi-line rather than footer indicators.

### 3.4 Session/model/context/stat state

Use public Pi state wherever available:

- Conversation name: `pi.getSessionName()` / `session_info_changed`; fallback to a concise first-user-message line.
- Model: active `ctx.model.id` (provider shown in muted text when useful).
- Thinking: `ctx.thinkingLevel` / `pi.getThinkingLevel()` and `thinking_level_select`.
- Location: `ctx.cwd`, with home collapsed to `~` and left truncation so the final directory remains visible.
- Context: `ctx.getContextUsage()` (`tokens`, `contextWindow`, `percent`).

Recompute cumulative session totals from all session entries, matching Pi's native accounting:

- assistant message usage;
- nested tool-result usage;
- compaction/branch-summary usage;
- input, output, total, cache hit rate, turns, and total cost.

Live metrics:

- session elapsed time from the session header timestamp;
- active tool and elapsed time from tool execution events;
- live output speed from a two-second sliding sample during `message_update`;
- final speed and duration from the last completed assistant response;
- last tool name.

### 3.5 MCP section

- Read the MCP adapter's global and project config locations already used on this machine: shared global, Pi global, `.mcp.json`, and `.pi/mcp.json`.
- Merge server definitions in the same broad precedence order as the adapter for display purposes.
- Read `~/.pi/agent/mcp-cache.json` for cached tool metadata and direct/total tool counts.
- Use the live `mcp` footer status text for aggregate connection/connecting state rather than claiming cached tools prove a live connection.
- Show each configured server name plus direct/total cached tool counts. The per-server glyph represents direct-tool exposure; live connection truth remains the aggregate adapter status because Pi exposes no per-server extension API.
- Refresh config/cache on the shared 15-second refresh and `/sidebar refresh`.

Explicit simplification: v1 will not reproduce the MCP adapter's full import-discovery matrix or inspect private in-memory manager state. Add that only if a real configured server is missing from the displayed merged paths.

### 3.6 `rpiv-todo` section

- Replay the latest active-branch `toolResult` where `toolName === "todo"` and `details` contains `tasks[]` plus numeric `nextId`.
- Ignore `deleted` tombstones.
- Display completed/total counts and status glyphs for pending, in-progress, and completed tasks.
- For in-progress tasks, prefer `activeForm` as the secondary live label.
- Update immediately from `tool_result.details`, then replay on `session_start`, `session_tree`, and `session_compact`.
- Truncate task lines to sidebar width and cap only when terminal height requires it, with an explicit overflow count.

No import from the installed `rpiv-todo` package is needed; consuming its persisted public result shape avoids package-root coupling.

### 3.7 Root and nested Git repositories

1. Resolve the repository containing `ctx.cwd` with `git rev-parse --show-toplevel`.
2. Walk below that root with Node's filesystem API.
3. Add directories containing a real `.git` **directory** as independent nested repositories.
4. Record but exclude directories containing a `.git` **file** (linked worktrees).
5. Prune `.git`, `node_modules`, build/cache/vendor directories, and stop descending once an independent nested repository is found.
6. Filter matching linked-worktree paths from the root repository's untracked rows so excluded worktrees do not reappear as container noise.
7. Run fixed `git` commands through `pi.exec`, never shell-assembled user input.

For each repository:

- branch/detached label from porcelain-v2/branch output or a fixed branch query;
- status code and path for staged, unstaged, renamed, deleted, and untracked files;
- additions/deletions from `git diff --numstat HEAD --` when available;
- clear fallback for unborn branches/binary files.

Rendering:

- root first, then nested repositories sorted by readable relative name;
- always show the root summary; omit clean nested repositories;
- group file rows under the repository header instead of repeating long prefixes;
- left-truncate paths so the basename and suffix remain visible;
- use remaining terminal rows for Git and show `… N more` if the screen cannot display every collected modification.

### 3.8 Height budgeting and section order

Render fixed/compact sections first:

1. Conversation
2. Model / thinking / location
3. Context
4. Stats and tokens
5. MCP
6. Todos
7. Extensions
8. Git (uses the remaining rows)

Empty optional sections collapse to one short line or disappear. Git receives the flexible remainder because it can have the largest list; the state still collects all modifications even when the terminal cannot show every row simultaneously.

## 4. File-by-file impact

- `plans/custom-pi-sidebar-plan.md` — decision record, implementation checklist, deviations, and validation results.
- `extensions/pi-sidebar.ts` — custom sidebar extension and compositor.
- `extensions/pi-sidebar.test.ts` — one runnable Node-assert test covering the non-trivial parsers/layout helpers and compositor cleanup contract.
- `docs/README.md` and `docs/pi-sidebar.md` — only if approved, document installation, commands, sections, Git discovery, known private-API risk, and troubleshooting after implementation is real.
- `~/.pi/agent/settings.json` — updated only through `pi install <stable-repo-file>` after repository validation and landing; no direct hand edit.

## 5. Risks and edge cases

- **Private Pi internals:** a Pi upgrade can rename `tui.doRender` or change terminal behavior. Guard capability checks, fail closed by not installing the compositor, and keep cleanup exact.
- **Compositor conflicts:** another sidebar/custom footer loaded afterward can replace this UI. Remove the two reference sidebars before activation; do not run them together.
- **Terminal compatibility:** synchronized output and save/restore cursor sequences depend on terminal support. Validate in the actual terminal and restore cursor on every disposal path.
- **External editor/resizes:** skip paint while stopped and read raw dimensions for every paint; width getter must use the configured width, never a hard-coded constant.
- **Status capture:** Pi exposes footer statuses only through a custom-footer factory. Another custom-footer extension can supersede this one.
- **Todo load order:** `rpiv-todo` can register its widget during the same startup event. Deferred clearing and post-result clearing are required to keep it hidden.
- **Git scale:** many independent repositories can make refresh expensive. The implementation prevents overlap, caches repository discovery, runs repository reads concurrently, refreshes every 15 seconds, and refreshes after relevant Pi events.
- **Git filenames:** porcelain edge cases include renames, spaces, tabs/newlines, binary files, and unborn branches. Prefer NUL-delimited output where practical and test representative parsing.
- **Finite terminal height:** collected Git changes can exceed visible rows. Preserve counts and filename suffixes; show overflow instead of silently dropping data.
- **MCP truth:** the adapter does not expose per-server live state to other extensions. Do not mislabel cache presence as a live connection.

## 6. Validation / testing

Automated:

- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts`
- `git diff --check`
- `pre-commit run --all-files`

The adjacent test will cover at minimum:

- cumulative usage accounting, including tool/summary usage;
- `rpiv-todo` latest-snapshot replay and deleted-task filtering;
- Git status/numstat parsing, rename/untracked rows, linked-worktree filtering, and filename-preserving truncation;
- sidebar width budgeting;
- compositor install/dispose restoration using a fake terminal/TUI.

Manual proof in Pi:

1. Launch the extension from the task worktree for one test session.
2. Resize above/below the minimum width and verify no overlap or stale painted column.
3. Switch model/thinking; rename the session; run a tool; verify live updates.
4. Create/update/complete `rpiv-todo` tasks; verify sidebar state and hidden original widget.
5. Verify Ponytail appears under `Extensions` and no native footer remains.
6. Verify MCP shows `freecad`, cached `0/14` direct/total data, and the adapter's live aggregate status.
7. Run in this repository and a container-repository fixture; verify root + `tooling` dirty data, independent repo grouping, worktree exclusion, and readable filenames.
8. Open/close an external editor or reload Pi; verify compositor cleanup and visible hardware cursor.

Installation/landing:

- Commit the task branch with a contextual commit after checks pass.
- Merge it into `master` through Worktrunk so the stable primary-checkout file exists without editing the primary checkout directly.
- Run `pi install /home/djipey/informatique/ai/skills_and_commands/extensions/pi-sidebar.ts`.
- Verify the installed settings entry and `pi list`; do not claim activation until a fresh/reloaded Pi session visibly renders it.

## 7. Step-by-step execution checklist

- [x] Inspect both sidebar packages, Pi extension/TUI/package/session docs, screenshots, local status producers, `rpiv-todo`, MCP adapter, repository patterns, and a container-repository Git layout.
- [x] Confirm rendering, relocation, Git scope, and delivery decisions.
- [x] Implement pure formatting, stats, todo, MCP, and Git helpers.
- [x] Implement nested independent-repository discovery and linked-worktree filtering.
- [x] Implement sidebar section renderer with height budgeting.
- [x] Implement compositor install/paint/dispose lifecycle.
- [x] Wire Pi session/model/message/tool/footer/widget events and commands.
- [x] Add the adjacent runnable test.
- [x] Run focused and repository-wide validation.
- [x] Perform manual Pi/terminal container-repository verification.
- [x] Update this plan with completed steps, deviations, and exact validation results.
- [x] Add approved durable docs after implementation.
- [x] Commit, merge through Worktrunk, install from the stable repository path, and verify activation.
- [x] Mark this plan `Completed` with the completion date; never delete it.

## 8. Open questions / assumptions

- Decision: create this repository's first `docs/` directory after implementation, with an index and a focused sidebar guide.
- Validated: width 42 and minimum main width 70 work in the actual tmux-backed Pi TUI; `/sidebar width 50` reflowed correctly, and narrowing below the threshold hid the sidebar without overlap.
- Assumption: independent nested repositories are represented by `.git` directories, while task worktrees use `.git` files, as observed in the reference container repository.
- Assumption: only dirty nested repositories need screen rows; clean nested repositories are still discovered but omitted.
- Assumption: no other custom footer/sidebar should coexist with this extension.
- Deliberate ceiling: nested repository discovery stops descending after finding an independent nested repository. Add recursive repo-inside-repo discovery only if such a layout actually appears.

## Implementation notes and validation results

- The custom footer itself supplies the TUI/theme/footer-status provider, so the planned empty widget was unnecessary.
- Repository discovery is cached and the periodic refresh changed from 5 to 15 seconds after review of the reference container repository's 12 repositories. `/sidebar refresh` forces rediscovery.
- Git, conversation, MCP, and todo plain text is sanitized before raw terminal painting; extension status ANSI is preserved intentionally.
- Parallel active tools are tracked by tool-call id, with elapsed time for the most recently started active tool.
- Two fresh reviewers found test-resolution, terminal-sanitization, unborn-branch, refresh-cost, active-tool, stale-timer, and MCP-merge issues; all were fixed before final validation.

Automated checks completed:

- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts`
- temporary NodeNext `tsc --noEmit` check for the extension and test
- `git diff --check`
- `pre-commit run --all-files` (`gitleaks` passed)

Manual Pi checks completed in 180×40 tmux sessions:

- fixed-column rendering, `/reload`, `/name`, and `/sidebar width 50`;
- automatic hide at 100 columns and restoration at 180 columns;
- live context, cost, token, speed, turn, last-response, and tool metrics after a model turn;
- `rpiv-todo` task display with the original persistent widget absent;
- Ponytail and quota statuses under `Extensions`, with no native footer;
- MCP aggregate status plus `freecad 0/14`;
- task-repository Git rows with readable filenames;
- container root plus dirty `tooling`, with linked worktree/container rows excluded;
- graceful tmux/Pi shutdown for both smoke sessions;
- merge to `master`, `pi install` from the stable primary-checkout path, `pi list` settings resolution, and a fresh Pi launch without `-e` showing the installed sidebar.

Landing and activation:

- contextual feature commit: `6b2cde9 feat(pi): add custom sidebar extension`;
- merged to `master` through Worktrunk;
- installed settings source: `../../informatique/ai/skills_and_commands/extensions/pi-sidebar.ts`;
- stable resolved path: `/home/djipey/informatique/ai/skills_and_commands/extensions/pi-sidebar.ts`.

Not automated: opening a real external editor. The compositor's `tui.stopped` guard and install/dispose restoration are covered by code review and the fake-TUI test.

## Grill record

The user approved implementation without a grill pass after reviewing the plan and its explicit private-TUI risk.
