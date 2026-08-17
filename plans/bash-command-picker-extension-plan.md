# Bash command picker Pi extension plan

Status: Implemented
Date: 2026-08-17

## 1. Brief

Build a small Pi extension that copies every fenced assistant code block. The picker splits only `bash` and `shell` blocks into logical commands. It copies every other block as one unit. The extension uses an `F2` picker and does not alter assistant messages or model context.

## 2. Current state / relevant context

- Target directory: `/home/djipey/informatique/ai/skills_and_commands/extensions`.
- Existing local extension style: single-file TypeScript (`extensions/pi-sqz-auto.ts`) with comments explaining symlink/install usage.
- Pi supports:
  - `pi.registerShortcut()` for commandless keyboard triggers.
  - `ctx.ui.custom(..., { overlay: true })` for picker overlays.
  - `copyToClipboard()` exported by `@earendil-works/pi-coding-agent`.
  - `message_end` can replace assistant messages, but doing so would persist decorative icons into the session/context.
- Pi does not expose a documented hook to override or augment built-in assistant-message Markdown rendering with clickable per-line controls.

## 3. Proposed implementation

Create `extensions/pi-bash-command-picker.ts`.

Behavior:

1. On shortcut, inspect the current session branch.
2. Find assistant messages, newest first.
3. Extract every non-empty fenced code block.
4. Add a clearly labeled `COPY ENTIRE BLOCK` choice for each block. The copied text ends with one newline.
5. Split only `bash` and `shell` blocks into logical commands. Add those choices after the whole-block choice.
6. Keep every other block as one copy choice. Do not split its lines.
7. Show an overlay picker with one-line previews and optional full previews.
8. Copy the selected command or block to the clipboard.

Trigger:

- Primary: keyboard shortcut `f2`.
- No slash command was added. The user's preference is no command, and the footer/status hint exposes the shortcut.

Logical command splitting rules for `bash` and `shell` blocks:

- Keep multi-line commands together when lines end with `\`.
- Keep heredocs together from `<<EOF`/`<<'EOF'`/`<<-EOF` until the delimiter line.
- Treat simple variable assignments as separate commands.
- Ignore empty lines and full-line comments.
- Do not parse shell grammar fully. For complex blocks, select the whole block.

UI:

- Overlay title: `code blocks & commands` plus choice count.
- Rows: newest blocks first. Each starts with `▣ COPY ENTIRE BLOCK`. `bash` and `shell` rows show their command count and individual commands.
- Keys: up/down navigate, Enter copy, Space/Tab full preview, Esc cancel.
- Footer and notification distinguish whole-block copying from single-command copying.

## 4. File-by-file impact

- `extensions/pi-bash-command-picker.ts` — extension with block extraction, shell parsing, picker UI, and shortcut registration.
- `extensions/pi-bash-command-picker.test.ts` — focused tests for block extraction and command-splitting boundaries.
- No package/config changes unless the user wants this auto-loaded from settings. Existing install style can be symlink/copy into `~/.pi/agent/extensions/` followed by `/reload`.

## 5. Risks and edge cases

- Clickable icon at end of line: likely not supported by Pi's public renderer API for built-in assistant messages. Rewriting assistant text to add icons is possible but wrong: it persists decoration into sessions and LLM context, and the icon still would not be clickable.
- Shell parsing is hard. V1 deliberately supports common command shapes instead of a full shell AST.
- Multi-line `if/for/while` blocks may split imperfectly unless line continuations or heredocs make boundaries obvious.
- Clipboard support depends on Pi's `copyToClipboard()`, matching `/copy` behavior.
- Whole blocks are not rewritten with `&&` or `set -e`; they retain the assistant's intended shell semantics and therefore continue after ordinary command failures unless the block itself says otherwise.
- Terminal bracketed-paste settings may require one explicit Enter press; the copied block includes a final newline so all lines, including the last, are ready to execute.

## 6. Validation / testing

- Add a tiny self-test block in the extension gated behind a local helper? Prefer a separate `node`/`tsx` test only if the repo already has TypeScript tooling; it does not.
- Practical validation:
  - Run `pi -e /home/djipey/informatique/ai/skills_and_commands/extensions/pi-bash-command-picker.ts`.
  - Ask Pi to output a `bash` block containing simple commands, continuations, and a heredoc.
  - Press the shortcut and verify the picker lists individual commands.
  - Copy one command and paste into another terminal/editor to verify raw text.

## 7. Step-by-step execution checklist

- [x] Implement extraction helpers.
- [x] Implement command splitter with continuation + heredoc support.
- [x] Implement overlay picker component.
- [x] Register `f2` shortcut.
- [x] Smoke-test with TypeScript import/type syntax if a checker is available; otherwise run via `pi -e` instructions.
- [x] Add a visually distinct whole-block choice for every shell block.
- [x] Preserve whole-block content and append a final newline for terminal execution.
- [x] Add whole-block copying for every fenced code block.
- [x] Split only `bash` and `shell` blocks into commands.
- [x] Add focused tests for typed and untyped blocks.
- [x] Update this plan with actual validation results.

Validation completed:

- Temporary TypeScript configuration with `npx tsc`; it checked `extensions/pi-bash-command-picker.ts`.
- `node` ran `extensions/pi-bash-command-picker.test.ts` from a temporary copy with Pi package symlinks.
- The test checked `bash`, `shell`, `typescript`, `sh`, and untyped blocks.

## 8. Open questions / assumptions

- Assumption: a keyboard shortcut is acceptable as the commandless trigger because clickable inline icons are not exposed by Pi today.
- Assumption: latest assistant responses are enough, but the implementation scans all assistant messages in the active branch newest-first.
- Decision: split only `bash` and `shell` blocks. Other languages do not have shell command boundaries.
- Decision: copy whole blocks unchanged rather than joining commands with `&&` or adding `set -e`; changing failure behavior would alter the assistant's command sequence.
- Decision: append a final newline to whole-block clipboard text so the final command is executable as part of the paste.

## Grill option

Before implementation, we can use the `grill` skill to challenge this plan against Pi's extension APIs and existing local conventions. Recommendation: skip grill for v1; this is a small extension and the main API limitation is already clear.
