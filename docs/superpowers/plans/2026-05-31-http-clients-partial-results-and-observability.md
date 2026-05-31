# http-clients Partial Results + Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `http-clients` behave well for its real consumer — an async, multi-profile, LLM-driven "user" — by returning partial results on multi-profile reads (with per-profile error attribution), parallelizing per-account fetches, and logging every host-service call.

**Architecture:** Two repos. The **package** (`~/Projects/http-clients`, editable install) gains a per-profile partial-run helper and concurrent position fetches. The **nanoclaw host service** (`src/http-clients-service.ts`) gains per-call logging. The MCP **prompt** (mounted skill + instructions) learns to consume the partial shape. The host's `classifyCliResult` needs **no change** — a partial result is exit 0 + JSON and already flows through as `{status:"ok", data}`.

**Tech Stack:** Python 3.13 + Typer + httpx + pytest/respx/ruff/mypy (package); TypeScript + Node + vitest + prettier (nanoclaw host).

**Maps to the four agreed items:** #1 partial results (Tasks A1–A3), #2 profile attribution (absorbed into A1's error descriptor), #3 parallelize reads (Task A4), #4 host-service logging (Task B1). Prompt consumption in Task B2.

---

## Design decisions (locked)

- **Partial only when multiple profiles.** `resolve_profiles(...) > 1` → collect per-profile `{results, errors}`, exit 0. Single profile → re-raise so the existing stderr signal (`AuthenticationError`/`TokenNotFoundError`/`TransientError` → exit 1/2) and host `classifyCliResult` mapping stay intact. This is backward compatible: existing single-profile OTP re-auth is unchanged.
- **Output shape.** Multi-profile with no errors → current plain `{profile: data}` dict (unchanged). Multi-profile with ≥1 error → `{"results": {profile: data}, "errors": {profile: <descriptor>}}`.
- **Error descriptor vocabulary** mirrors the host's `classifyCliResult`: `TokenNotFoundError`→`{code:"auth_required", flow:"token"}`, `AuthenticationError`→`{code:"auth_required", flow:"otp"}`, `TransientError`→`{code:"transient"}`, other `HttpClientError`→`{code:"cli_error"}`. Every descriptor includes `profile`. Non-`HttpClientError` exceptions propagate (real bugs must not be swallowed).
- **Concurrency only within a profile.** `get_all_positions` fetches accounts first (warms the token), then `asyncio.gather`s the per-account position calls. Profiles stay sequential to avoid concurrent `credentials.json` writes.
- **Scope:** Wealthsimple `positions`/`accounts` only. Costco `receipts` can reuse the same helper later (out of scope here).

---

## File structure

**Package (`~/Projects/http-clients`):**
- Modify `src/http_clients/_cli.py` — add `error_descriptor()` helper.
- Modify `src/http_clients/wealthsimple/cli.py` — add `_run_per_profile()` + `_output_partial()`; rewrite `positions` and `accounts` to use them.
- Modify `src/http_clients/wealthsimple/client.py` — parallelize `get_all_positions`.
- Modify `pyproject.toml` — version bump.
- Tests: `tests/http_clients/test_cli.py`, `tests/http_clients/wealthsimple/test_cli.py` (existing client tests already cover A4).

**nanoclaw (`~/Projects/nanoclaw`):**
- Modify `src/http-clients-service.ts` — per-call logging.
- Modify `src/http-clients-service.test.ts` — logging test.
- Modify `container/skills/http-clients/SKILL.md` and `container/agent-runner/src/mcp-tools/http-clients.instructions.md` — partial-result handling.

All package commands run from `~/Projects/http-clients`. All nanoclaw commands run from `~/Projects/nanoclaw`.

---

# Part A — Package (`~/Projects/http-clients`)

### Task A1: `error_descriptor` helper

**Files:**
- Modify: `src/http_clients/_cli.py`
- Test: `tests/http_clients/test_cli.py`

- [ ] **Step 1: Write the failing tests**

Add to `tests/http_clients/test_cli.py` — add `error_descriptor` to the existing `_cli` import line, and add `from http_clients._exceptions import AuthenticationError, GraphQLResponseError, HttpClientError, TokenNotFoundError, TransientError` (extend the existing import), then add this class:

```python
class TestErrorDescriptor:
    def test_token_not_found_maps_to_auth_required_token(self):
        d = error_descriptor("eudes", TokenNotFoundError("no token", service="wealthsimple"))
        assert d == {"profile": "eudes", "code": "auth_required", "flow": "token", "message": "no token"}

    def test_authentication_error_maps_to_auth_required_otp(self):
        d = error_descriptor("eudes", AuthenticationError("bad", service="wealthsimple"))
        assert d["code"] == "auth_required"
        assert d["flow"] == "otp"
        assert d["profile"] == "eudes"

    def test_transient_error_maps_to_transient(self):
        d = error_descriptor("magda", TransientError("timeout", service="wealthsimple"))
        assert d == {"profile": "magda", "code": "transient", "message": "timeout"}

    def test_other_http_client_error_maps_to_cli_error(self):
        d = error_descriptor("eudes", HttpClientError("weird", service="x"))
        assert d["code"] == "cli_error"
        assert d["profile"] == "eudes"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/http_clients/test_cli.py::TestErrorDescriptor -q`
Expected: FAIL — `ImportError: cannot import name 'error_descriptor'`.

- [ ] **Step 3: Implement the helper**

In `src/http_clients/_cli.py`, change the exceptions import to include the new types and add the function. Replace:

```python
from ._exceptions import AuthenticationError, GraphQLResponseError, HttpClientError
```

with:

```python
from ._exceptions import (
    AuthenticationError,
    GraphQLResponseError,
    HttpClientError,
    TokenNotFoundError,
    TransientError,
)
```

Then add, right after the `otp_or_fail` function:

```python
def error_descriptor(profile: str, exc: HttpClientError) -> dict[str, Any]:
    """Map a recoverable client error to the same JSON vocabulary the nanoclaw
    host service emits, tagged with the profile it came from.

    Used for multi-profile partial results: one profile's failure must not abort
    the others, and the agent needs to know *which* profile to recover.
    """
    if isinstance(exc, TokenNotFoundError):
        return {"profile": profile, "code": "auth_required", "flow": "token", "message": str(exc)}
    if isinstance(exc, TransientError):
        return {"profile": profile, "code": "transient", "message": str(exc)}
    if isinstance(exc, AuthenticationError):
        return {"profile": profile, "code": "auth_required", "flow": "otp", "message": str(exc)}
    return {"profile": profile, "code": "cli_error", "message": str(exc)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/http_clients/test_cli.py::TestErrorDescriptor -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add src/http_clients/_cli.py tests/http_clients/test_cli.py
git commit -m "feat: add error_descriptor for per-profile partial results"
```
(pre-commit may reformat; if it aborts, re-run `git add` on the listed files and re-commit.)

---

### Task A2: `_run_per_profile` + `_output_partial` and rewrite `positions`

**Files:**
- Modify: `src/http_clients/wealthsimple/cli.py`
- Test: `tests/http_clients/wealthsimple/test_cli.py`

- [ ] **Step 1: Write the failing tests**

In `tests/http_clients/wealthsimple/test_cli.py`, extend the top imports with:

```python
from http_clients._exceptions import AuthenticationError
```

Add this class (note: `ACCOUNT_OPEN`, `EQUITY_POSITION`, `FAKE_TOKEN_RESPONSE`, `WS_BASE`, `runner` already exist in this file):

```python
class TestPartialResults:
    @patch("http_clients.wealthsimple.client.save_token")
    def test_positions_all__returns_partial_when_one_profile_fails(self, _mock_save, tmp_credentials_dir):
        creds = {
            "wealthsimple": {
                "magda": {"refresh_token": "magda-refresh", "identity_id": "magda-id"},
                "eudes": {"refresh_token": "eudes-refresh", "identity_id": "eudes-id"},
            }
        }
        (tmp_credentials_dir / "credentials.json").write_text(json.dumps(creds))

        async def fake_refresh(refresh_token):
            if refresh_token == "magda-refresh":
                return FAKE_TOKEN_RESPONSE
            raise AuthenticationError("refresh failed", service="wealthsimple")

        accounts_payload = {"results": [ACCOUNT_OPEN], "offset": 0, "total_count": 1}
        positions_payload = {"results": [EQUITY_POSITION], "offset": 0, "total_count": 1}

        with patch("http_clients.wealthsimple.client._auth.refresh_token_grant", side_effect=fake_refresh):
            with respx.mock(using="httpx") as mock:
                mock.get(f"{WS_BASE}/v1/accounts").mock(return_value=Response(200, json=accounts_payload))
                mock.get(f"{WS_BASE}/v1/positions").mock(return_value=Response(200, json=positions_payload))
                result = runner.invoke(app, ["positions", "--profile", "all"])

        assert result.exit_code == 0
        data = json.loads(result.stdout)
        assert "results" in data and "errors" in data
        assert "magda" in data["results"]
        assert "magda" not in data["errors"]
        assert data["errors"]["eudes"]["code"] == "auth_required"
        assert data["errors"]["eudes"]["flow"] == "otp"
        assert data["errors"]["eudes"]["profile"] == "eudes"

    @patch("http_clients.wealthsimple.client.save_token")
    def test_positions_single_profile__still_signals_via_stderr(self, _mock_save, tmp_credentials_dir):
        creds = {"wealthsimple": {"eudes": {"refresh_token": "eudes-refresh", "identity_id": "eudes-id"}}}
        (tmp_credentials_dir / "credentials.json").write_text(json.dumps(creds))

        async def fake_refresh(refresh_token):
            raise AuthenticationError("refresh failed", service="wealthsimple")

        with patch("http_clients.wealthsimple.client._auth.refresh_token_grant", side_effect=fake_refresh):
            result = runner.invoke(app, ["positions", "--profile", "eudes"])

        assert result.exit_code == 1
        assert "AuthenticationError" in result.output
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest "tests/http_clients/wealthsimple/test_cli.py::TestPartialResults" -q`
Expected: FAIL — `test_positions_all__...` fails because today the first failing profile aborts the whole command (no `results`/`errors` shape). (`test_positions_single_profile__...` may already pass — that's the backward-compat guard.)

- [ ] **Step 3: Implement the helpers and rewrite `positions`**

In `src/http_clients/wealthsimple/cli.py`:

(a) Extend the `_cli` import to add `error_descriptor`, and import `HttpClientError`:

```python
from .._cli import _output, async_command, error_descriptor, handle_errors, otp_or_fail, require_or_fail, resolve_profiles
from .._exceptions import HttpClientError
```

(b) Add these two helpers just below `_make_clients` (the existing `_make_clients` is now only used by the helper; keep it):

```python
async def _run_per_profile(profile: str | None, fetch: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run ``fetch(client)`` for each resolved profile.

    With a single profile, a recoverable error is re-raised so the existing
    stderr signal (handled by the nanoclaw host) fires unchanged. With multiple
    profiles (``--profile all``), one profile's failure never aborts the others:
    successes land in ``results`` and recoverable errors in ``errors`` (keyed by
    profile), so the agent can deliver what worked and re-auth only what didn't.
    """
    profiles = resolve_profiles(SERVICE_NAME, profile)
    multi = len(profiles) > 1
    results: dict[str, Any] = {}
    errors: dict[str, Any] = {}
    for p in profiles:
        name = p or "default"
        try:
            client = WealthsimpleClient.from_stored(profile=p)
            try:
                results[name] = await fetch(client)
            finally:
                await client.close()
        except HttpClientError as e:
            if not multi:
                raise
            errors[name] = error_descriptor(name, e)
    return results, errors


def _output_partial(results: dict[str, Any], errors: dict[str, Any]) -> None:
    if errors:
        _output({"results": results, "errors": errors})
    else:
        _output(results)
```

(c) Replace the body of the `positions` command (keep its decorators and signature) with:

```python
async def positions(
    profile: ProfileOpt = None,
    account: Annotated[str | None, typer.Option(help="Specific account ID")] = None,
) -> None:
    """List positions across all accounts."""

    async def fetch(client: WealthsimpleClient) -> list[dict[str, Any]]:
        if account:
            pos = (await client.get_positions(account)).results
        else:
            pos = await client.get_all_positions()
        return [p.model_dump() for p in pos]

    results, errors = await _run_per_profile(profile, fetch)
    _output_partial(results, errors)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest "tests/http_clients/wealthsimple/test_cli.py" -q`
Expected: PASS (the new `TestPartialResults` and all existing `TestPositions` tests).

- [ ] **Step 5: Commit**

```bash
git add src/http_clients/wealthsimple/cli.py tests/http_clients/wealthsimple/test_cli.py
git commit -m "feat: partial results for multi-profile wealthsimple positions"
```

---

### Task A3: rewrite `accounts` for partial results

**Files:**
- Modify: `src/http_clients/wealthsimple/cli.py`
- Test: `tests/http_clients/wealthsimple/test_cli.py`

- [ ] **Step 1: Write the failing test**

Add to `TestPartialResults` in `tests/http_clients/wealthsimple/test_cli.py`:

```python
    @patch("http_clients.wealthsimple.client.save_token")
    def test_accounts_all__returns_partial_when_one_profile_fails(self, _mock_save, tmp_credentials_dir):
        creds = {
            "wealthsimple": {
                "magda": {"refresh_token": "magda-refresh", "identity_id": "magda-id"},
                "eudes": {"refresh_token": "eudes-refresh", "identity_id": "eudes-id"},
            }
        }
        (tmp_credentials_dir / "credentials.json").write_text(json.dumps(creds))

        async def fake_refresh(refresh_token):
            if refresh_token == "magda-refresh":
                return FAKE_TOKEN_RESPONSE
            raise AuthenticationError("refresh failed", service="wealthsimple")

        accounts_payload = {"results": [ACCOUNT_OPEN], "offset": 0, "total_count": 1}

        with patch("http_clients.wealthsimple.client._auth.refresh_token_grant", side_effect=fake_refresh):
            with respx.mock(using="httpx") as mock:
                mock.get(f"{WS_BASE}/v1/accounts").mock(return_value=Response(200, json=accounts_payload))
                result = runner.invoke(app, ["accounts", "--profile", "all"])

        assert result.exit_code == 0
        data = json.loads(result.stdout)
        assert data["results"]["magda"][0]["id"] == "acc-1"
        assert data["errors"]["eudes"]["code"] == "auth_required"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest "tests/http_clients/wealthsimple/test_cli.py::TestPartialResults::test_accounts_all__returns_partial_when_one_profile_fails" -q`
Expected: FAIL — `accounts` still aborts on the first failing profile.

- [ ] **Step 3: Rewrite the `accounts` command**

In `src/http_clients/wealthsimple/cli.py`, replace the body of `accounts` (keep decorators/signature) with:

```python
async def accounts(profile: ProfileOpt = None) -> None:
    """List all accounts with balances."""

    async def fetch(client: WealthsimpleClient) -> list[dict[str, Any]]:
        resp = await client.get_accounts()
        return [a.model_dump() for a in resp.results if a.status == "open"]

    results, errors = await _run_per_profile(profile, fetch)
    _output_partial(results, errors)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest "tests/http_clients/wealthsimple/test_cli.py" -q`
Expected: PASS (all account tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/http_clients/wealthsimple/cli.py tests/http_clients/wealthsimple/test_cli.py
git commit -m "feat: partial results for multi-profile wealthsimple accounts"
```

---

### Task A4: parallelize per-account position fetches

**Files:**
- Modify: `src/http_clients/wealthsimple/client.py`
- Test: `tests/http_clients/wealthsimple/test_client.py` (existing coverage)

This is a behavior-preserving refactor (latency only): `get_all_positions` already returns all positions from open accounts; the existing `test_get_all_positions__returns_all_types_from_open_accounts` (membership-based assertions) is the guard. The token is warmed by the `get_accounts()` call before the gather, so concurrent `get_positions` calls hit a valid cached token (no double refresh).

- [ ] **Step 1: Confirm the guard test passes today**

Run: `python3 -m pytest "tests/http_clients/wealthsimple/test_client.py::TestWealthsimpleClient::test_get_all_positions__returns_all_types_from_open_accounts" -q`
Expected: PASS (baseline before refactor).

- [ ] **Step 2: Parallelize**

In `src/http_clients/wealthsimple/client.py`, add `import asyncio` at the top (with the other stdlib imports), then replace `get_all_positions`:

```python
    async def get_all_positions(self) -> list[Position]:
        accounts = await self.get_accounts()  # warms the access token before the gather
        open_accounts = [a for a in accounts.results if a.status == "open"]
        position_responses = await asyncio.gather(*(self.get_positions(a.id) for a in open_accounts))
        return [pos for resp in position_responses for pos in resp.results]
```

- [ ] **Step 3: Run the client tests to verify still green**

Run: `python3 -m pytest "tests/http_clients/wealthsimple/test_client.py" -q`
Expected: PASS (all, including the multi-account test — order-independent assertions hold).

- [ ] **Step 4: Commit**

```bash
git add src/http_clients/wealthsimple/client.py
git commit -m "perf: fetch per-account positions concurrently in get_all_positions"
```

---

### Task A5: full suite, lint, version bump

**Files:**
- Modify: `pyproject.toml`

- [ ] **Step 1: Full gate**

Run: `python3 -m pytest tests/ -q && python3 -m ruff check src/ tests/ && python3 -m mypy src/http_clients`
Expected: all pass, ruff "All checks passed!", mypy "Success".

- [ ] **Step 2: Bump version**

In `pyproject.toml`, change `version = "0.4.0"` to `version = "0.5.0"`.

- [ ] **Step 3: Commit**

```bash
git add pyproject.toml
git commit -m "chore: bump http-clients to 0.5.0 (partial results + concurrent reads)"
```

Note: editable install — source is already live; no reinstall needed. (The `.dist-info` version string remains stale at 0.2.0 due to the 3.12/3.13 `requires-python` mismatch; do not uninstall/reinstall, it risks leaving the host with no CLI.)

---

# Part B — nanoclaw (`~/Projects/nanoclaw`)

### Task B1: per-call logging in the host service

**Files:**
- Modify: `src/http-clients-service.ts`
- Test: `src/http-clients-service.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/http-clients-service.test.ts`, change the top import to also pull in `vi`:

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import { log } from './log.js';
```

Add this test inside the `describe('http-clients-service', ...)` block:

```typescript
  it('logs every CLI call with service, command, classified code and duration', async () => {
    const spy = vi.spyOn(log, 'info').mockImplementation(() => {});
    server = await startHttpClientsService(0);
    const port = (server.address() as { port: number }).port;

    await makeRequest(port, { service: 'costco', command: 'receipts', args: { profile: 'eudes' } });

    const call = spy.mock.calls.find((c) => c[0] === 'http-clients call');
    expect(call).toBeDefined();
    const meta = call![1] as Record<string, unknown>;
    expect(meta.service).toBe('costco');
    expect(meta.command).toBe('receipts');
    expect(meta.profile).toBe('eudes');
    expect(typeof meta.code).toBe('string');
    expect(typeof meta.durationMs).toBe('number');
    spy.mockRestore();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/http-clients-service.test.ts -t "logs every CLI call"`
Expected: FAIL — no `'http-clients call'` log is emitted (`call` is undefined).

- [ ] **Step 3: Add logging in the request handler**

In `src/http-clients-service.ts`, replace the `runCli(cliArgs)` invocation block inside the `req.on('end', ...)` handler with a timed, logged version:

```typescript
        const startedAt = Date.now();
        runCli(cliArgs)
          .then((result) => {
            const code = (result as { code?: string; status?: string }).code ?? 'ok';
            log.info('http-clients call', {
              service: service ?? null,
              command: command ?? null,
              profile: args?.profile ?? null,
              code,
              durationMs: Date.now() - startedAt,
            });
            respond(res, 200, result);
          })
          .catch((err) => {
            log.error('http-clients-service CLI error', {
              err,
              service,
              command,
              durationMs: Date.now() - startedAt,
            });
            respond(res, 500, { status: 'error', message: err instanceof Error ? err.message : String(err) });
          });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/http-clients-service.test.ts`
Expected: PASS (all 12 tests, including the new logging test).

- [ ] **Step 5: Build + commit**

```bash
pnpm run build
git add src/http-clients-service.ts src/http-clients-service.test.ts
git commit -m "feat: log every http-clients host-service call (service, command, code, duration)"
```

---

### Task B2: teach the agent the partial-result shape

**Files:**
- Modify: `container/skills/http-clients/SKILL.md`
- Modify: `container/agent-runner/src/mcp-tools/http-clients.instructions.md`

No automated test (prompt/markdown, mounted read-only into the container — live on the agent's next turn, no rebuild).

- [ ] **Step 1: Update SKILL.md**

In `container/skills/http-clients/SKILL.md`, under `## Multi-profile`, append this paragraph:

```markdown
On a multi-profile read (`--profile all`), if some profiles fail the result is **partial**: `{ "results": { "<profile>": <data> }, "errors": { "<profile>": { "code": "...", "flow"?: "...", "hint"?: "...", "profile": "<profile>" } } }`. Deliver the data in `results` right away, then recover each entry in `errors` per its `code` (see Re-authentication / Error handling) — re-authenticate **only** the failed profiles, one at a time, addressing the right person by profile name. Never discard good data because another profile failed.
```

- [ ] **Step 2: Update instructions.md**

In `container/agent-runner/src/mcp-tools/http-clients.instructions.md`, under `### Response format`, add this bullet after the `Transient` line:

```markdown
- Partial (multi-profile reads): `{status: "ok", data: {results: {<profile>: <data>}, errors: {<profile>: {code, flow?, hint?, profile}}}}` — deliver `results` immediately, then recover each `errors` entry by its `code` for that profile only (one at a time). Don't drop good data because a sibling profile failed.
```

- [ ] **Step 3: Verify the markdown is well-formed and committed**

Run: `git diff --stat container/skills/http-clients/SKILL.md container/agent-runner/src/mcp-tools/http-clients.instructions.md`
Expected: both files show as modified.

```bash
git add container/skills/http-clients/SKILL.md container/agent-runner/src/mcp-tools/http-clients.instructions.md
git commit -m "docs: teach the agent to consume partial multi-profile results"
```

- [ ] **Step 4: Restart the host so the logging build is live**

Run: `launchctl kickstart -k "gui/$(id -u)/com.nanoclaw-v2-9a8662aa"`
Expected: exit 0; `logs/nanoclaw.log` shows `NanoClaw running` and `http-clients service started`. (Prompt changes are mounted, so they need no rebuild; the host restart is for the Task B1 logging build.)

---

## Self-review

- **Spec coverage:** #1 partial → A1 (descriptor) + A2 (positions) + A3 (accounts) + B2 (prompt consumption). #2 profile attribution → `profile` field in `error_descriptor` (A1), surfaced per-profile in A2/A3. #3 parallelize → A4. #4 host logging → B1. ✔
- **Placeholder scan:** every code/test step contains complete code and exact commands. ✔
- **Type/name consistency:** `error_descriptor(profile, exc)`, `_run_per_profile(profile, fetch) -> (results, errors)`, `_output_partial(results, errors)`, log message `'http-clients call'` with `{service, command, profile, code, durationMs}` — used consistently across tasks. ✔
- **Backward compat:** single-profile reads re-raise (A2 guard test); host `classifyCliResult` unchanged (partial = exit 0 + JSON). ✔

## Out of scope (follow-ups)
- Costco `receipts` partial results (reuse `error_descriptor` + an analogous per-profile runner).
- Login-flow double-SMS dedupe (LLM over-eagerness guard).
- Proactive background token refresh (nanoclaw scheduling).
- `credentials.json` cross-session write race (latent).
