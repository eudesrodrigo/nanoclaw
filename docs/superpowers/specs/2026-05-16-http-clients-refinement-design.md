# http-clients Integration Refinement

## Goal

Align the http-clients MCP tool integration with NanoClaw's recommended patterns: auto-composed instructions via `*.instructions.md`, rewritten container skill via `SKILL.md`, and clean separation between shared tooling and per-agent-group memory. Remove the Costco Receipt Monitor and all associated files.

## Background

The http-clients host service (port 3002) and MCP tool (`http_clients`) were implemented in the previous spec. They work correctly, but the agent-facing documentation is misplaced:

- Generic instructions (how to use the tool, re-auth flows) are in `groups/dm-with-eudes/CLAUDE.local.md` — only one agent group sees them
- The container skill `SKILL.md` still references `Bash(http-clients *)` — the old approach where the CLI ran inside the container
- No `http-clients.instructions.md` exists alongside the MCP tool — so the auto-composition system doesn't generate a fragment for any agent group
- The `command` parameter is required in both the host service and MCP tool schema, blocking top-level discovery (`http-clients --help`)

## Changes

### 1. Create `http-clients.instructions.md` (MCP tool instructions)

**File:** `container/agent-runner/src/mcp-tools/http-clients.instructions.md`

Auto-composed as `.claude-fragments/module-http-clients.md` in every agent group via the fragment system in `claude-md-compose.ts`. No manual wiring needed.

**Content scope** (following the pattern of `core.instructions.md`, `scheduling.instructions.md`):

- What the tool does: proxy to the `http-clients` CLI on the host
- Input schema: `service` (optional string), `command` (optional string), `args` (optional key-value object passed as CLI flags)
- Response format: `{status: "ok", data: ...}` on success, `{status: "error", code: "auth_required"|"cli_error", ...}` on failure
- Security note: credentials live on the host — the container never sees them
- Discovery: omit `command` to get the service's help output; omit both to list available services. Help text arrives as `{status: "error", code: "cli_error", message: "..."}` because Typer writes help to stderr.

### 2. Rewrite `SKILL.md` (container skill)

**File:** `container/skills/http-clients/SKILL.md`

Updated from the old `Bash(http-clients *)` approach to use the MCP tool. Follows the pattern of `container/skills/agent-browser/SKILL.md`.

**Frontmatter:** `allowed-tools: mcp__nanoclaw__http_clients`

**Content scope:**

- **Discovery workflow:** How to discover available services, commands, and flags via tool calls without the `command` parameter
- **Multi-profile:** `profiles` command, `--profile all` vs `--profile <name>`
- **Re-auth flows:**
  - Costco (flow: "token"): detect `auth_required` with `flow: "token"` → message user to provide refresh token from costco.ca cookies → call `login` command with token → retry
  - Wealthsimple (flow: "otp"): detect `auth_required` with `flow: "otp"` → call `login` command (may succeed with saved `otp_claim`) → if OTP required, message user for code → call `login` with `--otp` flag → retry
- **Error handling:** what to do with each error type
- **Output guidance:** summarize in natural language, don't dump raw JSON

### 3. Make `command` optional in host service

**File:** `src/http-clients-service.ts`

Make both `service` and `command` optional. Build the CLI args array from whichever fields are present:
- Neither: spawn `http-clients` (shows available services)
- `service` only: spawn `http-clients <service>` (shows service commands)
- Both: spawn `http-clients <service> <command>` (current behavior)

No validation needed — all fields are optional. An empty call just shows help, which is safe.

**Note on help output:** Typer writes help text to stderr with exit code 0. The host service currently treats empty stdout + non-empty stderr as a `cli_error` response. The agent receives the help text in the `message` field of the error response. The `instructions.md` and `SKILL.md` must document this explicitly so the agent knows to read the `message` field of error responses for discovery output, not treat it as a failure.

### 4. Make `command` optional in MCP tool schema

**File:** `container/agent-runner/src/mcp-tools/http-clients.ts`

Remove both `service` and `command` from the `required` array in the tool's `inputSchema`. Update the description to note the discovery behavior:
- No args: lists available services
- `service` only: lists commands for that service
- `service` + `command`: executes the command (current behavior)

### 5. Clean up CLAUDE.local.md

**File:** `groups/dm-with-eudes/CLAUDE.local.md`

Remove three sections:
- "http-clients Service" (generic — now in instructions.md)
- "Auth renewal" (generic — now in SKILL.md)
- "Costco Receipt Monitor" (being removed entirely)

The file retains: agent identity, browser credentials, and any other non-http-clients content.

### 6. Remove Costco Receipt Monitor

**Files to delete:**
- `groups/dm-with-eudes/costco/check_receipts.py`
- `groups/dm-with-eudes/costco/state.json`
- `groups/dm-with-eudes/costco/price_cache.json`
- `groups/dm-with-eudes/costco/` (directory)

**Scheduled task:** `task-1777765347844-abf4sk` — must be cancelled. The task and its pending recurrences live in the session's `inbound.db` (`messages_in` table, `kind = 'task'`). Cancel by running the equivalent of `cancelTask(db, taskId)`: `UPDATE messages_in SET status = 'completed', recurrence = NULL WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending', 'paused')` with the series ID. The inbound.db path is `data/v2-sessions/ag-1777000247524-9397mf/sess-1777000247537-6uackb/inbound.db`.

### 7. Update test file

**File:** `src/http-clients-service.test.ts`

Update existing tests and add new ones:

- **Remove** the test that validates 400 for missing `command` — `command` is now optional.
- **Add** test: empty body `{}` returns 200 with `cli_error` containing help text (top-level discovery).
- **Add** test: service-only `{service: "costco"}` returns 200 with `cli_error` containing service help text.
- **Keep** existing test: `{service, command}` returns expected output (current behavior unchanged).
- **Keep** existing test: `{service, command, args}` passes flags correctly.

## What does NOT change

- Host service port (3002), bind address (127.0.0.1), spawn mechanism
- MCP tool handler logic (still a `fetch()` to the host)
- Container image (source is bind-mounted, no rebuild needed)
- Security model (credentials on host, never in container)
- `HTTP_CLIENTS_URL` env var injection into containers
- `HTTP_CLIENTS_BIN` config resolution
- dm-with-home CLAUDE.local.md (no http-clients content there today)

## Verification

After implementation:
1. Restart NanoClaw (`launchctl kickstart`)
2. Confirm `module-http-clients.md` appears in `.claude-fragments/` for both dm-with-eudes and dm-with-home
3. Confirm `http-clients` skill is symlinked in both groups' `.claude-shared/skills/`
4. Test top-level discovery: `curl -X POST http://127.0.0.1:3002/call -H 'content-type: application/json' -d '{}'` — should return `{status: "error", code: "cli_error", message: "..."}` where `message` contains help text listing available services (Typer writes help to stderr)
5. Test service discovery: `curl -X POST http://127.0.0.1:3002/call -H 'content-type: application/json' -d '{"service":"costco"}'` — should return `{status: "error", code: "cli_error", message: "..."}` where `message` contains help text listing commands for that service
6. Test normal operation: `curl -X POST http://127.0.0.1:3002/call -H 'content-type: application/json' -d '{"service":"costco","command":"profiles"}'` — should return profiles (existing behavior unchanged)
7. All host tests pass (`pnpm test`)
8. Verify scheduled task cancelled: `sqlite3 data/v2-sessions/.../inbound.db "SELECT id, status FROM messages_in WHERE series_id = 'task-1777765347844-abf4sk'"` — all rows should be `completed`
