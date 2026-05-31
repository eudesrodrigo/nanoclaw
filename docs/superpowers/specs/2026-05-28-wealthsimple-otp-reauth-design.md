# WealthSimple OTP Re-auth via Chat — Design

**Date:** 2026-05-28
**Status:** Approved (Approach A)

## Problem

When a WealthSimple session token expires, the container agent cannot re-authenticate, even though the host already stores the login credentials. In the family-group conversation (2026-05-28, telegram `-1003960451761`), the agent hallucinated that `http-clients` was a local Python script, asked the user for email/password, and never completed re-auth.

### Root cause (verified)

The defect is infrastructure, not (only) the model:

1. **CLI crashes in non-interactive mode.** `wealthsimple login` (`~/Projects/http-clients/src/http_clients/wealthsimple/cli.py`) falls back to interactive `input()`/`getpass()` for email (`:91`), password (`:96`), and OTP (`:103`) when the corresponding flag is absent. The host service spawns the CLI with `stdio: ['ignore', ...]` (`src/http-clients-service.ts:69`), so the OTP `input()` hits EOF → uncaught `EOFError` → Python traceback on stderr, exit 1.
2. **Service does not recognize the OTP signal.** `runCli` (`src/http-clients-service.ts:91`) only detects `TokenNotFoundError`/`AuthenticationError`. The `EOFError`/`OTPRequired` traceback falls through to a generic `cli_error`, so the agent never receives the documented `{code:"auth_required", flow:"otp"}`.
3. **Prompt allows the wrong mental model.** `SKILL.md` / `http-clients.instructions.md` do not forbid asking for credentials, and the `flow:"token"` branch (Costco's "paste refresh_token" pattern) is wrong for WealthSimple, whose recovery is `login`.

### Key constraint: OTP is asynchronous

The OTP arrives as a future chat message in a later agent turn. The host service is request/response with a 30s timeout — it cannot block waiting for the user to type the code. Therefore OTP re-auth **must** be orchestrated by the agent across two turns. The host/CLI can only automate the *silent* path (when the saved `otp_claim` is still valid and no fresh OTP is needed).

## Goal

When WealthSimple auth expires, the agent re-authenticates using host-stored credentials, prompting the user only for the OTP code via chat. Credentials (email/password) never leave the host and are never requested from the user.

## Design (Approach A)

### Guiding principle

The agent responds to **any** WealthSimple `auth_required` by calling `login`. Only the `login` response decides whether an OTP is needed. The agent does not depend on the `flow` value of the read command (`positions`).

### Change 1 — CLI (`~/Projects/http-clients`): non-interactive safety

Editable install (`Editable project location: /Users/eudesrodrigo/Projects/http-clients`) → source edits take effect immediately, no reinstall.

Detect non-interactive mode via `sys.stdin.isatty()` (verified: returns `False` under the service's `stdio:'ignore'` spawn; `True` for human terminal use).

In `wealthsimple/cli.py login`:
- OTP path (`except _auth.OTPRequired`): if `--otp` absent **and** `not sys.stdin.isatty()` → `typer.echo(f"OTPRequired:{otp_exc.hint}", err=True)` + `raise typer.Exit(2)`. With a TTY, keep the existing interactive `input()`.
- email (`:91`) and password (`:96`): same guard — if missing after saved/flag resolution and non-interactive, raise a clean recognizable error instead of prompting. (Defense in depth; saved credentials cover the normal case.)

Generalize the same one-line `isatty()` guard to Costco's `token = input(...)` (`costco/cli.py:60`) — identical footgun.

Human terminal use is unchanged (TTY present → prompts as before).

### Change 2 — Service (`nanoclaw/src/http-clients-service.ts`): recognize OTP

In `runCli`, before the existing checks: if stderr contains `OTPRequired:` → resolve `{status:"error", code:"auth_required", flow:"otp", hint:<parsed from OTPRequired:...>, message:<first stderr line>}`. Existing `TokenNotFoundError`/`AuthenticationError` handling stays.

### Change 3 — Prompt: `SKILL.md` + `http-clients.instructions.md`

Harden the WealthSimple re-auth flow (model-proof):
- NEVER ask for email or password — the host has them; this agent never sees credentials.
- NEVER look for local files or shell out for http-clients; the MCP tool is the only interface.
- For wealthsimple, on any `auth_required`: call `http_clients({service:'wealthsimple', command:'login', args:{profile:'<p>'}})`.
  - Success → retry the original command.
  - `auth_required/flow:"otp"` → message the user: "Código OTP enviado para seu telefone{hint}. Me manda o código." → on reply: `login` with `args:{profile, otp:'<code>'}` → retry.

## Component boundaries

- CLI speaks a deterministic error vocabulary (`OTPRequired:<hint>` on stderr, exit 2).
- Service translates that vocabulary into the tool's JSON contract (`auth_required/flow:otp`).
- Prompt trusts the contract; it never inspects host/container internals.

No layer needs to know another's internals.

## Testing

- **TDD (service):** `src/http-clients-service.test.ts` — a CLI run whose stderr contains `OTPRequired:...` maps to `{code:"auth_required", flow:"otp"}`. Write failing test first.
- **CLI:** if the http-clients repo has tests, add a case asserting non-interactive `login` with OTP required exits 2 with the `OTPRequired` marker (and does not call `input()`).
- **End-to-end (Telegram), reversible:**
  1. Back up `~/.config/http-clients/credentials/credentials.json`.
  2. Tier A (no SMS): invalidate only the `refresh_token` for a profile → `positions` fails → agent calls `login` → saved email/password + valid `otp_claim` → login succeeds silently → data returned.
  3. Tier B (real SMS): also clear `otp_claim` → `login` requires fresh OTP → agent prompts user → user provides code from phone → `login --otp` → data returned.
  4. Restore the backup.

## Deploy

- CLI: editable install — no reinstall.
- Service (host TS): `pnpm run build` + restart host.
- Prompt/SKILL (baked/mounted into container): `./container/build.sh` + restart.

## Out of scope

- Switching the family group off Kimi to Claude (separate decision; does not fix the infra bug).
- Cleaning up stale `data/env/env` (dead LiteLLM config) — noted separately, unrelated to this fix.
- Migrating away from the legacy `wealthsimple.json.bak` token format.
