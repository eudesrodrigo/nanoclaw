# http-clients Integration Refinement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the http-clients MCP tool integration with NanoClaw's recommended patterns — auto-composed instructions, rewritten container skill, optional discovery parameters — and remove the Costco Receipt Monitor.

**Architecture:** Seven independent changes, each producing a self-contained commit. The host service (`src/http-clients-service.ts`) removes field validation so `service` and `command` are optional; the MCP tool schema matches. A new `http-clients.instructions.md` is auto-composed into every agent group. The container skill `SKILL.md` is rewritten to reference the MCP tool instead of Bash. Per-group memory (`CLAUDE.local.md`) is cleaned of generic instructions. The Costco Receipt Monitor (files + scheduled task) is deleted.

**Tech Stack:** Node/TypeScript (host), Bun/TypeScript (container agent-runner), SQLite (scheduled task cancellation), Markdown (instructions/skill docs)

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `container/agent-runner/src/mcp-tools/http-clients.instructions.md` | Auto-composed MCP tool usage instructions |
| Modify | `container/skills/http-clients/SKILL.md` | Rewrite: Bash → MCP tool, add re-auth flows |
| Modify | `src/http-clients-service.ts:33-38` | Remove required-field validation, build args conditionally |
| Modify | `src/http-clients-service.test.ts` | Update tests for optional fields |
| Modify | `container/agent-runner/src/mcp-tools/http-clients.ts:17-40` | Make schema fields optional, update description and handler types |
| Modify | `groups/dm-with-eudes/CLAUDE.local.md:14-49` | Remove http-clients and Costco Monitor sections |
| Delete | `groups/dm-with-eudes/costco/check_receipts.py` | Costco Receipt Monitor script |
| Delete | `groups/dm-with-eudes/costco/state.json` | Costco Monitor runtime state (untracked) |
| Delete | `groups/dm-with-eudes/costco/price_cache.json` | Costco Monitor price cache (untracked) |
| n/a | `data/v2-sessions/ag-1777000247524-9397mf/sess-1777000247537-6uackb/inbound.db` | Cancel scheduled task via SQL |

---

### Task 1: Make host service fields optional (TDD)

**Files:**
- Modify: `src/http-clients-service.ts:33-38`
- Modify: `src/http-clients-service.test.ts:53-69`

- [ ] **Step 1: Update the test for missing-command (now valid)**

In `src/http-clients-service.test.ts`, replace the test `'returns 400 when command is missing'` (lines 62-69) with a test that verifies service-only requests are accepted:

```typescript
  it('accepts service-only requests (discovery)', async () => {
    server = await startHttpClientsService(0);
    const port = (server.address() as { port: number }).port;

    const { status, data } = await makeRequest(port, { service: 'costco' });
    // CLI may return help text or error depending on host setup.
    // Key assertion: NOT a 400 — the service accepted it.
    expect(status).toBe(200);
    expect(data.status).toBeDefined();
  });
```

- [ ] **Step 2: Update the test for missing-service (now valid)**

Replace the test `'returns 400 when service is missing'` (lines 53-60) with a test for empty-body discovery:

```typescript
  it('accepts empty body for top-level discovery', async () => {
    server = await startHttpClientsService(0);
    const port = (server.address() as { port: number }).port;

    const { status, data } = await makeRequest(port, {});
    // CLI returns help text via stderr (Typer behavior).
    // Host service returns it as cli_error with the help text in message.
    expect(status).toBe(200);
    expect(data.status).toBeDefined();
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/eudesrodrigo/Projects/nanoclaw && pnpm test -- --run src/http-clients-service.test.ts`

Expected: 2 failures — the new tests expect 200 but the current code returns 400.

- [ ] **Step 4: Update host service to make fields optional**

In `src/http-clients-service.ts`, replace lines 33-43 (the validation + args building):

```typescript
        const { service, command, args } = body;
        if (!service || !command) {
          respond(res, 400, { status: 'error', message: 'Missing required fields: service, command' });
          return;
        }

        const cliArgs = [service, command];
        if (args) {
          for (const [key, value] of Object.entries(args)) {
            cliArgs.push(`--${key}`, String(value));
          }
        }
```

With:

```typescript
        const { service, command, args } = body;

        const cliArgs: string[] = [];
        if (service) cliArgs.push(service);
        if (command) cliArgs.push(command);
        if (args) {
          for (const [key, value] of Object.entries(args)) {
            cliArgs.push(`--${key}`, String(value));
          }
        }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/eudesrodrigo/Projects/nanoclaw && pnpm test -- --run src/http-clients-service.test.ts`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/http-clients-service.ts src/http-clients-service.test.ts
git commit -m "feat: make service and command optional in http-clients host service

Enables discovery: no args = list services, service only = list commands.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: Make MCP tool schema fields optional

**Files:**
- Modify: `container/agent-runner/src/mcp-tools/http-clients.ts:17-40`

- [ ] **Step 1: Update the tool description and schema**

In `container/agent-runner/src/mcp-tools/http-clients.ts`, replace the entire `httpClientsTool` definition (lines 14-55):

```typescript
const httpClientsTool: McpToolDefinition = {
  tool: {
    name: 'http_clients',
    description:
      'Call the http-clients CLI on the host. Credentials are managed securely on the host — this tool never sees them. ' +
      'Omit all args to list available services. Pass service only to list its commands. ' +
      'Pass service + command to execute. Returns JSON; on auth failure returns {status:"error", code:"auth_required", flow:"token"|"otp"}.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name (e.g. costco, wealthsimple). Omit to list available services.' },
        command: { type: 'string', description: 'CLI command (e.g. receipts, positions, login). Omit to list commands for the service.' },
        args: {
          type: 'object',
          description: 'Key-value pairs passed as CLI flags (e.g. {profile: "eudes", type: "warehouse"})',
          additionalProperties: { type: 'string' },
        },
      },
      required: [],
    },
  },
  handler: async (params) => {
    if (!HTTP_CLIENTS_URL) {
      return err('HTTP_CLIENTS_URL not configured — host service not available');
    }

    const { service, command, args } = params as { service?: string; command?: string; args?: Record<string, string> };

    try {
      const response = await fetch(`${HTTP_CLIENTS_URL}/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service, command, args: args ?? {} }),
      });

      const data = await response.json();
      return ok(JSON.stringify(data, null, 2));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};
```

Key changes from the original:
- `required: ['service', 'command']` → `required: []`
- Handler type: `service: string; command: string` → `service?: string; command?: string`
- Description updated with discovery behavior
- Property descriptions note what happens when omitted

- [ ] **Step 2: Verify container typecheck**

Run: `cd /Users/eudesrodrigo/Projects/nanoclaw && pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/mcp-tools/http-clients.ts
git commit -m "feat: make service and command optional in MCP tool schema

Matches host service change — enables discovery via omission.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Create `http-clients.instructions.md`

**Files:**
- Create: `container/agent-runner/src/mcp-tools/http-clients.instructions.md`

- [ ] **Step 1: Create the instructions file**

Create `container/agent-runner/src/mcp-tools/http-clients.instructions.md`:

```markdown
## External service access (`http_clients`)

`mcp__nanoclaw__http_clients` proxies to the `http-clients` CLI on the host. Credentials are managed on the host — this agent never sees them.

### Discovery

All parameters are optional. Omit fields to discover what's available:

- `http_clients()` — lists available services
- `http_clients({ service: "costco" })` — lists commands for that service
- `http_clients({ service: "costco", command: "receipts" })` — executes the command

Discovery output arrives as `{status: "error", code: "cli_error", message: "..."}` — read the `message` field for the help text. This is normal (the CLI writes help to stderr).

### Parameters

- `service` (string, optional) — service name (e.g. `costco`, `wealthsimple`)
- `command` (string, optional) — CLI command (e.g. `receipts`, `positions`, `login`, `profiles`)
- `args` (object, optional) — key-value pairs passed as CLI flags (e.g. `{profile: "eudes", type: "warehouse"}`)

### Response format

- Success: `{status: "ok", data: ...}`
- Auth required: `{status: "error", code: "auth_required", flow: "token"|"otp", message: "..."}`
- CLI error: `{status: "error", code: "cli_error", exitCode: <number>, message: "..."}`
```

This file will be auto-composed as `.claude-fragments/module-http-clients.md` in every agent group via `claude-md-compose.ts` — no manual wiring needed.

- [ ] **Step 2: Verify the file is discovered by the composition system**

The composition system at `src/claude-md-compose.ts:79-89` scans `container/agent-runner/src/mcp-tools/` for `*.instructions.md` files. Verify the file is found:

Run: `ls /Users/eudesrodrigo/Projects/nanoclaw/container/agent-runner/src/mcp-tools/*.instructions.md`

Expected output should include `http-clients.instructions.md` alongside `core.instructions.md`, `scheduling.instructions.md`, etc.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/mcp-tools/http-clients.instructions.md
git commit -m "feat: add http-clients.instructions.md for auto-composed fragments

Auto-discovered by claude-md-compose.ts, appears as module-http-clients.md
in every agent group's .claude-fragments/.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: Rewrite container skill `SKILL.md`

**Files:**
- Modify: `container/skills/http-clients/SKILL.md`

- [ ] **Step 1: Rewrite the skill file**

Replace the entire contents of `container/skills/http-clients/SKILL.md`:

```markdown
---
name: http-clients
description: Query personal accounts and services (orders, purchases, receipts, memberships, bank info, spending) via the http-clients CLI. Trigger when the user asks about purchases, orders, receipts, account status, or data from any personal service account.
allowed-tools: mcp__nanoclaw__http_clients
---

# http-clients

MCP tool for querying personal service accounts via the host. Services and commands are auto-discovered — never assume what's available.

## Discovery

1. `http_clients()` — list available services
2. `http_clients({ service: "<name>" })` — list commands for a service
3. `http_clients({ service: "<name>", command: "<cmd>" })` — execute a command

Discovery output arrives in `{status: "error", code: "cli_error", message: "..."}` — read the `message` field for help text. This is expected behavior, not an error.

Always discover before running. New services and commands appear automatically — don't hardcode anything.

## Multi-profile

Some services have multiple profiles (e.g. family members with separate accounts). Use `http_clients({ service: "<name>", command: "profiles" })` to list them. By default `--profile all` consolidates data from every profile — output is tagged with `[Name]` prefixes. Use `args: { profile: "<name>" }` to query a specific one.

## Re-authentication

When any call returns `{status: "error", code: "auth_required"}`, check the `flow` field:

**flow: "token" (e.g. Costco)**:
1. Message the user: "Costco token expired for profile '<profile>'. Open costco.ca → DevTools → Application → Cookies → copy the `refresh_token` value and send it here."
2. When the user provides the token: `http_clients({ service: "<name>", command: "login", args: { profile: "<profile>", token: "<token>" } })`
3. Retry the original operation.

**flow: "otp" (e.g. Wealthsimple)**:
1. Try login first (may succeed with saved claim): `http_clients({ service: "<name>", command: "login", args: { profile: "<profile>" } })`
2. If response indicates OTP is required, message the user: "Wealthsimple OTP sent to your phone. Send me the code."
3. When the user provides the code: `http_clients({ service: "<name>", command: "login", args: { profile: "<profile>", otp: "<code>" } })`
4. Retry the original operation.

## Error handling

- `auth_required` — follow re-authentication flow above
- `cli_error` with help text — normal discovery output, read `message` field
- `cli_error` with other content — report the error message to the user
- Network/fetch error — report that the host service is unreachable

## Output

- Summarize results in natural language — don't dump raw JSON
- Use the messaging format appropriate for the channel (Telegram markdown, Slack mrkdwn, etc.)
- Be concise: totals, dates, and key details — skip noise
```

Key changes from the original:
- `allowed-tools: Bash(http-clients *)` → `allowed-tools: mcp__nanoclaw__http_clients`
- Discovery uses MCP tool calls, not Bash commands
- Re-auth flows added (were only in CLAUDE.local.md before)
- Error handling updated for MCP response format

- [ ] **Step 2: Commit**

```bash
git add container/skills/http-clients/SKILL.md
git commit -m "feat: rewrite http-clients SKILL.md for MCP tool

Replaces Bash(http-clients *) with mcp__nanoclaw__http_clients.
Adds discovery workflow, re-auth flows, error handling.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: Clean up CLAUDE.local.md

**Files:**
- Modify: `groups/dm-with-eudes/CLAUDE.local.md:14-49`

- [ ] **Step 1: Remove http-clients and Costco Monitor sections**

In `groups/dm-with-eudes/CLAUDE.local.md`, remove everything from line 13 (`## http-clients Service`) to end of file (line 49). The file should retain only:

```markdown
# NanoClaw — Eudes (DM)

Personal assistant for Eudes, a senior software engineer in Canada (Toronto area).

Use technical jargon freely — skip over-explanations of dev concepts. He prefers definitive solutions over workarounds, facts over speculation.

## Browser credentials

Saved logins in agent-browser auth vault: `agent-browser auth login <service>`
For 2FA: `bash /workspace/agent/scripts/totp.sh <service>`

Available: linkedin (eudesrodrigo@outlook.com, has TOTP)
```

Three sections removed:
- "## http-clients Service" (now in `http-clients.instructions.md`)
- "### Auth renewal" (now in `SKILL.md`)
- "## Costco Receipt Monitor" (being deleted entirely)

- [ ] **Step 2: Commit**

```bash
git add groups/dm-with-eudes/CLAUDE.local.md
git commit -m "refactor: remove http-clients instructions from CLAUDE.local.md

Generic instructions moved to http-clients.instructions.md (auto-composed)
and SKILL.md. Costco Receipt Monitor removed entirely.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: Remove Costco Receipt Monitor

**Files:**
- Delete: `groups/dm-with-eudes/costco/check_receipts.py` (git-tracked)
- Delete: `groups/dm-with-eudes/costco/state.json` (untracked)
- Delete: `groups/dm-with-eudes/costco/price_cache.json` (untracked)
- Delete: `groups/dm-with-eudes/costco/` (directory)
- Modify: `data/v2-sessions/ag-1777000247524-9397mf/sess-1777000247537-6uackb/inbound.db` (cancel scheduled task)

- [ ] **Step 1: Cancel the scheduled task**

Run:

```bash
sqlite3 /Users/eudesrodrigo/Projects/nanoclaw/data/v2-sessions/ag-1777000247524-9397mf/sess-1777000247537-6uackb/inbound.db \
  "UPDATE messages_in SET status = 'completed', recurrence = NULL WHERE (id = 'task-1777765347844-abf4sk' OR series_id = 'task-1777765347844-abf4sk') AND kind = 'task' AND status IN ('pending', 'paused')"
```

- [ ] **Step 2: Verify cancellation**

Run:

```bash
sqlite3 /Users/eudesrodrigo/Projects/nanoclaw/data/v2-sessions/ag-1777000247524-9397mf/sess-1777000247537-6uackb/inbound.db \
  "SELECT COUNT(*) FROM messages_in WHERE (id = 'task-1777765347844-abf4sk' OR series_id = 'task-1777765347844-abf4sk') AND kind = 'task' AND status IN ('pending', 'paused')"
```

Expected: `0`

- [ ] **Step 3: Delete costco directory and files**

```bash
rm -rf /Users/eudesrodrigo/Projects/nanoclaw/groups/dm-with-eudes/costco/
```

- [ ] **Step 4: Verify deletion**

```bash
ls /Users/eudesrodrigo/Projects/nanoclaw/groups/dm-with-eudes/costco/ 2>&1
```

Expected: `No such file or directory`

- [ ] **Step 5: Commit**

```bash
git add -A groups/dm-with-eudes/costco/
git commit -m "chore: remove Costco Receipt Monitor

Deletes check_receipts.py, state.json, price_cache.json.
Scheduled task task-1777765347844-abf4sk cancelled in inbound.db.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end verification

No files to modify — this is a verification-only task.

- [ ] **Step 1: Run all host tests**

```bash
cd /Users/eudesrodrigo/Projects/nanoclaw && pnpm test -- --run
```

Expected: All tests pass.

- [ ] **Step 2: Run container typecheck**

```bash
cd /Users/eudesrodrigo/Projects/nanoclaw && pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

Expected: No errors.

- [ ] **Step 3: Restart NanoClaw**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-9a8662aa
```

- [ ] **Step 4: Verify instructions fragment is composed**

Wait ~5 seconds for the service to start, then:

```bash
ls /Users/eudesrodrigo/Projects/nanoclaw/groups/dm-with-eudes/.claude-fragments/module-http-clients.md 2>&1
ls /Users/eudesrodrigo/Projects/nanoclaw/groups/dm-with-home/.claude-fragments/module-http-clients.md 2>&1
```

Expected: Both files exist (symlinks to `/app/src/mcp-tools/http-clients.instructions.md`).

- [ ] **Step 5: Test top-level discovery**

```bash
curl -s -X POST http://127.0.0.1:3002/call -H 'content-type: application/json' -d '{}' | python3 -m json.tool
```

Expected: JSON with `status: "error"`, `code: "cli_error"`, and `message` containing help text listing available services.

- [ ] **Step 6: Test service-level discovery**

```bash
curl -s -X POST http://127.0.0.1:3002/call -H 'content-type: application/json' -d '{"service":"costco"}' | python3 -m json.tool
```

Expected: JSON with `status: "error"`, `code: "cli_error"`, and `message` containing help text listing costco commands.

- [ ] **Step 7: Test normal operation (unchanged)**

```bash
curl -s -X POST http://127.0.0.1:3002/call -H 'content-type: application/json' -d '{"service":"costco","command":"profiles"}' | python3 -m json.tool
```

Expected: JSON with `status: "ok"` and `data` containing profile information.

- [ ] **Step 8: Verify scheduled task fully cancelled**

```bash
sqlite3 /Users/eudesrodrigo/Projects/nanoclaw/data/v2-sessions/ag-1777000247524-9397mf/sess-1777000247537-6uackb/inbound.db \
  "SELECT COUNT(*) FROM messages_in WHERE (id = 'task-1777765347844-abf4sk' OR series_id = 'task-1777765347844-abf4sk') AND kind = 'task' AND status IN ('pending', 'paused')"
```

Expected: `0`
