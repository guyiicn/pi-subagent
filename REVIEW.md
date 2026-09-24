# Project Review

A record of what was found and where it was fixed. Open items are marked **Open**.

## Review 3 — 2026-09-24 (live end-to-end runs)

Found by driving the installed MCP server from Claude Code with the real `pi` CLI: a 4-stage `wordfreq` task (plan review, sequential stages, two stages in parallel) and a 2-stage follow-up fix task.

| Severity | Finding | Fix |
|---|---|---|
| Medium | Pi left a self-test file (`sw.txt`) in the task directory although the stage prompt says to write only the output file. Validation only inspected `outputFile`, so out-of-scope writes — including edits to earlier stages' outputs — went undetected. | #6 — cwd snapshot diff per attempt; new stray files warn by default (`scopeWarnings`, never deleted), modifying/deleting files outside the stage fails as `scope_violation`, opt-in `strictScope`; prompt now says temp files go to `/tmp`. Verified live: the follow-up run produced no stray files and Pi used `/tmp` |
| Low | Streaming redaction masked any 20+ char `[A-Za-z0-9_-]` run, so session UUIDs in task paths, git SHAs and long identifiers showed up as `***`. | #5 — match known secret formats (PEM, Bearer, JWT, `sk-`/`ghp_`/`AKIA`/… prefixes) plus a high-entropy fallback (≥32 chars mixing upper, lower and digits) |
| Low | While a run is still `running`, `pi_status(waitTimeoutMs: 0)` and `pi_task_stage_collect` return no progress, so the host cannot tell whether Pi is making progress (a 4-minute stage could only be checked via file mtimes). This also means #4's streaming redaction currently has no output path. The long-poll-timeout path of `pi_status` already returns progress. | **Open** — #7 (draft): failing spec tests only, handed off for implementation |
| Info | After the server was rebuilt, the Claude Code session still showed the old `pi_task_create` schema (no `allowExtraFiles` / `strictScope`). The running server was the new build and accepted the fields. Host-side tool-schema caching, not fixable in this repo; a full session restart refreshes it. | — |

Development note for #6: an existing fake-pi test (writes a marker file on attempt 1, deletes it on attempt 2) was flagged as a scope violation. That exposed a design gap: a stage cleaning up files it created in an earlier attempt must be allowed. Fixed before merge.

Verification: `npm run build` passes; `npm test` 173/173 pass on `main` (the #7 branch adds 3 tests, 2 of them intentionally failing).

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
