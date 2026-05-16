# http-clients Host Service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `http-clients` execution from container to host, exposing it as an HTTP service that containers call via MCP tool — credentials never enter the container.

**Architecture:** A stateless HTTP service on the host wraps the `http-clients` CLI (`child_process.spawn`). Containers get a thin MCP tool that POSTs to the host service. The existing pre-check script is rewritten to use `urllib.request` instead of importing the Python package directly.

**Tech Stack:** Node.js `http.createServer` (host service), Bun + `@modelcontextprotocol/sdk` (container MCP tool), Python stdlib (pre-check script)

**Spec:** `docs/superpowers/specs/2026-05-16-http-clients-host-service-design.md`

**Restore point:** Commit `4c5de0e`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/config.ts` | Modify | Add `HTTP_CLIENTS_PORT` constant |
| `src/http-clients-service.ts` | Create | Host HTTP service — wraps CLI, returns JSON |
| `src/http-clients-service.test.ts` | Create | Integration tests for the host service |
| `src/index.ts` | Modify | Start the service at boot |
| `src/container-runner.ts` | Modify | Pass `HTTP_CLIENTS_URL` env var to containers |
| `container/agent-runner/src/mcp-tools/http-clients.ts` | Create | MCP tool — thin HTTP POST wrapper |
| `container/agent-runner/src/mcp-tools/index.ts` | Modify | Import new tool module |
| `groups/dm-with-eudes/costco/check_receipts.py` | Rewrite | HTTP calls instead of Python imports |
| `container/Dockerfile` | Modify | Remove http-clients block (lines 101–104) |
| `container/build.sh` | Modify | Remove rsync staging block (lines 35–43) |
| `groups/dm-with-eudes/container.json` | Modify | Remove http-clients additionalMount |
| `groups/dm-with-home/container.json` | Modify | Remove http-clients additionalMount |

---

## Task 1: Verify prerequisites

**Files:** (none modified)

- [ ] **Step 1: Verify `http-clients` CLI is installed on the host**

Run:
```bash
which http-clients && http-clients --help
```

Expected: CLI is found and prints usage. If not found, install it:
```bash
pip install /Users/eudesrodrigo/Projects/http-clients
```

- [ ] **Step 2: Verify Costco CLI login supports `--token` flag**

Run:
```bash
http-clients costco login --help
```

Expected: Output shows `--token` option for non-interactive token save.

- [ ] **Step 3: Verify Wealthsimple CLI login supports `--otp` flag**

Run:
```bash
http-clients wealthsimple login --help
```

Expected: Output shows `--otp` option. If it does NOT exist, this is a prerequisite gap — the `http-clients` package needs a small change before Task 3. Note the gap and proceed; the host service will work for all commands except Wealthsimple OTP re-auth until the flag is added.

---

## Task 2: Remove old integration

**Files:**
- Modify: `container/Dockerfile:101-104`
- Modify: `container/build.sh:35-43`
- Modify: `groups/dm-with-eudes/container.json:47-53`
- Modify: `groups/dm-with-home/container.json:46-52`

- [ ] **Step 1: Remove http-clients block from Dockerfile**

In `container/Dockerfile`, delete lines 101–104:
```dockerfile
# ---- http-clients (Python) ---------------------------------------------------
COPY http-clients/ /tmp/http-clients/
RUN pip install --break-system-packages /tmp/http-clients/ && rm -rf /tmp/http-clients/
ENV HTTP_CLIENTS_TOKENS=/workspace/extra/http-clients/tokens.json
```

- [ ] **Step 2: Remove rsync staging from build.sh**

In `container/build.sh`, delete lines 35–43:
```bash
# ---- Stage http-clients Python package into build context --------------------
HTTP_CLIENTS_SRC="${HTTP_CLIENTS_SRC:-$PROJECT_ROOT/../http-clients}"
if [ -d "$HTTP_CLIENTS_SRC" ]; then
    echo "Staging http-clients from $HTTP_CLIENTS_SRC"
    rsync -a --exclude='.venv' --exclude='__pycache__' --exclude='.git' \
        "$HTTP_CLIENTS_SRC/" "$SCRIPT_DIR/http-clients/"
    trap 'rm -rf "$SCRIPT_DIR/http-clients"' EXIT
else
    echo "Warning: http-clients not found at $HTTP_CLIENTS_SRC — skipping"
fi
```

- [ ] **Step 3: Remove additionalMounts from dm-with-eudes container.json**

In `groups/dm-with-eudes/container.json`, remove the http-clients entry from the `additionalMounts` array:
```json
{
  "hostPath": "/Users/eudesrodrigo/.config/http-clients",
  "containerPath": "http-clients",
  "readonly": false
}
```

If this is the only entry in `additionalMounts`, set `"additionalMounts": []`.

- [ ] **Step 4: Remove additionalMounts from dm-with-home container.json**

Same removal in `groups/dm-with-home/container.json`.

- [ ] **Step 5: Commit**

```bash
git add container/Dockerfile container/build.sh groups/dm-with-eudes/container.json groups/dm-with-home/container.json
git commit -m "Remove old http-clients container integration

Remove source staging (build.sh), pip install (Dockerfile), and
credential mount (container.json) for both agent groups. Credentials
will be served via a host-side HTTP service instead."
```

---

## Task 3: Add HTTP_CLIENTS_PORT config

**Files:**
- Modify: `src/config.ts:36`

- [ ] **Step 1: Add port constant**

In `src/config.ts`, add after line 36 (`CREDENTIAL_PROXY_PORT`):

```typescript
export const HTTP_CLIENTS_PORT = parseInt(process.env.HTTP_CLIENTS_PORT || '3002', 10);
```

- [ ] **Step 2: Commit**

```bash
git add src/config.ts
git commit -m "Add HTTP_CLIENTS_PORT config constant (default 3002)"
```

---

## Task 4: Create host HTTP service with tests (TDD)

**Files:**
- Create: `src/http-clients-service.ts`
- Create: `src/http-clients-service.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/http-clients-service.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';

import { startHttpClientsService } from './http-clients-service.js';

function makeRequest(
  port: number,
  body: object,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/call', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('http-clients-service', () => {
  let server: http.Server;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it('returns 404 for non /call paths', async () => {
    server = await startHttpClientsService(0);
    const port = (server.address() as { port: number }).port;

    const { status } = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/other', method: 'GET' }, (res) => {
        res.resume();
        resolve({ status: res.statusCode! });
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(404);
  });

  it('returns 400 when service is missing', async () => {
    server = await startHttpClientsService(0);
    const port = (server.address() as { port: number }).port;

    const { status, data } = await makeRequest(port, { command: 'receipts' });
    expect(status).toBe(400);
    expect(data.status).toBe('error');
  });

  it('returns 400 when command is missing', async () => {
    server = await startHttpClientsService(0);
    const port = (server.address() as { port: number }).port;

    const { status, data } = await makeRequest(port, { service: 'costco' });
    expect(status).toBe(400);
    expect(data.status).toBe('error');
  });

  it('calls CLI and returns JSON output on success', async () => {
    server = await startHttpClientsService(0);
    const port = (server.address() as { port: number }).port;

    const { status, data } = await makeRequest(port, {
      service: 'costco',
      command: 'receipts',
      args: { profile: 'eudes', type: 'warehouse', start: '2026-05-13', end: '2026-05-16' },
    });

    // CLI may succeed or fail depending on whether credentials exist on this host.
    // We verify the service handles both cases without crashing.
    expect(status).toBeGreaterThanOrEqual(200);
    expect(data.status).toBeDefined();
  });

  it('returns 405 for non-POST methods', async () => {
    server = await startHttpClientsService(0);
    const port = (server.address() as { port: number }).port;

    const { status } = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/call', method: 'GET' }, (res) => {
        res.resume();
        resolve({ status: res.statusCode! });
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(405);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pnpm test -- src/http-clients-service.test.ts
```

Expected: FAIL — module `./http-clients-service.js` not found.

- [ ] **Step 3: Implement the service**

Create `src/http-clients-service.ts`:

```typescript
import { createServer, Server } from 'http';
import { spawn } from 'child_process';

import { log } from './log.js';

export function startHttpClientsService(port: number, host = '127.0.0.1'): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url !== '/call') {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body: { service?: string; command?: string; args?: Record<string, string> };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          respond(res, 400, { status: 'error', message: 'Invalid JSON' });
          return;
        }

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

        runCli(cliArgs)
          .then((result) => respond(res, 200, result))
          .catch((err) => {
            log.error('http-clients-service CLI error', { err, service, command });
            respond(res, 500, { status: 'error', message: err instanceof Error ? err.message : String(err) });
          });
      });
    });

    server.listen(port, host, () => {
      log.info('http-clients service started', { port, host });
      resolve(server);
    });
    server.on('error', reject);
  });
}

function respond(res: import('http').ServerResponse, statusCode: number, data: object): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function runCli(args: string[]): Promise<object> {
  return new Promise((resolve, reject) => {
    const proc = spawn('http-clients', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on('data', (d) => stdout.push(d));
    proc.stderr.on('data', (d) => stderr.push(d));

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      const out = Buffer.concat(stdout).toString().trim();
      const errOut = Buffer.concat(stderr).toString().trim();

      if (code === 0 && out) {
        try {
          const data = JSON.parse(out);
          resolve({ status: 'ok', data });
        } catch {
          resolve({ status: 'ok', data: out });
        }
      } else {
        const isAuthError = errOut.includes('TokenNotFoundError') || errOut.includes('AuthenticationError');
        const flow = errOut.includes('TokenNotFoundError') ? 'token' : 'otp';
        if (isAuthError) {
          resolve({
            status: 'error',
            code: 'auth_required',
            flow,
            message: errOut.split('\n')[0],
          });
        } else {
          resolve({
            status: 'error',
            code: 'cli_error',
            exitCode: code,
            message: errOut || out || `CLI exited with code ${code}`,
          });
        }
      }
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
pnpm test -- src/http-clients-service.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http-clients-service.ts src/http-clients-service.test.ts
git commit -m "Add http-clients host service with integration tests

Stateless HTTP service wrapping the http-clients CLI. Listens on
127.0.0.1, containers reach it via host.docker.internal. Detects
auth errors (TokenNotFoundError, AuthenticationError) and returns
structured error responses."
```

---

## Task 5: Wire service into host startup

**Files:**
- Modify: `src/index.ts:9-10` (imports) and `~75-80` (startup block)

- [ ] **Step 1: Add import**

In `src/index.ts`, add to the import block (near line 9 where `CREDENTIAL_PROXY_PORT` is imported):

```typescript
import { HTTP_CLIENTS_PORT } from './config.js';
import { startHttpClientsService } from './http-clients-service.js';
```

- [ ] **Step 2: Start the service after credential proxy**

In `src/index.ts`, after the credential proxy startup block (after line 80):

```typescript
  const httpClientsServer = await startHttpClientsService(HTTP_CLIENTS_PORT, PROXY_BIND_HOST);
  onShutdown(() => {
    httpClientsServer.close();
    return Promise.resolve();
  });
```

- [ ] **Step 3: Verify build**

Run:
```bash
pnpm run build
```

Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "Start http-clients service at host boot (port 3002)"
```

---

## Task 6: Pass HTTP_CLIENTS_URL env var to containers

**Files:**
- Modify: `src/container-runner.ts:454` (env injection block)

- [ ] **Step 1: Add env var injection**

In `src/container-runner.ts`, add the import at the top alongside `CREDENTIAL_PROXY_PORT`:

```typescript
import { HTTP_CLIENTS_PORT } from './config.js';
```

Then in `buildContainerArgs()`, after line 454 (`ANTHROPIC_BASE_URL`), add:

```typescript
  args.push('-e', `HTTP_CLIENTS_URL=http://${CONTAINER_HOST_GATEWAY}:${HTTP_CLIENTS_PORT}`);
```

- [ ] **Step 2: Verify build**

Run:
```bash
pnpm run build
```

Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/container-runner.ts
git commit -m "Pass HTTP_CLIENTS_URL env var to agent containers"
```

---

## Task 7: Create container MCP tool

**Files:**
- Create: `container/agent-runner/src/mcp-tools/http-clients.ts`
- Modify: `container/agent-runner/src/mcp-tools/index.ts`

- [ ] **Step 1: Create the MCP tool**

Create `container/agent-runner/src/mcp-tools/http-clients.ts`:

```typescript
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const HTTP_CLIENTS_URL = process.env.HTTP_CLIENTS_URL;

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const httpClientsTool: McpToolDefinition = {
  tool: {
    name: 'http_clients',
    description:
      'Call the http-clients service on the host for API access (Costco, Wealthsimple, etc). ' +
      'Credentials are managed securely on the host — this tool never sees them. ' +
      'Returns JSON from the CLI. On auth failure, returns {status:"error", code:"auth_required", flow:"token"|"otp"}.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name (e.g. costco, wealthsimple)' },
        command: { type: 'string', description: 'CLI command (e.g. receipts, positions, login, membership)' },
        args: {
          type: 'object',
          description: 'Key-value pairs passed as CLI flags (e.g. {profile: "eudes", type: "warehouse"})',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['service', 'command'],
    },
  },
  handler: async (params) => {
    if (!HTTP_CLIENTS_URL) {
      return err('HTTP_CLIENTS_URL not configured — host service not available');
    }

    const { service, command, args } = params as { service: string; command: string; args?: Record<string, string> };

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

registerTools([httpClientsTool]);
```

- [ ] **Step 2: Register in barrel**

In `container/agent-runner/src/mcp-tools/index.ts`, add the import before the `startMcpServer()` call:

```typescript
import './http-clients.js';
```

- [ ] **Step 3: Verify container typecheck**

Run:
```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/mcp-tools/http-clients.ts container/agent-runner/src/mcp-tools/index.ts
git commit -m "Add http_clients MCP tool for container agents

Thin HTTP wrapper that calls the host http-clients service.
Agents use this tool for Costco/Wealthsimple API access without
ever seeing credentials."
```

---

## Task 8: Rewrite pre-check script

**Files:**
- Rewrite: `groups/dm-with-eudes/costco/check_receipts.py`

- [ ] **Step 1: Rewrite the script**

Replace `groups/dm-with-eudes/costco/check_receipts.py` with:

```python
#!/usr/bin/env python3
"""
Pre-check script for Costco receipt monitoring.
Calls the host http-clients service instead of importing the package directly.
Returns wakeAgent: true only when new receipts are found.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

HOST_URL = os.environ.get('HTTP_CLIENTS_URL', '')
STATE_FILE = Path(__file__).parent / 'state.json'
PROFILES = ['eudes', 'magda']


def call_host(service, command, **args):
    if not HOST_URL:
        raise RuntimeError('HTTP_CLIENTS_URL not set')
    payload = json.dumps({'service': service, 'command': command, 'args': args}).encode()
    req = urllib.request.Request(
        f'{HOST_URL}/call',
        data=payload,
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read())


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {p: [] for p in PROFILES}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def get_recent_receipts(profile, days=3):
    end_date = datetime.now()
    start_date = end_date - timedelta(days=days)
    result = call_host(
        'costco', 'receipts',
        profile=profile,
        type='warehouse',
        sub_type='all',
        start=start_date.strftime('%Y-%m-%d'),
        end=end_date.strftime('%Y-%m-%d'),
    )
    if result.get('status') != 'ok':
        raise RuntimeError(f"Host service error: {result.get('message', result)}")
    data = result.get('data', {})
    if isinstance(data, dict):
        return data.get('receiptsWithCounts', {}).get('receipts', [])
    return []


def main():
    state = load_state()
    new_receipts = {}

    for profile in PROFILES:
        try:
            receipts = get_recent_receipts(profile)
            known = set(state.get(profile, []))
            found = []
            for r in receipts:
                barcode = r.get('transactionBarcode')
                if barcode and barcode not in known:
                    found.append({
                        'barcode': barcode,
                        'date': r.get('transactionDateTime', ''),
                        'total': r.get('total', 0),
                        'profile': profile,
                    })
            if found:
                new_receipts[profile] = found
                updated = list(known) + [r['barcode'] for r in found]
                state[profile] = updated[-100:]
        except Exception as e:
            sys.stderr.write(f'[{profile}] {e}\n')

    if new_receipts:
        save_state(state)
        print(json.dumps({'wakeAgent': True, 'data': {'new_receipts': new_receipts}}))
    else:
        print(json.dumps({'wakeAgent': False}))


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Verify the script parses without errors**

Run:
```bash
python3 -c "import ast; ast.parse(open('groups/dm-with-eudes/costco/check_receipts.py').read()); print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add groups/dm-with-eudes/costco/check_receipts.py
git commit -m "Rewrite Costco pre-check to call host http-clients service

Uses urllib.request (stdlib) instead of importing http_clients.
No Python packages needed in the container for this script."
```

---

## Task 9: Update CLAUDE.local.md with auth renewal instructions

**Files:**
- Modify: `groups/dm-with-eudes/CLAUDE.local.md`

- [ ] **Step 1: Add http-clients service section and update Costco monitor**

In `groups/dm-with-eudes/CLAUDE.local.md`, replace the "Costco Receipt Monitor" section and add an "http-clients Service" section:

```markdown
## http-clients Service

API access to Costco and Wealthsimple is provided by the `http_clients` MCP tool, which calls a host-side service. Credentials are managed on the host — this agent never sees them.

### Auth renewal

When any `http_clients` call returns `{status: "error", code: "auth_required"}`:

**Costco (flow: "token")**:
1. Message the user: "🔑 Costco token expired for profile '<profile>'. Open costco.ca → DevTools → Application → Cookies → copy the refresh_token value and send it here."
2. When the user provides the token, call: `http_clients(service="costco", command="login", args={profile: "<profile>", token: "<token>"})`
3. Retry the original operation.

**Wealthsimple (flow: "otp")**:
1. Call: `http_clients(service="wealthsimple", command="login", args={profile: "<profile>"})`
2. If response is `{status: "otp_required"}`, message the user: "📱 Wealthsimple OTP sent to your phone. Send me the code."
3. When the user provides the code, call: `http_clients(service="wealthsimple", command="login", args={profile: "<profile>", otp: "<code>"})`
4. Retry the original operation.

## Costco Receipt Monitor

**Task ID:** task-1777765347844-abf4sk
**Schedule:** every 15 min
**Script:** `/workspace/agent/costco/check_receipts.py`
**State file:** `/workspace/agent/costco/state.json` (seeded with 90-day history; eudes: 7, magda: 8)
**Price cache:** `/workspace/agent/costco/price_cache.json`

When woken: use the `http_clients` tool to fetch full receipt details, count 3-month frequency, compare unit prices ($/100g, $/L).
Sends TWO messages to 'telegram-mg-17772' (Home group):
1. 🛒 Price analysis (💰 savings ≥15%, 🔁 recurring, ✓ competitive)
2. 🥗 Nutritional analysis (🚨 flags only, ✓ clean items grouped)

Format rules: each alert on its own line; combine all new receipts (both profiles) into one aggregate; no tables; no buyer separation in body.

Profiles monitored: eudes, magda (Costco warehouse 894)
```

- [ ] **Step 2: Commit**

```bash
git add groups/dm-with-eudes/CLAUDE.local.md
git commit -m "Update CLAUDE.local.md with http-clients service instructions

Add auth renewal flows (Costco token, Wealthsimple OTP) and
update Costco monitor to reference the http_clients MCP tool."
```

---

## Task 10: Rebuild container image and verify


**Files:** (none modified — build and manual verification)

- [ ] **Step 1: Rebuild the container image**

Run:
```bash
./container/build.sh
```

Expected: Build succeeds. The http-clients COPY/pip install steps are gone — the build should be faster. No "Staging http-clients" message in output.

- [ ] **Step 2: Run host tests**

Run:
```bash
pnpm test
```

Expected: All tests pass, including the new `http-clients-service.test.ts`.

- [ ] **Step 3: Run container typecheck**

Run:
```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

Expected: No errors.

- [ ] **Step 4: Verify host service starts**

Run:
```bash
pnpm run dev
```

Expected: Log output includes `http-clients service started { port: 3002, host: '127.0.0.1' }`.

Stop the dev server after verifying.

- [ ] **Step 5: Test the service directly**

Run (in a separate terminal while dev server is running):
```bash
curl -s -X POST http://127.0.0.1:3002/call \
  -H 'Content-Type: application/json' \
  -d '{"service":"costco","command":"membership","args":{"profile":"eudes"}}' | python3 -m json.tool
```

Expected: JSON response with either `{status: "ok", data: {...}}` or `{status: "error", code: "auth_required", ...}` (depending on whether Costco tokens are valid).

---

## Task 11: Restart service and verify end-to-end

**Files:** (none modified — operational verification)

- [ ] **Step 1: Restart the NanoClaw service**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 2: Check host logs for service startup**

```bash
tail -20 logs/nanoclaw.log | grep -i "http-clients"
```

Expected: Log line confirming the service started on port 3002.

- [ ] **Step 3: Verify container receives the env var**

Wait for a container to start (or trigger one via Telegram), then check:
```bash
docker exec $(docker ps -q --filter label=nanoclaw-install -l) env | grep HTTP_CLIENTS
```

Expected: `HTTP_CLIENTS_URL=http://host.docker.internal:3002`

- [ ] **Step 4: Verify the MCP tool is registered**

Check container logs for MCP tool registration:
```bash
docker logs $(docker ps -q --filter label=nanoclaw-install -l) 2>&1 | grep -i "http_clients"
```

Expected: MCP server tool list includes `http_clients`.

- [ ] **Step 5: Test via Telegram**

Send a message to the agent asking it to check Costco membership or recent receipts. The agent should use the `http_clients` MCP tool, which calls the host service.

If auth fails, the agent should report the error and ask for a new token — this confirms the auth error flow works end-to-end.
