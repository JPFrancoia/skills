---
description: Commit, push, open a PR or MR, and watch CI in the background
argument-hint: "[repo-path]"
---

## Your Task

Launch a background pull-request workflow for `${1:-.}` and return control as soon as the async subagent starts. Do not create a branch, commit, push, open the PR/MR, or watch CI in the parent conversation.

This prompt is the fallback when the `pi-background-pr` extension is not loaded. The extension normally owns `/pr` directly.

### 1. Resolve the Target Repository

Resolve `${1:-.}` in this order:

1. Try it as an absolute or cwd-relative path with `git -C <target> rev-parse --show-toplevel`.
2. If that fails, run `git worktree list --porcelain -z` from the repository containing the conversation cwd.
3. Match a unique non-bare worktree whose directory basename or short branch name equals the argument.
4. Stop and list the matching paths if the selector is ambiguous; stop if no repository matches.

Verify the selected Git root and stop if it has no staged changes:

```bash
git -C "<resolved-git-root>" diff --cached --quiet --exit-code
```

### 2. Launch the Pull Request Agent

Use the `subagent` tool to launch `pull-request-creator` with:

- `cwd`: the resolved Git root;
- `context`: `fork` when persisted conversation context exists, otherwise `fresh`;
- `async`: `true`;
- task text containing the resolved Git root and telling the agent to use `git -C` with that exact path.

The task should be:

```text
Target repository: <resolved-git-root>
Commit whatever is staged there, creating a meaningful branch first if HEAD is main or master. Use git -C with that exact path for every Git command. Push to origin, create or reuse the matching GitHub PR or GitLab MR, watch CI, and follow your pull-request instructions.
```

Do not wait for completion. Report only that the background run started; Pi will deliver its completion notification.

### Important

- Do not ask for confirmation.
- Do not run `git add`, edit files, or modify the staging area in the parent.
- Do not launch the agent when no changes are staged.
