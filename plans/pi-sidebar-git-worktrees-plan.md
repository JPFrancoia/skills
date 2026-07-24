# Worktree-aware Pi sidebar Git section

Status: Implemented — awaiting live reload verification
Date: 2026-07-24

## 1. Brief

Make the sidebar report changes from the current repository’s whole Git worktree set, not only the checkout containing Pi’s cwd. The current checkout will remain visible even when clean, while clean sibling worktrees stay hidden so active task branches are visible without filling the sidebar.

## 2. Current state / relevant context

- `extensions/pi-sidebar.ts` resolves `git rev-parse --show-toplevel`, refreshes that checkout, and scans below it for independent nested repositories.
- The scanner recognizes `.git` files as linked worktrees only to exclude them and their root-container noise. It never refreshes those paths, and it cannot discover normal sibling worktrees outside the current checkout.
- As a result, a clean primary checkout renders `clean` while changes being made in sibling task worktrees are invisible.
- Git already exposes the authoritative set through `git worktree list --porcelain -z`; filesystem inference should not be used to reconstruct that set.
- The user selected the current repository’s worktree set only. Worktrees belonging to independent nested repositories remain outside scope.
- The user selected compact rendering: always show the current checkout, show sibling worktrees only when dirty or errored, and omit clean siblings.
- The concurrent quota tasks landed on `master` as `223d4f4` and `dbab220` during implementation. This task fast-forwarded through both commits before landing, preserving the weekly quota and reset-time features.

Success criteria:

1. From either the primary checkout or a linked checkout, the Git section obtains every worktree associated with that repository, including siblings outside the current directory tree.
2. Each dirty worktree is refreshed with its own cwd, branch, status rows, and numstat data.
3. The checkout containing Pi’s cwd remains visible when clean; clean sibling worktrees are omitted.
4. Existing independent nested-repository discovery and linked-container noise filtering continue to work.
5. Worktree enumeration failure degrades to the current checkout instead of blanking the Git section.

## 3. Proposed implementation

### Worktree enumeration

Add one small parser for `git worktree list --porcelain -z` output. It will collect each absolute `worktree <path>` record and ignore `HEAD`, `branch`, `detached`, `bare`, `locked`, and `prunable` metadata because branch/status already come from `git status` in each checkout.

During each Git refresh:

1. Resolve the checkout containing `ctx.cwd` as today.
2. Run `git worktree list --porcelain -z` from that checkout.
3. Use the current checkout as the fallback when the command fails or returns no paths.
4. Refresh the current checkout first, followed by its other worktrees and the already-discovered independent nested repositories, with duplicate paths removed.

Worktree enumeration will run on every 15-second Git refresh because it is a cheap Git metadata read and avoids stale rows after a worktree is added or removed. The existing filesystem scan for independent nested repositories remains cached until `/sidebar refresh`.

### Rendering and labels

Reuse `refreshOneRepo` for every worktree. Its existing `git status` and `git diff --numstat` calls already operate correctly when `cwd` points at a linked checkout.

- Keep the current checkout’s existing root label.
- Keep relative labels for other paths; existing filename-preserving truncation reduces long outside-root paths to their final directory when space is tight.
- Change the clean-row decision to compare `repo.path` with `state.rootRepo`, rather than comparing labels. This makes “always show current checkout” explicit and prevents a sibling with a coincidentally matching basename from being shown as if it were the root.
- Keep filesystem-discovered `.git` file paths only for filtering linked-worktree container rows out of the current checkout’s status.

No new dependency, worktree state model, configuration option, or Worktrunk-specific command is needed.

## 4. File-by-file impact

- `extensions/pi-sidebar.ts` — parse Git’s worktree list, enumerate it during refresh, include sibling worktree paths in repository refresh, and identify the always-visible checkout by path.
- `extensions/pi-sidebar.test.ts` — add focused assertions for NUL-delimited worktree parsing, external paths, metadata tolerance, and current-checkout rendering behavior.
- `docs/pi-sidebar.md` — replace the documented worktree exclusion with the implemented current-checkout-plus-dirty-siblings behavior and refresh semantics.
- `plans/pi-sidebar-git-worktrees-plan.md` — retain this decision record, implementation checklist, deviations, and validation results.
- `docs/README.md` — no change expected because the existing sidebar document remains the only durable guide.

## 5. Risks and edge cases

- **Paths outside the checkout:** worktree paths are absolute and may be anywhere on disk. Pass them only as `cwd` to fixed `pi.exec` argument arrays; do not construct shell commands.
- **Missing/pruned worktrees:** a worktree can disappear between enumeration and status. Preserve the existing per-repository error row rather than failing the full refresh.
- **Bare repositories:** the sidebar begins from a working checkout, so a bare metadata row returned by Git is not useful to `git status`; ignore entries without a usable worktree directory if this appears in testing.
- **Duplicate current path:** normalize with `resolve()` and deduplicate before refreshing so the current checkout is not rendered twice.
- **Nested repositories:** only the current repository’s worktree set is added. Discovering worktree sets for every independent nested repository is intentionally deferred because the user chose the narrower scope.
- **Sidebar height:** many dirty sibling worktrees can consume the Git section. Existing height budgeting and overflow rows apply; clean siblings remain hidden.
- **Concurrent sidebar branches:** `sidebar-weekly-quota-bar` was integrated before this implementation continued. A later `sidebar-quota-alignment` worktree now overlaps the extension and test; keep both tasks isolated and integrate whichever lands second.

## 6. Validation / testing

Automated checks:

- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts`
- `git diff --check`
- `pre-commit run --all-files`

Focused test coverage:

- parse multiple `worktree` records from real NUL-delimited porcelain shape;
- retain sibling paths outside the current checkout;
- ignore branch/detached/locked/prunable metadata;
- keep the current checkout visible while omitting a clean sibling;
- preserve existing linked-container filtering and repository discovery assertions.

Manual proof after implementation:

1. Create changes in a sibling linked worktree while the primary checkout is clean.
2. Run Pi from the primary checkout and verify the Git section shows the dirty sibling with its branch and files.
3. Verify a clean sibling is omitted and the clean current checkout remains visible.
4. Run Pi from a linked checkout and verify that checkout becomes the always-visible entry while dirty siblings remain visible.
5. Run `/sidebar refresh` and verify added/removed worktrees are reflected without restarting Pi.

## 7. Step-by-step execution checklist

- [x] Trace the existing Git discovery, refresh, rendering, tests, documentation, and prior sidebar decisions.
- [x] Confirm scope: current repository’s full worktree set, not nested repositories’ worktree sets.
- [x] Confirm rendering: current checkout always visible; clean sibling worktrees hidden.
- [x] Get plan approval; the user chose direct implementation without a grill pass.
- [x] Add the porcelain worktree parser and focused test.
- [x] Enumerate and deduplicate worktrees during each Git refresh.
- [x] Refresh sibling worktrees through the existing repository status path.
- [x] Make clean-entry rendering use repository paths rather than label equality.
- [x] Run the focused extension test.
- [x] Update implemented-behavior documentation.
- [x] Run repository hygiene checks.
- [x] Record deviations and exact validation results, then mark this plan completed.
- [ ] Commit and merge after the user reported that `/reload` still loaded the unchanged primary-checkout source.
- [ ] Verify the installed source contains worktree enumeration and ask the user to reload it.

## 8. Open questions / assumptions

- Decision: use Git’s native worktree list rather than scanning for `.git` files.
- Decision: include the current repository’s worktrees even when they are outside the current directory tree.
- Decision: always show only the checkout containing Pi’s cwd when clean; hide clean siblings.
- Decision: retain independent nested repositories exactly as today, without enumerating their worktrees.
- Assumption: `git worktree list --porcelain -z` is supported by the installed Git version; this was verified locally.
- Assumption: worktree branch names and file status should continue to come from each checkout’s existing `git status` call rather than duplicating porcelain metadata handling.
- Non-goal: show ahead/behind counts, commit ranges, PR state, or Worktrunk-specific metadata.

## Implementation notes and validation results

- Added NUL-delimited worktree parsing that excludes bare repositories and tolerates branch, detached, locked, and prunable metadata.
- Every Git refresh now asks Git for current worktree membership, keeps the cwd checkout first, deduplicates paths, and sends each checkout through the existing status/numstat path.
- In-tree linked checkout paths are combined with filesystem discovery so their container rows remain filtered from the current checkout.
- Clean-row rendering now compares repository paths instead of labels; this fixes both the requested current/sibling distinction and equal-basename ambiguity.
- The later quota-reset commit `dbab220` supplied the installed Pi peer lookup fix; this task retained it while reapplying worktree coverage.
- The concurrent quota commits `223d4f4` and `dbab220` landed during implementation; the task worktree was fast-forwarded and the focused changes reapplied successfully.
- The first `/reload` did not test this implementation: the installed package resolves to the primary checkout, while the worktree changes were still uncommitted on `sidebar-git-worktrees`. The follow-up lands the code before requesting another reload.

Checks completed:

- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts`
- `git diff --check`
- `pre-commit run --all-files` (`Detect hardcoded secrets` passed)
- Live repository inventory confirmed Git reports the clean primary checkout plus dirty sibling worktrees outside it, which are the paths the new refresh loop consumes.

Pending live verification:

- The installed package already points at the stable primary-checkout source, so no reinstall is needed after merge; the open Pi session must run `/reload` again.
- A fresh subagent review could not start because the installed `pi-mcp-adapter` currently cannot resolve `@modelcontextprotocol/sdk/types.js`; automated extension and repository checks still passed.

## Grill record

The user approved direct implementation without a grill pass after choosing the current repository's worktree set and hidden clean siblings.
