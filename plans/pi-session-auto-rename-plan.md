# Plan: Local Pi Session Auto-Rename Fork

**Completed: 2026-08-08**

## Brief

This change moves the session naming customization into the maintained `skills_and_commands` repository. The local extension will not use Beans identifiers as conversation names. The npm package remains unchanged and will be removed from Pi only after the local replacement is ready.

## Current state / relevant context

- Pi loads `npm:pi-session-auto-rename` from `~/.pi/agent/settings.json`.
- npm package files live under `~/.pi/agent/npm/node_modules/`, so manual edits disappear on reinstall or update.
- This repository stores maintained Pi extensions in `extensions/` with adjacent Node `assert` tests.
- Pi supports local-file packages through `pi install /absolute/path/to/extension.ts`.

## Proposed implementation

1. Copy the upstream extension into `extensions/pi-session-auto-rename/index.ts`.
2. Keep the upstream commands, persisted model configuration, and automatic naming behavior.
3. Put the Beans identifier policy in `extensions/pi-session-auto-rename/policy.ts` so its test does not load Pi runtime modules.
4. Redact Beans identifiers that match `prefix-xxxx`, where the prefix can contain lowercase letters, numbers, and underscores.
5. Tell the naming model not to use opaque work-item identifiers.
6. Treat an existing Beans identifier as an unnamed session so automatic naming can replace it.
7. Resolve a Beans identifier in the first message with `beans show`. Use the Bean title when it exists.
8. Fall back to AI naming when Beans is unavailable or the Bean does not exist.
9. Reject an exact Beans identifier. Replace an identifier inside a generated title.
10. Add an adjacent test for identifier detection, title parsing, prompt redaction, and generated-name rejection.
9. Copy the upstream MIT license. Add concise installation and behavior documentation, then update `docs/README.md`.
10. Validate the local extension. Replace the npm package with the local extension through Pi commands. Do not edit `settings.json` directly.

## File-by-file impact

- `extensions/pi-session-auto-rename/index.ts` — local fork of upstream `0.1.4`, with the Beans identifier rule.
- `extensions/pi-session-auto-rename/policy.ts` — pure Beans identifier policy used by the extension and test.
- `extensions/pi-session-auto-rename/index.test.ts` — direct tests for the local naming policy.
- `extensions/pi-session-auto-rename/LICENSE` — upstream MIT license.
- `docs/pi-session-auto-rename.md` — install, replacement, behavior, and validation instructions.
- `docs/README.md` — link the new document.
- `~/.pi/agent/settings.json` — changed only by Pi package commands after tests pass.

## Risks and edge cases

- A user can intentionally set a Beans identifier with `/name`. The local extension will replace it on its next automatic naming attempt.
- A prompt that contains a valid Bean identifier uses the Bean title. If multiple identifiers exist, the extension uses the first identifier.
- The pattern can redact a non-Beans string with the same shape. This is intentional because the title must not contain opaque work-item IDs.
- Loading both the npm and local extensions would duplicate commands and naming requests. The replacement step removes the npm package first.

## Validation / testing

- Run the adjacent test with Pi's bundled `jiti`.
- Run `git diff --check`.
- Run `pre-commit run --all-files`.
- Run `pi list` after replacement to confirm that the local path is present and the npm package is absent.
- Reload a Pi session and confirm that a message containing `acme_ops-1vkb` receives a descriptive name instead.

## Step-by-step execution checklist

- [x] Copy the upstream extension into the repository.
- [x] Add the Beans identifier policy in a pure helper module.
- [x] Add the adjacent test, including Bean title parsing.
- [x] Use the Bean title when the first message contains an identifier.
- [x] Copy the upstream MIT license.
- [x] Add user documentation and index entry.
- [x] Run extension and repository validation.
- [x] Update the plan with completed steps and validation results.
- [x] Remove the npm package and install the local extension.
- [x] Confirm the Pi package list.
- [x] Mark this plan completed with the completion date.

## Validation results

- `extensions/pi-session-auto-rename/index.test.ts` passed with Pi's bundled `jiti`.
- `bun build` passed with Pi runtime packages marked external.
- `git diff --check` passed.
- `pre-commit run --all-files` passed.
- `pi list` showed the local extension path and no npm package entry.
- The active Pi process requires `/reload` before it uses the local extension. A fresh Pi process also loads the local extension.

## Open questions / assumptions

- The local fork tracks upstream behavior manually. It includes a minimal package manifest for Pi package configuration. It does not synchronize upstream changes automatically.
- The existing configuration file at `~/.pi/agent/extensions/pi-session-auto-rename.json` remains the model preference store.
- This plan treats the user's `go` message as approval to create the local fork. A further confirmation is required before the repository workflow allows implementation.

## 2026-08-08 structure revision

The extension moved into `extensions/pi-session-auto-rename/`. Its Pi package source changed from the former flat file to `index.ts` in that directory.

## 2026-08-08 package install correction

Pi 0.84.1 treats a `pi install` target as a package root. Passing `index.ts` made it search for `index.ts/package.json` and fail with `ENOTDIR`. The extension now declares `index.ts` in a minimal package manifest. Install the extension directory, not its entry file.

## 2026-08-09 embedded identifier correction

The initial fix resolved a Bean only when the first message was the exact identifier. A sentence with an identifier still used the AI fallback. The extension now extracts the first identifier from the message and uses that Bean title.
