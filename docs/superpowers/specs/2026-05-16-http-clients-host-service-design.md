# http-clients Host Service Integration

## Problem

The `http-clients` Python package (Costco, Wealthsimple API clients) is currently installed inside agent containers with credentials mounted directly from the host filesystem. This violates NanoClaw's security model where containers should never see raw secrets.

The current integration:
- Copies `http-clients` source into the Docker build context via `build.sh` rsync
- Installs via `pip install` in the Dockerfile
- Mounts `~/.config/http-clients` into the container (read/write) via `additionalMounts`
- The agent can read refresh tokens, passwords, and credential files directly

## Solution

Move `http-clients` execution entirely to the host. Containers access it through a lightweight HTTP service — the same pattern used by the existing credential-proxy.

## Architecture

```
HOST (macOS)
├── ~/.config/http-clients/credentials/credentials.json
│     ▲ read/write (only http-clients CLI touches this)
│
├── http-clients-service (HTTP, 127.0.0.1:<port>)
│     POST /call → spawn http-clients CLI → return JSON
│     ▲
│     │ HTTP via host.docker.internal
│
CONTAINER
├── MCP tool: http_clients (thin HTTP POST wrapper)
├── pre-check scripts (urllib.request to host service)
├── ❌ No http-clients package
└── ❌ No credential mount
```

**Credentials never enter the container.** The host service is a stateless CLI wrapper — no sessions, no business logic, no command validation.

## Components

### 1. Host HTTP Service (`src/http-clients-service.ts`)

Analogous to `credential-proxy.ts`. Listens on `127.0.0.1:<HTTP_CLIENTS_PORT>`.

**Single route: `POST /call`**

Request body:
```json
{
  "service": "costco",
  "command": "receipts",
  "args": {
    "profile": "eudes",
    "type": "warehouse",
    "start": "2026-05-13",
    "end": "2026-05-16"
  }
}
```

Execution: `child_process.spawn("http-clients", [service, command, ...flattenArgs(args)])`, capture stdout, parse JSON, return.

Response envelope:
```json
{"status": "ok", "data": { ... }}
```

On CLI non-zero exit or stderr indicating auth failure:
```json
{"status": "error", "code": "auth_required", "service": "costco", "profile": "eudes", "message": "Refresh token expired"}
```

On OTP-required (Wealthsimple login step 1):
```json
{"status": "otp_required", "message": "OTP sent to phone ending in XX34"}
```

The service does NOT interpret or transform the CLI output beyond wrapping it in the envelope. It does NOT maintain state between requests — the CLI uses `credentials.json` on the host filesystem for inter-call state (e.g., `otp_claim` between Wealthsimple login steps).

### 2. Container MCP Tool (`container/agent-runner/src/mcp-tools/http-clients.ts`)

Thin HTTP wrapper registered as an MCP tool.

```
Tool name: http_clients
Description: Call the http-clients service on the host for Costco and Wealthsimple API access.
             Credentials are managed securely on the host — this tool never sees them.

Input schema:
  service: string (enum: costco, wealthsimple)
  command: string (e.g., receipts, positions, login, membership)
  args: object (key-value pairs passed as CLI flags)

Output: JSON from the host service
```

Implementation: HTTP POST to `process.env.HTTP_CLIENTS_URL + "/call"` using fetch, return parsed JSON.

### 3. Pre-check Script (rewritten)

Replace `groups/dm-with-eudes/costco/check_receipts.py` with a version that calls the host service via HTTP instead of importing `http_clients` directly.

Uses only Python stdlib (`urllib.request`, `json`, `pathlib`) — no external dependencies needed in the container.

The comparison logic (known barcodes in `state.json` vs. receipts from API) stays the same. Only the data source changes: `CostcoClient(profile=...)` becomes `urllib.request.urlopen(HOST_URL + "/call", ...)`.

### 4. Host Startup (`src/index.ts`)

Start the service alongside the credential proxy during host initialization:

```typescript
import { startHttpClientsService } from './http-clients-service.js';
await startHttpClientsService(HTTP_CLIENTS_PORT);
```

### 5. Container Runner (`src/container-runner.ts`)

Pass the service URL as an environment variable to containers:

```typescript
args.push('-e', `HTTP_CLIENTS_URL=http://${CONTAINER_HOST_GATEWAY}:${HTTP_CLIENTS_PORT}`);
```

## Auth Renewal Flows

The host service returns structured errors when authentication fails. The agent handles renewal using CLAUDE.local.md instructions — the service does not orchestrate the flow.

### Costco (token expired)

1. Any API call fails → service returns `{status: "error", code: "auth_required", flow: "token"}`
2. Agent asks user (via Telegram) for a new refresh token
3. Agent calls `{service: "costco", command: "login", args: {profile: "...", token: "<new_token>"}}`
4. Host service runs `http-clients costco login --profile ... --token ...`
5. Token saved on host. Subsequent calls work.

### Wealthsimple (OTP required)

1. Any API call fails → service returns `{status: "error", code: "auth_required", flow: "otp"}`
2. Agent calls `{service: "wealthsimple", command: "login", args: {profile: "..."}}`
3. CLI reads password from macOS Keychain, triggers SMS → service returns `{status: "otp_required"}`
4. Agent asks user for OTP code via Telegram
5. Agent calls `{service: "wealthsimple", command: "login", args: {profile: "...", otp: "123456"}}`
6. CLI uses saved `otp_claim` from credentials.json + OTP → completes login

The host service is stateless throughout — `otp_claim` persists in `credentials.json` between the two CLI invocations.

### OTP Security

OTP codes transit through the agent (user → Telegram → agent → host service). This is acceptable:
- OTPs are single-use and expire in ~5 minutes
- The OTP alone is useless without the password (stays in Keychain, never exposed)
- Agent-mediated OTP is a standard pattern in chatbot authentication

## What Changes

### Removals (old integration — clean up first)

| Target | Lines | Action |
|--------|-------|--------|
| `container/Dockerfile` — http-clients block | 101-104 | **REMOVE** COPY, pip install, ENV HTTP_CLIENTS_TOKENS |
| `container/build.sh` — rsync staging | 35-43 | **REMOVE** HTTP_CLIENTS_SRC, rsync, trap cleanup |
| `groups/dm-with-eudes/container.json` — additionalMounts | 49-50 | **REMOVE** http-clients mount entry |
| `groups/dm-with-home/container.json` — additionalMounts | 48-49 | **REMOVE** http-clients mount entry |

### New and modified

| Target | Action |
|--------|--------|
| `groups/dm-with-eudes/costco/check_receipts.py` | **REWRITE** (HTTP to host service, no Python imports) |
| Host macOS Python environment | **INSTALL** `pip install /Projects/http-clients` |
| `src/http-clients-service.ts` | **NEW** (~100 lines) |
| `container/agent-runner/src/mcp-tools/http-clients.ts` | **NEW** (~60 lines) |
| `src/index.ts` | **MODIFY** (start service) |
| `src/container-runner.ts` | **MODIFY** (add HTTP_CLIENTS_URL env var) |
| `src/env.ts` or constants | **MODIFY** (add HTTP_CLIENTS_PORT) |
| Agent group CLAUDE.local.md files | **UPDATE** (auth renewal instructions) |

## What Does NOT Change

- The agent-runner poll loop or task scheduling system
- The host sweep (`host-sweep.ts`)
- The credential-proxy
- OneCLI integration

## Prerequisites

1. **`http-clients` CLI non-interactive login support**:
   - Costco: `http-clients costco login --profile X --token <refresh_token>` — already supported (`--token` flag exists)
   - Wealthsimple: `http-clients wealthsimple login --profile X --otp <code>` — **may require adding `--otp` flag** to the CLI (current CLI only accepts `--email` and `--password`; OTP step may be interactive)
2. `http-clients` must be installed on the host macOS Python environment
3. The CLI must output JSON to stdout for all commands (already the case)
4. Auth errors must be distinguishable from other errors in CLI exit code or stderr (the package has distinct exception types: `TokenNotFoundError`, `AuthenticationError` — the CLI must surface these as structured output or distinct exit codes)

## Security Properties

- **Credentials isolated**: refresh tokens, passwords, API keys never enter containers
- **Host-only execution**: `http-clients` runs on the host, with host filesystem access
- **Stateless service**: no sessions, no in-memory state, no command validation — just a CLI wrapper
- **Network isolation**: service listens on 127.0.0.1 only; containers reach it via Docker host gateway
- **Ephemeral secrets OK**: OTP codes transit through the agent but are single-use and time-limited
- **No new trust assumptions**: follows the same model as the existing credential-proxy
