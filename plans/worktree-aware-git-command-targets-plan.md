# Worktree-aware `/m` and `/pr` repository targets

Status: Completed on 2026-07-26; activation pending merge
Date: 2026-07-25

## 1. Brief

Make `/m` and `/pr` accept a Git worktree’s directory name or branch name, not only a filesystem path relative to Pi’s cwd. This removes the easy-to-miss `../` requirement while preserving absolute paths, relative paths, staged-only commits, and the existing async workflows.

## 2. Current state / relevant context

- `extensions/pi-background-commit.ts` and `extensions/pi-background-pr.ts` resolve every argument with `resolve(ctx.cwd, argument)` and immediately run `git rev-parse` there.
- From `/home/djipey/informatique/ai/skills_and_commands`, the selector `skills_and_commands.feat-sidebar-nested-repository-worktrees` therefore becomes a nonexistent nested path instead of the sibling worktree.
- The explicit path works today: `../skills_and_commands.feat-sidebar-nested-repository-worktrees` resolves to the intended checkout.
- Git already exposes authoritative worktree paths and branches through `git worktree list --porcelain -z`; the commands should use that rather than infer Worktrunk naming conventions.
- Both commands require staged changes. `/pr` already performs the contextual commit, so `/m` and `/pr` are alternatives for one staged index, not sequential steps.

Success criteria:

1. Existing absolute and relative repository paths resolve exactly as today.
2. A unique worktree directory basename resolves from anywhere inside another checkout of the same Git repository.
3. A unique worktree branch name, such as `feat/sidebar-nested-repository-worktrees`, resolves to its checkout.
4. Ambiguous selectors stop with the matching paths instead of choosing one.
5. Invalid selectors and non-Git cwd values retain a clear repository error.
6. `/m` and `/pr` keep their staged-change checks, async child contracts, and exact resolved Git root.

## 3. Implemented design

Each extension keeps a small local resolver so the globally symlinked single-file extensions remain self-contained:

1. It tries the argument as an absolute/relative filesystem path first.
2. If direct `git rev-parse --show-toplevel` fails, it runs `git worktree list --porcelain -z` from `ctx.cwd`.
3. It parses each non-bare `worktree <absolute-path>` record and its optional `branch refs/heads/<name>` field.
4. It matches the selector against the checkout directory basename or full short branch name.
5. It deduplicates matches by absolute path.
6. It verifies a unique match with `git rev-parse --show-toplevel` and passes that exact root to the existing staged-change preflight and child task.
7. It returns an ambiguity error listing paths when more than one checkout matches.

The implementation does not scan parent directories, infer Worktrunk naming, add configuration, or allow `/pr` to open a PR from an empty staged index. The fallback prompt templates and durable documentation use the same resolution order and explain that `/pr` includes the commit step.

## 4. File-by-file impact

- `extensions/pi-background-commit.ts` — add direct-path-first, Git-worktree-aware repository resolution.
- `extensions/pi-background-commit.test.ts` — cover basename matching, branch matching, ambiguity, invalid selectors, and unchanged direct paths.
- `extensions/pi-background-pr.ts` — apply the same target resolution before the existing staged preflight.
- `extensions/pi-background-pr.test.ts` — mirror the worktree resolution and ambiguity coverage while preserving exact-root assertions.
- `commands/m.md` — align fallback resolution instructions with the extension.
- `commands/pr.md` — align fallback resolution instructions and retain staged-only PR behavior.
- `docs/background-git-commands.md` — document `/m`, `/pr`, accepted repository selectors, and the one-command-per-index workflow.
- `docs/README.md` — link the new command guide.
- `plans/worktree-aware-git-command-targets-plan.md` — retain decisions, progress, deviations, and validation results.

## 5. Risks and edge cases

- **Ambiguous basename or branch:** report every matching checkout and require an explicit path.
- **Detached worktree:** basename matching still works; branch matching is unavailable for that checkout.
- **Spaces in paths:** parse NUL-delimited output and strip only record prefixes/line endings, not path whitespace.
- **Bare worktree record:** ignore it because `/m` and `/pr` require a working checkout and staged index.
- **Different repository family:** worktree aliases only cover the repository containing Pi’s cwd. An explicit relative or absolute path remains required for an unrelated repository.
- **Symlinked live extensions:** keep each extension self-contained rather than adding a relative helper import whose resolution could differ through `~/.pi/agent/extensions` symlinks.
- **Behavior drift between commands:** use equivalent focused tests and keep the small resolver implementations structurally identical.

## 6. Validation / testing

Completed automated checks:

- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-background-commit.test.ts`
- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-background-pr.test.ts`
- strict temporary `tsc --noEmit` against Pi’s installed types;
- extension import checks;
- `git diff --check`;
- `pre-commit run --all-files`.

Completed manual proof:

- Non-mutating print-mode `/m` proof resolved a worktree directory-basename selector.
- Non-mutating print-mode `/pr` proof resolved a full short-branch selector.

A first reviewer found the implementation correct and suggested making direct-path precedence and cwd-repository fallback explicit in both test files; those call-order assertions were added. A final fresh reviewer found no fixes needed. Activation/reload against the global extension symlinks remains pending until the implementation branch is merged into the canonical checkout.

## 7. Step-by-step execution checklist

- [x] Add worktree parsing and target resolution to `/m`.
- [x] Add focused `/m` resolution tests.
- [x] Apply equivalent resolution to `/pr`.
- [x] Add focused `/pr` resolution tests.
- [x] Update fallback prompts.
- [x] Run focused extension tests, strict TypeScript validation, and import checks.
- [x] Update durable command documentation.
- [x] Run repository hygiene checks.
- [x] Record non-mutating print-mode basename `/m` and branch `/pr` proof.
- [x] Obtain a fresh reviewer pass and apply required fixes.
- [ ] Activate/reload the final merged extension source and record the result.

## 8. Open questions / assumptions

- Decision: direct filesystem paths win before worktree aliases.
- Decision: match aliases only within the Git repository containing Pi’s cwd.
- Decision: support both checkout basename and full short branch name.
- Decision: fail on ambiguity rather than using worktree order.
- Decision: preserve staged-only `/m` and `/pr`; `/pr` already includes the commit.
- Assumption: `git worktree list --porcelain -z` is supported by the installed Git version, already verified by the sidebar implementation.
