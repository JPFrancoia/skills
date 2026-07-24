# Pi sidebar weekly Codex quota bar plan

Status: Completed
Date: 2026-07-24

## 1. Brief

Show the active account's remaining weekly Codex allowance as a compact bar in the sidebar's Conversation section. Query Codex's account-usage endpoint with Pi's resolved OAuth token at session start, after completed agent runs, on Codex model selection, and on manual sidebar refresh.

## 2. Current state / relevant context

- `extensions/pi-sidebar.ts` already renders conversation/model/context data and owns the sidebar refresh lifecycle.
- OpenAI exposes account-level windows through the private `GET https://chatgpt.com/backend-api/wham/usage` endpoint. The weekly window can be `primary_window` or `secondary_window` depending on the account; identify it by `limit_window_seconds` rather than position. OpenAI does not expose an authoritative per-conversation quota charge.
- The user clarified that the bar should show overall weekly remaining allowance, regardless of which conversation consumed it.
- Pi's public `ctx.modelRegistry.getProviderAuth("openai-codex")` returns a refreshed request token. The Codex account ID is inside the token's `https://api.openai.com/auth.chatgpt_account_id` claim.
- `@latentminds/pi-quotas` had already been removed from Pi settings but remained in the managed npm install with `~/.pi/agent/extensions/quotas.json`. The user requested complete cleanup; both package residue and config are now removed and verified absent from `pi list`, npm, and the filesystem.

Success criteria:

- With a Codex model and valid OAuth auth, Conversation shows a 10-cell weekly remaining bar plus percentage.
- The extension refreshes after account use without polling continuously.
- Non-Codex models do not show a misleading Codex bar or make a quota request.
- Missing auth, malformed tokens/payloads, endpoint failures, and stale async results fail harmlessly as `unavailable`.
- No token, account ID, or raw response is persisted or displayed.

## 3. Proposed implementation

1. Add pure helpers to decode the Codex account ID, select the base `rate_limit` window whose duration is at least six days, and convert its `used_percent` into a clamped remaining percentage.
2. Add an abortable 10-second fetch using the resolved OAuth token and account ID. Send only the headers already required by the Codex usage endpoint.
3. Track `loading`, `ready`, or `unavailable` plus the current remaining percentage in sidebar memory. Do not persist credentials or quota responses.
4. Guard async updates with the sidebar's existing session generation and suppress overlapping quota requests.
5. Refresh on TUI `session_start`, Codex `model_select`, `agent_end`, and `/sidebar refresh`. Do not add another timer; agent completion already matches when account usage changes.
6. Render `week ████████░░ 83%` below context usage for Codex. Use success/warning/error colors as remaining headroom falls.
7. Add focused assertions for JWT decoding, weekly payload parsing, provider gating, clamping, and rendered bar/fallback output.

Chosen tradeoff: use OpenAI's private endpoint because Pi and OpenAI expose no stable public quota API and response headers are often absent with WebSocket transport. Keep the request code narrow so it can be replaced easily if Pi adds a typed quota API.

## 4. File-by-file impact

- `extensions/pi-sidebar.ts` — fetch, parse, refresh, and render weekly Codex headroom.
- `extensions/pi-sidebar.test.ts` — cover pure helpers and rendered output.
- `docs/pi-sidebar.md` — document account-wide semantics, refresh timing, auth behavior, and private endpoint risk.
- `plans/pi-sidebar-weekly-quota-bar-plan.md` — record decisions, deviations, and validation evidence.

No dependency, lockfile, repository settings, or credential-file changes.

## 5. Risks and edge cases

- `/wham/usage` is undocumented and can change. Validate the narrow expected payload and show `unavailable` on drift.
- OAuth tokens are sensitive. Resolve them through Pi, keep them in local variables, and never log or persist them.
- The token may not contain a usable account claim or auth may be absent/expired. Pi resolves refresh first; malformed results fail closed.
- A fetch can finish after session replacement. Generation checks prevent stale writes.
- The endpoint may lag immediately after a response. Refreshing at `agent_end` is best effort; `/sidebar refresh` remains available.
- The percentage is account-wide and provider-rounded. Do not label it as conversation consumption or imply token-based precision.
- The extra fixed Conversation row leaves one fewer row for optional sections; current height budgeting already prioritizes fixed sections.

## 6. Validation / testing

Automated:

- `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts`
- `git diff --check`
- `pre-commit run --all-files`

Manual TUI proof:

- Launch Pi from the task worktree with only the candidate sidebar extension.
- Verify a Codex model shows a populated weekly remaining bar from the live account endpoint.
- Verify `/sidebar refresh` updates it and switching to a non-Codex provider removes it.
- Verify the sidebar still reflows and truncates correctly at supported width/height.

## 7. Step-by-step execution checklist

- [x] Inspect the sidebar, Pi extension/provider APIs, installed quota package, and OpenAI Codex quota surfaces.
- [x] Clarify that the metric is overall weekly remaining allowance, not per-conversation consumption.
- [x] Detect that the leftover `pi-quotas` package is incompatible with this Pi fork.
- [x] Completely remove `pi-quotas` package/config residue and verify it no longer loads.
- [x] Replace status parsing with direct Codex usage fetching.
- [x] Add focused tests.
- [x] Run automated checks.
- [x] Perform manual Pi/TUI verification.
- [x] Review the final diff for correctness, credential safety, and unnecessary complexity.
- [x] Update durable docs and this plan with implemented behavior and evidence.
- [x] Mark this plan Completed; do not delete it.

## 8. Open questions / assumptions

- Decision: use the direct account-usage query; the user approved this after the `pi-quotas` incompatibility was demonstrated.
- Observed live payload: this account reports the base weekly allowance in `rate_limit.primary_window` with `limit_window_seconds: 604800`; other clients commonly report it in `secondary_window`. The parser selects by duration and requires numeric `used_percent`.
- Assumption: a 10-cell bar plus percentage is readable at the sidebar's minimum configured width of 20 columns.

## Deviations / decision record

- Initial plan: reuse `pi-quotas`' footer status to avoid a private request.
- Manual TUI result: it rendered `usage unavailable` because version 0.3.1 accesses removed `ctx.modelRegistry.authStorage` state.
- User clarification: `pi-quotas` was intended to be uninstalled; clean it completely and let the sidebar query Codex directly.
- Cleanup performed: removed `@latentminds/pi-quotas` from `~/.pi/agent/npm`, removed `~/.pi/agent/extensions/quotas.json`, and verified no package/config references remain. Historical session transcripts were intentionally retained.

## Implementation notes and validation results

- Live payload inspection showed this account's overall 7-day allowance in `rate_limit.primary_window` and a separate model-specific allowance in `additional_rate_limits`. The sidebar intentionally shows only the base account window and identifies it by its 6–8 day duration.
- A pending refresh is deduplicated normally. Model changes, completed agent runs, and `/sidebar refresh` request a follow-up fetch after any older in-flight request, so a pre-run snapshot cannot suppress the post-run update.
- Automated checks passed:
  - `~/.pi/agent/npm/node_modules/.bin/jiti extensions/pi-sidebar.test.ts`
  - temporary strict TypeScript check with `tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --strict --skipLibCheck --types node`
  - `git diff --check`
  - `pre-commit run --all-files` (`gitleaks` passed)
- Manual 180×40 tmux verification passed:
  - direct OAuth/account usage fetch rendered `week ███████░░░ 73%` with only the candidate sidebar loaded;
  - `/sidebar refresh` completed and preserved the live bar;
  - an Anthropic launch omitted the Codex weekly row.
- Fresh review accepted the in-flight freshness concern; forced refreshes now chain after older requests. A reported absence of `getProviderAuth()` was rejected because the installed public declaration exposes it and a live extension call returned OAuth auth and HTTP 200 from the usage endpoint. The remaining same-account/model-switch observation does not change attribution because Pi has one stored `openai-codex` account and session replacement increments the generation guard.
