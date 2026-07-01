# pi-subagent

> Turn the [Pi CLI](https://pi.dev) (`@earendil-works/pi-coding-agent`) into a **programmable coding sub-agent** that any MCP host (ZCode, Claude Code, Cursor, …) can delegate tasks to, track sessions, and kill processes.

`pi-subagent` is a thin MCP server that wraps `pi -p --mode json` into 7 structured tools: delegate tasks, harvest results, make scheduling decisions, manage named sessions, and abort runs. Process-isolated, fully session-based, sync/async dual-mode.

## Why

Pi is a minimal terminal coding agent. Rather than teaching Pi *methodology*, this project treats Pi as a **delegatable worker**: a host agent (ZCode / Claude Code) decides *when* to delegate, fires off a self-contained task, and harvests the result. One Pi process = one isolated sub-agent run.

- **Process isolation** — each delegation spawns one `pi -p` child process. A Pi crash only affects that run.
- **Fully session-based** — every task binds to a named session (e.g. `feat-auth`); subsequent calls auto-continue.
- **Sync / async** — defaults to `async` (avoids host tool-call timeouts); harvest with `pi_status` long-poll.
- **Schedulable** — `pi_plan` is a pure 5-stage decision function (reject / capacity / reuse / modify / mode), fully unit-tested.
- **Universal MCP** — any standard MCP client can load it.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  MCP Host (ZCode / Claude Code / Pi / Cursor …)              │
└───────────────────────────┬─────────────────────────────────┘
                            │ MCP (JSON-RPC over stdio)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  pi-subagent-server  (Node/TS)                                │
│  ┌────────────┐  ┌──────────────┐  ┌────────────────────┐   │
│  │ Tool layer │  │ Session      │  │ Pi runner          │   │
│  │ (7 tools)  │─▶│ registry     │─▶│ (spawn pi -p)      │   │
│  │ + plan()   │  │ + persist    │  │ parse agent_end    │   │
│  └─────┬──────┘  │ + _snapshot  │  │ + tool_execution   │   │
│        │         └──────────────┘  └─────────┬──────────┘   │
│        │                           ┌────────▼─────────┐     │
│        └───────────────────────────│ Run registry     │     │
│           (kill)                   │ + process-table  │     │
│                                   └──────────────────┘     │
└─────────────────────────────────────────────────────────────┘
                            │ child_process.spawn({ cwd })
                            ▼
                   ┌─────────────────────┐
                   │  pi CLI (0.77+)     │
                   └─────────────────────┘
```

Three layers with clear boundaries: **Tool layer** (MCP schema + `plan()` pure function) / **Session registry** (state + persistence + redaction) / **Runner** (spawn pi, parse NDJSON, process table).

## Tools

| Tool | Purpose |
|------|---------|
| `pi_plan` | Decide: should-delegate, sync/async, how many sessions |
| `pi_delegate` | Dispatch a task (default async; new sessions wait for handshake) |
| `pi_status` | Harvest a run's result (long-poll) |
| `pi_session_list` | List sessions (omit `cwd` for the full set `pi_plan` needs) |
| `pi_session_snapshot` | Inspect one session |
| `pi_session_fork` | Branch a session to try another path |
| `pi_kill` | Abort a run |

### Session model

- Each session has a human-readable name + Pi's UUID + `cwd` + `goal`.
- First `pi_delegate` creates the session (`goal` required); later calls auto-continue.
- The registry persists to `~/.pi-subagent/registry.json` (atomic write; on restart, interrupted `running` records are corrected to `error`).
- Concurrency cap: **4** running runs; a single session is never run concurrently.

## Install

```bash
git clone <this-repo> && cd pi-subagent
npm install
```

Prerequisite: the `pi` CLI is installed (`npm i -g @earendil-works/pi-coding-agent`) and on `PATH`.

## Configure an MCP host

Add to your MCP client config:

```json
{
  "mcpServers": {
    "pi-subagent": {
      "command": "npx",
      "args": ["tsx", "/abs/path/to/pi-subagent/src/server.ts"]
    }
  }
}
```

Optional env vars:
- `PI_SUBAGENT_REGISTRY` — registry path (default `~/.pi-subagent/registry.json`)
- `PI_BIN` — override the pi executable (used by tests)

## Test

```bash
npm test           # full suite (79 tests)
npm run test:fast  # dot reporter
```

Tests use a fake pi (`test/fixtures/fake-pi.sh`) and cover: async/sync, timeout, kill, session-create-failure, multi-waiter, progress cap, scheduling rules (table-driven + 100-iteration property tests), registry persistence, redaction, etc.

## Project layout

```
src/
├── types.ts                 # all shared types + error codes
├── errors.ts                # ToolError helpers
├── runner/                  # parse.ts, argv.ts, spawn.ts, process-table.ts
├── registry/                # session.ts, run.ts, persist.ts, redact.ts
├── scheduler/               # keywords.ts, plan.ts (5-stage pure function)
├── tools/                   # delegate, status, plan-tool, session, kill
└── server.ts                # MCP entry (stdio)
skills/pi-subagent/          # SKILL.md + delegation-patterns (strategy layer)
test/                        # fixtures/ + *.test.ts
docs/                        # design.md (spec) + implementation-plan.md
```

## Design & process

This project went through collaborative design + 4 rounds of external review before implementation. The spec and plan are committed under `docs/`:

- **[`docs/design.md`](docs/design.md)** — full design spec (architecture, tool contracts, error handling, scheduler rules, testing strategy). Every contract is traceable to a review note (`R1`–`R4`).
- **[`docs/implementation-plan.md`](docs/implementation-plan.md)** — 19 TDD tasks (write failing test → implement → pass → commit).

Key design decisions, all backed by real probing of `pi -p` output and external review:
- **`cwd` ≠ session storage** — `spawn({ cwd })` controls the working dir; Pi's session files use their default location (doesn't pollute the project).
- **async default + handshake** — new sessions wait for Pi's `session` event before returning (with a `sessionStartTimeoutMs`), so the host always gets a real `piSessionId`.
- **Multi-stage scheduler** — `plan()` is reject → capacity → reuse → modify → mode, where modifiers stack rather than first-match (a lesson from review round 1).
- **Progress redaction** — tool results are truncated + scrubbed for tokens/keys before being stored.

## Status

Working implementation, 79 passing tests. Not yet published to npm — run from source via `tsx`.

## License

MIT
