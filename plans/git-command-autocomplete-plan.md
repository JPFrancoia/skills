# `/m` and `/pr` repository autocomplete

Status: Completed and activated on 2026-07-26
Date: 2026-07-26

## 1. Brief

Add argument autocomplete to `/m` and `/pr` so typing either command plus a space shows repositories that currently have staged changes. The dropdown will cover the current checkout, its linked worktrees, independent repositories below it, and linked worktrees belonging to those repositories, making the existing background commit and PR workflows discoverable without manually entering paths.

## 2. Current state / relevant context

- `extensions/pi-background-commit.ts` and `extensions/pi-background-pr.ts` already register `/m` and `/pr`, but both explicitly set `getArgumentCompletions: () => null`.
- Both handlers require staged changes and already accept direct paths plus unique worktree directory or branch selectors.
- Pi's installed `registerCommand` API allows `getArgumentCompletions` to return `Promise<AutocompleteItem[] | null>`, but the callback receives only the current argument text, not `ExtensionContext`.
- `session_start` does provide `ctx.cwd`, so each extension can retain the active conversation cwd for later completion calls.
- `extensions/pi-sidebar.ts` already establishes the repository-discovery pattern used in this workspace: scan below the root checkout for independent `.git` directories, ignore linked-worktree `.git` files during that scan, then ask Git for every worktree belonging to each repository.
- The globally installed `/m` and `/pr` extensions are symlinked single files. Their Git helpers are intentionally self-contained because a new relative shared-module dependency would also need installation and could resolve differently through the symlinks.

Success criteria:

1. Typing `/m ` or `/pr ` opens a dropdown when at least one discovered checkout has staged changes.
2. Suggestions include the current checkout, linked worktrees in its Git family, independent repositories below it, and linked worktrees in those nested repository families.
3. Clean, unstaged-only, untracked-only, bare, missing, and Git-error targets are not suggested because the commands cannot currently act on them.
4. Selecting a suggestion inserts a path that the existing direct-path-first resolver accepts without ambiguity, including paths outside the conversation root and paths containing spaces.
5. Typing part of a path, checkout name, or branch narrows the suggestions; no matches return `null` so Pi can close the dropdown normally.
6. `/m` and `/pr` retain their existing staged-change preflight, async subagent contracts, notifications, and manual path/worktree selector behavior.

## 3. Proposed implementation

### Capture the completion cwd

In each extension, keep the latest `ctx.cwd` from `session_start`. Reset a lazily created repository-target promise whenever a session starts or reloads. This follows Pi's lifecycle instead of assuming `process.cwd()` always equals the active session cwd.

### Discover candidate checkouts

When autocomplete is first requested in a session:

1. Resolve the Git root containing the captured cwd with `git rev-parse --show-toplevel`.
2. Walk downward from that root using `node:fs/promises`, pruning the same generated/dependency directories as the sidebar.
3. Record directories with a `.git` directory as independent repositories and stop descending into them.
4. Ignore `.git` files during the scan because they are linked worktrees that Git will enumerate authoritatively.
5. For the root and every independent repository, run `git worktree list --porcelain -z` and parse each non-bare checkout's absolute path and optional short branch.
6. Deduplicate checkouts by resolved absolute path.

Cache only this checkout topology for the session. Completion calls will still re-run the staged-index check, so suggestions reflect newly staged or committed changes immediately. `/reload` refreshes topology after worktrees or nested repositories are added or removed.

### Build live suggestions

For every cached checkout, run:

```text
git -C <checkout> diff --cached --quiet --exit-code
```

Keep only exit code `1`, which means staged differences exist. Format each `AutocompleteItem` with:

- `value`: a cwd-relative path (or `.` for the current checkout), quoted when whitespace requires it;
- `label`: a concise checkout/repository name;
- `description`: the short branch or `detached`, plus the path when needed to distinguish similar names.

Filter case-insensitively against the insertion value, label, branch, and absolute path. Sort the current checkout first and the remaining items by their displayed path. Return `null` when discovery fails, no checkout is committable, or the typed prefix matches nothing.

The completion path remains the command argument. No custom dropdown component or autocomplete-provider wrapper is needed; Pi's native command autocomplete already supplies the requested dropdown.

### Preserve single-file installation

Keep equivalent small discovery/completion helpers in the two extension files, matching the existing duplicated resolver pattern. Do not add a shared module, dependency, event-bus coupling to the sidebar, configuration file, or persistent cache.

## 4. File-by-file impact

- `extensions/pi-background-commit.ts` — capture session cwd, discover root/nested repository worktrees, filter staged checkouts, and return native argument completions for `/m`.
- `extensions/pi-background-commit.test.ts` — capture the registered completion callback and cover candidate discovery, staged-only filtering, prefix matching, quoting, deduplication, and failure/no-match behavior.
- `extensions/pi-background-pr.ts` — add the equivalent completion behavior for `/pr` without changing its PR workflow.
- `extensions/pi-background-pr.test.ts` — mirror the completion assertions while preserving existing PR launch tests.
- `docs/background-git-commands.md` — document the dropdown scope, staged-only filtering, selection behavior, and `/reload` requirement after repository topology changes.
- `plans/git-command-autocomplete-plan.md` — retain decisions, progress, deviations, validation, activation, and completion status.

The fallback prompt templates in `commands/m.md` and `commands/pr.md` do not change: autocomplete belongs to the extensions, and their existing selector instructions remain accurate when an extension is unavailable.

## 5. Risks and edge cases

- **Autocomplete latency:** nested discovery and Git checks are asynchronous. Cache checkout topology, prune generated/dependency trees, use short command timeouts, and refresh only staged-index state on each completion request.
- **Topology changes during a session:** a newly created worktree or nested repository will not appear after the first autocomplete discovery until `/reload`. This avoids rescanning the entire tree on every keystroke.
- **Staged state changes:** staged checks are not cached, so staging, committing, or resetting changes updates the next completion result.
- **Spaces in paths:** Pi inserts `item.value` verbatim; quote whitespace-containing paths so the existing `repoArgument` parser passes the full path to the handler.
- **Duplicate basenames or branches:** completion inserts direct paths rather than aliases, so selection remains unambiguous even when labels repeat. Descriptions expose the distinguishing path.
- **Detached worktrees:** include them when staged and describe them as detached.
- **Bare repositories:** exclude them because the commands require a working tree and index.
- **Nested linked worktrees inside a parent checkout:** ignore their `.git` files during filesystem discovery and rely on the owning repository's `git worktree list`, preventing duplicates and incorrect ownership.
- **Repository/permission errors:** omit failed candidates and return `null` if root discovery fails; autocomplete must not emit noisy notifications while the user types.
- **PR feasibility:** `/pr` completion mirrors the command's current precondition—staged changes. It will not preflight remotes, hosting provider authentication, branch policy, or CI because the existing child workflow owns those checks.

## 6. Validation / testing

Automated checks:

- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-background-commit.test.ts`
- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-background-pr.test.ts`
- strict temporary `tsc --noEmit` against Pi's installed extension types;
- extension import checks;
- `git diff --check`;
- `pre-commit run --all-files`.

Focused assertions:

- empty prefix returns every staged current/nested/worktree candidate and excludes clean candidates;
- typed path/name/branch prefixes narrow the list;
- direct insertion values resolve relative to the captured session cwd;
- paths containing spaces are quoted and remain accepted by `repoArgument`;
- bare worktrees, duplicate paths, nested `.git` files, failed Git commands, and no-match cases are handled without suggestions;
- session start resets the cached topology for a replacement cwd;
- existing `/m` and `/pr` handler tests continue to prove exact-root staged checks and async child launch contracts.

Manual TUI proof after merging into the canonical source and running `/reload`:

1. prepare staged changes in the current checkout, one linked worktree, and one independent nested repository;
2. type `/m ` and verify all three appear while clean repositories do not;
3. choose each kind of target and verify the inserted argument resolves to the intended checkout without launching by cancelling before Enter;
4. repeat with `/pr ` and a typed branch/path prefix;
5. commit or unstage one target and verify it disappears on the next completion request;
6. add a temporary worktree, verify `/reload` makes it appear, then remove the temporary fixture safely.

## 7. Step-by-step execution checklist

- [x] Get plan approval; the user chose direct implementation without a `grill` pass.
- [x] Create dedicated implementation worktree `../skills_and_commands.feat-git-command-autocomplete` before changing extension/test files.
- [x] Add async staged-repository completions to `/m`.
- [x] Add focused `/m` completion tests while preserving handler tests.
- [x] Apply the equivalent minimal change to `/pr`.
- [x] Add focused `/pr` completion tests.
- [x] Run focused tests, strict TypeScript validation, and import checks.
- [x] Update current-state command documentation.
- [x] Run repository hygiene checks.
- [x] Obtain fresh read-only reviews and add the requested session-cache reset coverage.
- [x] Merge implementation commit `d8f3383` into the canonical source, run `/reload`, and complete the manual TUI proof.
- [x] Mark this plan completed with the final validation and activation record.

## 8. Open questions / assumptions

- Assumption: “can be committed or made into a PR” means the checkout has staged changes, matching both commands' current hard precondition.
- Assumption: both commands should show the same candidates because `/pr` already includes the commit step.
- Decision: include the current checkout, linked worktrees for every discovered repository family, and independent repositories below the root checkout.
- Decision: insert direct relative paths rather than worktree aliases so every selection is unambiguous and works for nested-repository worktrees.
- Decision: cache repository/worktree topology per session but refresh staged state for every completion request.
- Decision: keep completion silent on discovery errors and let the existing command handler provide explicit errors after execution.
- Non-goal: add general filesystem path completion, auto-stage files, inspect unstaged/untracked work, or preflight remote PR eligibility.

## Implementation notes and validation results

- `/m` and `/pr` now use Pi's native async argument completion callback. Repository/worktree topology is discovered lazily once per session and reset on `session_start`; staged indexes are checked on every completion request.
- Suggestions insert cwd-relative direct paths, quote whitespace-containing paths, search by path/name/branch, and describe each checkout with its short branch and path.
- Both extension tests cover staged-only results, quoting, case-insensitive branch filtering, nested repository discovery, pruned and linked-worktree directories, command registration, exact Git calls, and topology reset after a replacement session.
- Focused `jiti` tests, strict temporary `tsc --noEmit`, extension import checks, `git diff --check`, and `pre-commit run --all-files` passed from the canonical merged source.
- A first reviewer found no implementation blocker and requested explicit cache-reset coverage and documentation visibility; the tests were extended and the documentation already existed in the canonical checkout. A final fresh reviewer found no fixes needed.
- `docs-maintainer` reviewed `docs/background-git-commands.md` against the implementation and confirmed no further edits or index changes were needed.
- A 180×42 tmux TUI proof showed both `/m ` and `/pr ` dropdowns listing staged current, sibling-worktree, and nested-repository targets. A second global-extension session ran `/reload` and showed the live `/m ` dropdown from the canonical symlinked source.
- Follow-up diagnosis of a missing live `/pr` dropdown found duplicate resources: the extension callback returned the staged worktree correctly, but Pi selected the same-named prompt-template entry, which has no argument completions. The live `~/.pi/agent/prompts/m.md` and `pr.md` fallback symlinks were removed; the repository fallback files remain available for setups without the extensions.
- A normal global-resource tmux session with prompt discovery enabled then verified `/reload`, `/m `, and `/pr ` autocomplete against the real `green_slope` nested Infra worktree.
- Manual proof focused on the requested dropdown and target coverage. Clean-target exclusion, prefix filtering, quoted insertion, and staged-state refresh remain covered by the automated checks rather than destructive command execution.
