# Plan: Nested Subagent Sidebar Tracking

**Status:** Completed (2026-08-08)

## Brief

The sidebar omits subagents that a child agent starts. This change will show those nested agents, including generated names such as `tainted-evidence`, from the existing pi-subagents result and status data. The change will remain in the repository sidebar extension. It will not modify the installed Pi or pi-subagents package.

## Current state / relevant context

`extensions/pi-sidebar.ts` collects only top-level entries from three sources:

- Foreground tool result and progress details.
- Detached async `status.json` files.
- The pi-subagents RPC fleet.

pi-subagents stores nested run summaries in `children` on result, progress, and async step objects. The sidebar does not read these fields. The current RPC fleet does not publish nested children.

The extension already stores each known top-level async directory. It refreshes `status.json` every second. This durable status data contains nested children and can provide live nested visibility after the next refresh.

## Proposed implementation

Add one small recursive parser in `extensions/pi-sidebar.ts`.

- Accept a parent record, a stable key prefix, and inherited timing data.
- Add one `SubagentRun` for each valid nested agent.
- Use the nested path or nested run id in the key. Do not change existing top-level keys.
- Read `agent`, then fall back to `agents` only when one name exists.
- Treat `queued`, `pending`, and `running` as active.
- Use reported duration and cost when available. Use zero when the summary does not include a value.
- Recurse through `children` and nested `steps`.

Call this parser from both existing durable-data paths:

- `subagentRunsFromDetails` for session replay and foreground updates.
- `subagentRunsFromAsyncStatus` for detached async refreshes.

Do not change the installed `pi-subagents` RPC producer. Its nested data is not public, and this repository must not modify the live `~/.pi` package cache. Top-level RPC behavior will remain unchanged. Nested foreground rows will appear when pi-subagents publishes progress details. Nested detached rows will appear on the next sidebar refresh.

## File-by-file impact

### `extensions/pi-sidebar.ts`

Add the shared nested-summary traversal. Extend the details and async-status parsers to append nested runs.

### `extensions/pi-sidebar.test.ts`

Add fixtures that include nested summaries named `tainted-evidence`. Verify recursive extraction, active state, path-stable keys, and existing top-level behavior.

## Risks and edge cases

- A malformed child summary must not discard valid sibling runs.
- Recursive data can contain many levels. Traverse only arrays and valid records.
- Nested summaries can lack timing or cost. Show zero values instead of rejecting the whole status file.
- The RPC-only view cannot show nested children until pi-subagents exposes them. This change does not alter package code.
- Each nested result needs a unique key. Use its run id when present, with a path fallback for incomplete summaries.

## Validation / testing

Run:

```bash
~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts
git diff --check
pre-commit run --all-files
```

Add unit assertions for nested foreground details and a v3 async status with nested children. Verify that the parser keeps existing top-level rows.

## Step-by-step execution checklist

- [x] Add a recursive nested-run parser.
- [x] Use the parser for foreground details and async status files.
- [x] Add nested result and nested status fixtures.
- [x] Run the focused test and hygiene checks.
- [x] Review the diff and mark this plan complete.

## Open questions / assumptions

- The expected result is a flat sidebar list grouped by agent name, not a tree.
- The existing one-second async refresh rate is sufficient for live detached runs.
- Immediate RPC-only nested visibility needs an upstream pi-subagents API change. This plan excludes that package change.
