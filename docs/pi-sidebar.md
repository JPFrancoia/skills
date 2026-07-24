# Custom Pi sidebar

`extensions/pi-sidebar.ts` replaces Pi's footer with a fixed right column. Pi's transcript and editor reflow into the remaining width, so sidebar content does not cover them.

## Install

```bash
pi install /home/djipey/informatique/ai/skills_and_commands/extensions/pi-sidebar.ts
```

Reload an open Pi session with `/reload`, or start a new session. Do not load this extension together with `pi-sidebar-tui`, `@esso0428/pi-sidebar`, another custom footer, or another extension that reserves terminal columns.

## Displayed data

- conversation name, with the first user message as fallback;
- model, thinking level, cwd, and context use;
- elapsed time, last response duration, output speed, turns, cost, tokens, cache hit rate, and active/last tool;
- MCP adapter status and cached direct/total tool counts per configured server;
- `rpiv-todo` tasks from the active session branch;
- footer indicators from other extensions, including Ponytail;
- Git changes in the root repository and dirty independent repositories below it.

The native footer and `rpiv-todo`'s above-editor widget are hidden because their data is shown in the sidebar.

## Commands

```text
/sidebar                 Toggle the sidebar
/sidebar on              Show it
/sidebar off             Hide it
/sidebar width 50        Set width for this process (20–80)
/sidebar refresh         Rediscover repositories and refresh Git/MCP data
/sidebar status          Show current state, width, and repository count
```

The default width is 42 columns. The sidebar automatically hides when showing it would leave fewer than 70 columns for Pi.

## Git discovery

The repository containing Pi's cwd is the root. Below it, directories containing their own `.git` directory are independent repositories and are included. Linked worktrees use a `.git` file; they and their untracked container rows are intentionally excluded.

The root is always shown. Clean nested repositories are omitted. Files are grouped under their repository and long paths are shortened from the left so the filename remains readable. When the terminal is too short, the sidebar reports how many rows remain undisplayed.

Git/MCP state refreshes every 15 seconds and after relevant Pi events. `/sidebar refresh` forces repository rediscovery.

## MCP status

Pi does not expose another extension's per-server live MCP connection objects. The sidebar therefore uses:

- the MCP adapter's live aggregate footer status for connection state;
- MCP config/cache files for server names and direct/total tool counts.

A cached tool count is not presented as proof that a server is currently connected.

## Compatibility and troubleshooting

Pi currently has no public API for a non-overlapping persistent side column. This extension wraps private `tui.doRender` and `terminal.columns` fields, then restores them on reload or shutdown. A future Pi upgrade can break that contract.

If the sidebar disappears after an upgrade:

1. run `/reload` and read the warning notification;
2. verify no other sidebar or custom-footer extension is loaded;
3. run the adjacent test:

   ```bash
   ~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts
   ```

4. launch once from source with `pi -e extensions/pi-sidebar.ts`.

The compositor skips painting while Pi's TUI is stopped for an external editor and restores the terminal cursor during disposal.
