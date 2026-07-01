# Project Review

Date: 2026-07-01

## Findings

### High: `npm run build` fails

`npm run build` currently fails, so the package cannot produce `dist/server.js` even though `package.json` points `bin.pi-subagent` at that output and `README.md` documents build as available.

Error:

```text
src/tools/delegate.ts(165,11): error TS2345: Argument of type '{ code: any; message: any; runId: string; } | undefined' is not assignable to parameter of type '{ code: string; message: string; runId?: string | undefined; ts: number; } | undefined'.
  Property 'ts' is missing in type '{ code: any; message: any; runId: string; }' but required in type '{ code: string; message: string; runId?: string | undefined; ts: number; }'.
```

Location: `src/tools/delegate.ts:163`

The test suite runs through `tsx` and does not typecheck, so this is not caught by `npm test`.

### High: missing Pi executable can hang `pi_delegate`

If `PI_BIN` is wrong, `pi` is not installed, or the executable is not runnable, `spawn()` can emit `error` and `close` without emitting `exit`. `collectOutput()` only listens for `exit`, so it may never resolve.

Locations:

- `src/runner/spawn.ts:88`
- `src/tools/delegate.ts:240`

This can leave a new-session async `pi_delegate` call waiting forever during startup/handshake, which is a bad failure mode for MCP hosts.

### Medium: async completion does not persist session terminal state

Async `finalize()` updates run and session state in memory, but persistence is only triggered when the MCP request handler returns. If an async run completes and the host does not call `pi_status` or another tool afterward, the registry file can remain stale.

Locations:

- `src/tools/delegate.ts:147`
- `src/tools/delegate.ts:158`
- `src/server.ts:155`

Impact: after restart, a completed async session may still be loaded from disk as `running` and then marked `interrupted_by_restart`, even though the run actually completed.

### Low: README links to missing design docs

`README.md` references:

- `docs/superpowers/specs/2026-07-01-pi-subagent-design.md`
- `docs/superpowers/plans/2026-07-01-pi-subagent.md`

Those files are not present in the repository.

Location: `README.md:70`

## Verification

```bash
npm test
```

Result: passed. 14 test files passed.

```bash
npm run build
```

Result: failed with `TS2345` because `lastError` is missing `ts`.

## Suggested Fix Order

1. Fix the TypeScript build failure in `delegate.ts`.
2. Make `collectOutput()` settle on `error`/`close`, not only `exit`, and add a regression test for bad `PI_BIN`.
3. Add a persistence callback for async `finalize()` so session terminal state is saved when background runs complete.
4. Either add the referenced design docs or remove/update the README links.
