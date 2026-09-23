# Project Review

All findings below are resolved. Kept as a record of what was found and where it was fixed.

## Review 2 — 2026-09-23

| Severity | Finding | Fix |
|---|---|---|
| High | Continuing an existing session never marked it `running`, so `session_busy` never fired and the same session could run two delegates concurrently. Two concurrent creates of the same new session name could also both pass before the handshake. | #3 — `setRunning` synchronously after spawn; `pendingCreates` guards the create handshake window |
| Medium | `pi_task_stage_collect` hardcoded `maxAttempts=3` and default constraints, dropping the caller's constraints / timeouts / `promptHintOverride` on auto-retry, and counted attempts absolutely, so an async retry after `manual` went straight back to `manual`. | #3 — `Stage.runOptions` (persisted) carries the launch options and a per-round `attemptLimit` |
| Medium | `pi_task_create` restart recovery marked interrupted stages `passed` when the output file merely existed, without running validation. | #3 — recovery runs `validateFiles` with the stage's `validateRules` |
| Low | `pi_refused` was only detected when the run ended in `error`, but Pi normally exits cleanly when it declines, so refusals were classified as `no_output`. | #4 — refusal check now applies whenever validation fails, regardless of run status |
| Low | Streaming progress visible via `pi_status` while a run was active was truncated but not redacted (only the final progress list was). | #4 — streaming progress goes through `redact()` as well |

Verification: `npm run build` passes; `npm test` 147/147 pass. Each fix has a regression test confirmed to fail on the pre-fix code.

## Review 1 — 2026-07-01

| Severity | Finding | Fix |
|---|---|---|
| High | `npm run build` failed (`TS2345`, `lastError` missing `ts` in `delegate.ts`); tests run via `tsx` so did not catch it. | 5656852 |
| High | A missing/non-executable `PI_BIN` could hang `pi_delegate`: `collectOutput()` only listened for `exit`, which `spawn` may never emit on failure. | 5656852 — settles on `error` / `close` too |
| Medium | Async `finalize()` updated session state in memory only; persistence ran on the next MCP request, so a restart could load a completed session as `running`. | 5656852 — `onSessionChange` persistence hook |
| Low | README linked to non-existent `docs/superpowers/...` design docs. | README now links `docs/design.md` and `docs/implementation-plan.md` |
