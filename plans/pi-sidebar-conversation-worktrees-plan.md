# Conversation-aware sidebar worktrees

Status: Implemented — awaiting merge
Date: 2026-07-24

## 1. Brief

Move the compaction count below the weekly quota line, then make clean Git rows reflect this conversation rather than every checkout on disk. Dirty worktrees remain visible; a clean worktree remains visible only after its Git state changed while the current conversation was open, and that memory survives `/reload` for the same session.

## 2. Current state / relevant context

- The Conversation section currently renders `compactions` immediately after `ctx`, before the optional weekly Codex line.
- The Git section always shows the checkout containing Pi's cwd, even when clean. Other clean linked worktrees and clean independent nested repositories are already hidden.
- The sidebar refreshes each repository with `git status` every 15 seconds and after relevant Pi events, so it already has the data needed to observe worktree state changes.
- Pi custom entries created with `pi.appendEntry()` persist extension state without entering LLM context. Reading matching entries from `ctx.sessionManager.getBranch()` restores branch-correct state after `/reload`, `/resume`, compaction, and `/tree` navigation.
- The user chose “worked on” to mean that the sidebar observed the worktree's Git state change while the conversation was open. This intentionally includes manual or external edits during that time.
- A clean worktree merely present at startup, or opened clean by another process, must remain hidden.

Success criteria:

1. With Codex active, `compactions N` renders immediately below the weekly quota line. Without a weekly quota line, it follows `ctx`.
2. Dirty worktrees always render; Git errors remain visible.
3. A clean worktree that has never changed during the current conversation does not render, including the checkout containing Pi's cwd.
4. After a worktree changes from its first observed Git state, it is remembered for this conversation and remains visible if it later becomes clean.
5. Remembered paths survive `/reload` and resume of the same session, while a new conversation starts with no remembered worktrees.
6. `/tree` restores remembered worktrees from the active conversation branch rather than leaking state from an abandoned branch.

## 3. Proposed implementation

### Compaction placement

Build the Conversation rows in this order:

1. title;
2. model;
3. cwd;
4. context;
5. weekly Codex quota, when available;
6. compaction count.

This puts compactions below the weekly line for Codex sessions and directly below context for providers that have no weekly line.

### Worktree observation

Add a small pure helper that receives:

- refreshed `GitRepo` rows;
- the paths Git identified as worktrees for the current repository;
- the previous status signature for each path;
- the set already remembered for this conversation.

For each worktree, derive a deterministic signature from its status rows: status code, current/old path, untracked/binary flags, and additions/removals. The first observation only seeds the baseline. A later signature change marks the path as worked, whether the transition is clean→dirty, dirty→different dirty, or dirty→clean.

Only paths from `git worktree list` plus the current checkout participate. Independent nested repositories keep their existing behavior: dirty is shown, clean is hidden, and they are not remembered as conversation worktrees.

Transient Git errors will not mark a worktree as worked. Their error rows remain visible.

### Session persistence

Use one custom entry type, `pi-sidebar-worktree-worked`, containing `{ path }`.

- When observation first marks a path, add it to the in-memory set and call `pi.appendEntry()` once.
- On `session_start`, reconstruct the set from matching custom entries on `ctx.sessionManager.getBranch()` before the first Git refresh.
- On `session_tree`, reconstruct again from the newly active branch.
- `/reload` creates a new extension instance, which reconstructs from the same session entries.
- A new session has no matching entries and therefore starts empty.

No external state file, watcher, timestamp heuristic, process attribution, or Worktrunk-specific integration is needed.

### Rendering

Replace the current “always show root” condition with:

```text
show repository when dirty
or when Git returned an error
or when its path is remembered for this conversation
```

If no rows qualify, retain the compact section-level `clean` line rather than displaying a clean worktree header.

## 4. File-by-file impact

- `extensions/pi-sidebar.ts` — move the compaction row, track worktree status signatures, persist/replay worked paths, and apply the new clean-row rule.
- `extensions/pi-sidebar.test.ts` — cover row order, first-observation baseline, state transitions, custom-entry replay, branch-safe clean visibility, and unchanged dirty/error behavior.
- `docs/pi-sidebar.md` — document the Conversation row order and conversation-aware clean-worktree behavior.
- `plans/pi-sidebar-conversation-worktrees-plan.md` — retain decisions, validation, deviations, and completion status.

## 5. Risks and edge cases

- **Changes between observations:** if a worktree changes and returns to an identical status before any refresh sees it, the sidebar cannot know it was worked on. Edit/write events and the 15-second refresh reduce this window without adding a file watcher.
- **External activity:** the chosen definition is time-based Git-state change, not process attribution. Manual or external state changes during the open conversation count as worked.
- **Dirty baseline:** a worktree already dirty on first observation is shown because it is dirty, but is not remembered until a later observed status change. If it later becomes clean, that transition remembers it.
- **New worktree:** a newly discovered clean worktree seeds a baseline and remains hidden. A newly discovered dirty worktree is shown immediately but becomes remembered only after a later status change.
- **Reload:** persisted worked paths restore, but in-memory status signatures restart from a fresh baseline. This does not lose already remembered paths.
- **Tree navigation:** replay only the active branch. Custom entries from abandoned branches must not affect the current branch.
- **Path reuse:** persistence identifies a worktree by its resolved absolute path. Reusing the exact path for a different worktree within one conversation could inherit visibility; add Git metadata identity only if this rare case appears.
- **Session entries:** each worktree produces at most one small custom entry per conversation branch, preventing periodic refresh noise.

## 6. Validation / testing

Automated:

- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts`
- `git diff --check`
- `pre-commit run --all-files`

Focused assertions:

- weekly quota precedes `compactions`;
- providers without quota still show compactions after context;
- first clean and first dirty observations do not create conversation memory;
- clean→dirty, dirty→clean, and changed dirty signatures create memory exactly once;
- replay accepts only valid `pi-sidebar-worktree-worked` custom entries on the supplied branch;
- untouched clean current and sibling worktrees are hidden;
- remembered clean worktrees, dirty worktrees, and error rows remain visible.

Live tmux-backed Pi smoke test:

1. start with clean primary and clean sibling worktrees; verify only the section-level `clean` row appears;
2. dirty one sibling; verify it appears;
3. refresh so the state change is observed, then clean it; verify its header and `clean` row remain;
4. `/reload`; verify the remembered clean sibling remains;
5. verify `week` is followed by `compactions` and `/sidebar status` still reports width 48.

## 7. Step-by-step execution checklist

- [x] Inspect sidebar Git/rendering flow and Pi extension/session persistence APIs.
- [x] Confirm that observed Git-state change, including external edits, defines “worked on.”
- [x] Establish the clean-current-checkout assumption from the user's “no clean worktrees except worked” rule.
- [x] Get plan approval; the user chose direct implementation without a grill pass.
- [x] Move compactions after the weekly quota row.
- [x] Add pure status-signature observation and focused tests.
- [x] Persist newly worked paths with custom session entries.
- [x] Replay worked paths on session start and tree navigation.
- [x] Apply conversation-aware clean-row rendering.
- [x] Update durable sidebar documentation.
- [x] Run focused and repository-wide checks.
- [ ] Merge into the installed primary source.
- [ ] Record the merged commit and mark this plan completed.

## 8. Open questions / assumptions

- Decision: “worked on” means an observed Git-state change during the open conversation, regardless of which local process caused it.
- Assumption: the checkout containing Pi's cwd follows the same rule as linked worktrees: if it is clean and untouched, its header is hidden. The Git section still shows one section-level `clean` line when nothing qualifies.
- Decision: worktree memory persists in the Pi session and follows the active session branch.
- Decision: independent nested repositories are not retained after becoming clean because the request specifically concerns Git worktrees.
- Non-goal: identify the exact process or Pi tool that changed a worktree.
- Non-goal: retain worked worktrees across separate conversations.

## Implementation notes and validation results

- The Conversation renderer now appends `compactions` after the optional weekly quota row, preserving direct context→compactions order for non-Codex providers.
- Worktree observation compares deterministic Git status signatures only after an initial baseline. Errors retain the previous signature without creating false conversation activity.
- Newly worked paths append one `pi-sidebar-worktree-worked` custom entry and replay from the active session branch on startup, reload, compaction, and tree navigation.
- Rendering no longer grants the cwd checkout a clean exception. Untouched clean worktrees collapse to the section-level `clean` row; remembered clean worktrees retain their checkout header.

Checks completed:

- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts`
- `git diff --check`
- `pre-commit run --all-files` (`Detect hardcoded secrets` passed)
- A fresh 180×40 tmux Pi smoke test with a temporary primary/sibling worktree pair verified: initial clean worktrees hidden; dirty sibling shown; cleaned sibling retained; retained sibling still shown after `/reload`; `week` immediately followed by `compactions`.
- A second smoke test loaded a persisted session file and confirmed exactly one `pi-sidebar-worktree-worked` entry with the sibling's absolute path.

## Grill record

The user approved direct implementation without a grill pass after choosing observed Git-state changes as the definition of conversation work.
