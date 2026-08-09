# Custom Pi sidebar

`extensions/pi-sidebar.ts` replaces Pi's footer with a fixed right column. Pi's transcript and editor reflow into the remaining width, so sidebar content does not cover them.

## Install

```bash
pi install /home/djipey/informatique/ai/skills_and_commands/extensions/pi-sidebar.ts
```

Reload an open Pi session with `/reload`, or start a new session. Do not load this extension together with `pi-sidebar-tui`, `@esso0428/pi-sidebar`, another custom footer, or another extension that reserves terminal columns.

## Displayed data

- conversation name, with the first user message as fallback;
- model, thinking level, cwd, context use, conversation compaction count, turns, and cost;
- a weekly Codex headroom bar and reset countdown when Codex is active and account usage is available;
- running foreground `subagent` tool children and detached async children from the active session;
- `rpiv-todo` tasks from the active session branch;
- footer indicators from other extensions, including Ponytail;
- Git changes in the current checkout, dirty worktrees from that repository and discovered independent nested repositories, and dirty independent repositories below it.

The native footer and `rpiv-todo`'s above-editor widget are hidden because their data is shown in the sidebar.

## Subagents

The **Subagents** section appears directly after Conversation and keeps one row for every agent used in the active Pi session branch. This includes foreground calls, detached runs, and nested descendants that pi-subagents reports. Rows remain after a child stops and survive reload, compaction, and `/tree` navigation within that branch. A green dot means at least one invocation of that agent is running; a red dot means none are running. Each row shows cumulative child runtime and cost for that agent's invocations (`1m46s · $0.4660`); parallel child durations are summed. Pending top-level children are not listed, and totals do not carry across Pi sessions. The section refreshes every second and shows `(none used)` until a child starts.

Async metrics use pi-subagents' validated run status. The sidebar accepts lifecycle versions 2 and 3, plus the unversioned workflow status from pi-subagents 0.45. Running state also uses event-bus RPC `data.fleet` version 1 as an ephemeral zero-metric fallback. A `subagent` call that omits `async` runs in the background with pi-subagents 0.41. Missing or invalid status data leaves recorded rows and totals intact. Use `/subagents-fleet` for detailed run inspection and controls.

The weekly Codex bar is the overall account percentage remaining, not usage attributed to the current conversation. Its value starts in the same column as the context percentage and ends with `resets in Xd`, or `resets in Xh` below one day. The conversation compaction count appears directly beneath it, or beneath context usage when Codex quota is not shown. Turns and cost follow directly below the compaction count. The extension resolves the current Codex OAuth token through Pi and queries OpenAI's account-usage endpoint at session start, after completed agent runs, on Codex model selection, and on `/sidebar refresh`. Tokens and responses remain in memory and are never logged or persisted. The bar shows `loading…` or `unavailable` when authentication, the request, or the response fails.

## Commands

```text
/sidebar                 Toggle the sidebar
/sidebar on              Show it
/sidebar off             Hide it
/sidebar width 50        Set width for this process (20–80)
/sidebar refresh         Refresh Codex quota, Git data, and repository discovery
/sidebar status          Show current state, width, and repository count
```

The default width is 53 columns. The sidebar automatically hides when showing it would leave fewer than 70 columns for Pi.

## Git discovery

Git's native worktree list is refreshed for the checkout containing Pi's cwd and for every discovered independent repository below it. This includes sibling and nested-repository worktrees outside the current directory tree. Dirty worktrees are always shown. The checkout containing Pi's cwd remains visible when clean; other clean worktrees are hidden unless their Git status changed while the current Pi conversation was open, after which they remain visible as clean for that conversation. This memory is stored in the Pi session, survives `/reload`, and follows the active `/tree` branch. A clean worktree that was merely present at startup or opened by another process remains hidden.

Below the current checkout, directories containing their own `.git` directory become independent repository groups. Their primary checkouts and linked worktrees follow the same dirty and conversation-memory rules. Linked-worktree container rows are filtered from the status of the repository that owns them instead of appearing as untracked directories.

Files are grouped under their checkout or repository, and long paths are shortened from the left so the filename remains readable. If the current checkout is clean and no other worktree or nested repository qualifies, the Git section shows its header and one compact `clean` row. When the terminal is too short, the sidebar reports how many rows remain undisplayed.

Git worktree membership and Git state refresh every 15 seconds and after relevant Pi events. `/sidebar refresh` also forces independent-repository rediscovery.

## Compatibility and troubleshooting

Pi currently has no public API for either a non-overlapping persistent side column or Codex account quota. This extension wraps private `tui.doRender` and `terminal.columns` fields and reads the undocumented Codex `/backend-api/wham/usage` endpoint, then restores the TUI fields on reload or shutdown. A future Pi or OpenAI change can break either contract; quota failures degrade to `unavailable`.

If the sidebar disappears after an upgrade:

1. run `/reload` and read the warning notification;
2. verify no other sidebar or custom-footer extension is loaded;
3. run the adjacent test:

   ```bash
   ~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts
   ```

4. launch once from source with `pi -e extensions/pi-sidebar.ts`.

The compositor skips painting while Pi's TUI is stopped for an external editor and restores the terminal cursor during disposal.
