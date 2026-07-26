# Background Git commands

`/m [target]` commits staged changes in the target repository in the background. `/pr [target]` commits those staged changes, then pushes and opens or reuses the matching pull request or merge request in the background.

## Choose a target

When supplied, `target` is resolved in this order:

1. A direct absolute or Pi-cwd-relative path to a Git repository.
2. The basename of a linked worktree directory.
3. The full short branch name of a linked worktree, such as `feat/sidebar`.

Direct paths win over worktree aliases. Worktree aliases cover only worktrees in the Git repository containing Pi's current working directory; use an explicit path for a repository in another Git family. If a basename or branch selector matches multiple worktrees, the command lists the matching paths and requires an explicit path.

For example, from one checkout of a repository:

```text
/m ../other-checkout
/m other-checkout
/pr feat/sidebar
```

## Autocomplete

Type `/m ` or `/pr ` (including the trailing space) to list discovered checkouts that currently have staged changes. The dropdown covers the current checkout, its linked worktrees, independent repositories below it, and linked worktrees belonging to those repositories. Selecting an item inserts an unambiguous relative path; typing part of its path, directory name, or branch filters the list.

Repository/worktree membership is cached after the first completion request in a session, while staged state is checked each time. Run `/reload` after adding or removing a worktree or nested repository.

Install only the extension versions of `/m` and `/pr` when using autocomplete. The files `commands/m.md` and `commands/pr.md` are fallbacks for setups where the extensions are unavailable; installing them as prompt templates alongside the extensions creates duplicate command entries, and current Pi versions may choose the prompt entry without argument completion.

## Staged changes and workflow

Both commands require staged changes in the selected repository and do not stage files for you. Choose one command for a staged index: use `/m` when you only want the commit, or `/pr` when you want the complete commit-and-pull-request workflow. Do not run `/m` and then `/pr` for the same changes, because `/pr` includes the commit step.
