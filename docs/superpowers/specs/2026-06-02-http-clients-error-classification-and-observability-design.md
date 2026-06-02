# http-clients — Error Classification + Observability Adjustments (post-GraphQL cleanup)

**Date:** 2026-06-02
**Repos:** `~/Projects/http-clients` (package, editable install) and `~/Projects/nanoclaw` (host).

## Problem

The `http-clients` package was cleaned up and migrated Wealthsimple from REST to GraphQL (v0.6.0). The migration made the **data path** the primary path, and it surfaced a latent gap in how failures are classified across the package↔host boundary. The boundary is a textual contract: the host's `classifyCliResult` (`src/http-clients-service.ts`) substring-matches the exception **class name** that the CLI leaks on stderr.

### Findings

| # | Sev | Finding |
|---|-----|---------|
| 1 | High | `TransientError` is raised **only** in the auth/refresh path (`wealthsimple/_auth.py`). On the data path, an exhausted-retry transient failure surfaces as `TimeoutError`/`ConnectionError`/`ServerError`/`RateLimitError` — none contain the string `TransientError`, so the host classifies them as `cli_error`. The agent treats a recoverable network blip as a permanent error. The package's own `error_descriptor` (multi-profile JSON path) has the **same** gap. |
| 2 | Med | `GraphQLResponseError` (new in 0.6.0) is unclassified; it falls through to `cli_error` by accident rather than by intent. |
| 3 | Med | Partial multi-profile results (`{results, errors}`) are logged by the host service with `code:"ok"` even when some profiles failed — the observability goal is blind in exactly the interesting case. |
| 4 | Low | The `http_clients` logger has no handler, so tenacity retry warnings reach stderr via Python's lastResort handler. The host's `stderr.split('\n')[0]` can then pick a retry-warning line as the user-facing `message`. |

Out of scope / accepted: dist-info version string stale at 0.2.0 (intentional — editable install, documented); 2 pre-existing mypy untyped-call warnings in `costco/_auth.py`.

## Key decision

**"Transient" is a status-set property the package knows precisely (it has the HTTP status and the retry config) and currently throws away. The classification belongs in the package, as a single source of truth. The host's `classifyCliResult` does NOT change** — it already maps the semantic markers `TransientError`/`TokenNotFoundError`/`AuthenticationError`/`OTPRequired:`. The defect is that the package leaks the leaf class name instead of the semantic marker. Adding class names to the host classifier (the naive fix) was rejected: it spreads the vocabulary to a third site, keeps the brittle name-matching, and is not status-accurate (a 501 `ServerError` is not transient; a 429 `RateLimitError` is).

This keeps the host's tested contract and the OTP/exit-code wire format untouched (lowest risk), and removes the duplication that caused the bug.

## Design

### Package (`~/Projects/http-clients`) — #1, #2, #4

**A. Single classifier (`_cli.py`).** Add `classify(exc: HttpClientError) -> dict` — the one place that maps an exception to the `{code, flow?}` vocabulary, status-aware:

- `isinstance(exc, TransientError | TimeoutError | ConnectionError)` → `{"code": "transient"}`
- `isinstance(exc, HttpResponseError) and exc.status.value in RETRYABLE_STATUSES` → `{"code": "transient"}` (covers 429/500/502/503/504; `RateLimitError` and retryable `ServerError`)
- `isinstance(exc, TokenNotFoundError)` → `{"code": "auth_required", "flow": "token"}`
- `isinstance(exc, AuthenticationError)` → `{"code": "auth_required", "flow": "otp"}`
- else (incl. `GraphQLResponseError`, `ClientError` 4xx≠401, non-retryable `ServerError` like 501) → `{"code": "cli_error"}`

Order matters: the `TransientError`/transport check runs first so a bare `TransientError("timeout")` (no status) still maps to transient (preserves the existing `error_descriptor` test). `TimeoutError`/`ConnectionError` are the package's own `_exceptions` classes (they shadow builtins) — import from `._exceptions`.

**B. `RETRYABLE_STATUSES` constant (`_base.py`).** Extract the retry status frozenset to a module-level `RETRYABLE_STATUSES`; `ClientConfig.retry_statuses` defaults to it. `classify` imports it — single source for "which statuses are transient."

**C. `error_descriptor` becomes a wrapper.** `return {"profile": profile, "message": str(exc), **classify(exc)}`. Existing `TestErrorDescriptor` cases still pass (transient → `{profile, code:"transient", message}`; etc.).

**D. `handle_errors` emits the semantic marker, not the leaf name.** Derive a marker from `classify`:
- `transient` → `TransientError`
- `auth_required/token` → `TokenNotFoundError`
- `auth_required/otp` → `AuthenticationError`
- `cli_error` → keep `type(exc).__name__` (preserves diagnostic detail, e.g. `GraphQLResponseError:`, `ClientError: 403 ...`)

Emit `f"{marker}: {exc}"` on stderr, exit 1 (unchanged). The existing `TestHandleErrors` parametrization is preserved: auth markers equal their leaf names, and `GraphQLResponseError`/`HttpClientError` are `cli_error` → leaf name. The only behavioral change: transient-family exceptions now print `TransientError:` instead of their leaf name — exactly the fix.

**E. Silence retry warnings on stderr (#4).** In `main()`, attach a `logging.NullHandler()` to the `http_clients` logger so tenacity's `before_sleep` warnings no longer reach stderr via lastResort. Retry diagnostics are not lost from the host's perspective — the host already logs the full stderr on failure; this just stops warning lines from being mistaken for the error `message`.

### Host (`~/Projects/nanoclaw`) — #3

**F. `logCode(result)` pure helper (`src/http-clients-service.ts`).** Extract a small pure function so it is unit-testable without spawning the CLI:

```
logCode(result) -> { code: string; failedProfiles?: string[] }
```
- If `result.data?.errors` is a non-empty object → `{ code: "partial", failedProfiles: Object.keys(result.data.errors) }`
- else → `{ code: (result.code ?? "ok") }`

The request handler uses it: `const { code, failedProfiles } = logCode(result);` and includes `failedProfiles` in the `log.info('http-clients call', {...})` payload when present. No change to the HTTP response or to `classifyCliResult`.

## Testing

TDD on both sides.

- **Package (pytest):** new `classify` cases (TransientError, TimeoutError, ConnectionError, ServerError 503→transient, ServerError 501→cli_error, RateLimitError 429→transient, GraphQLResponseError→cli_error, TokenNotFound, Authentication, generic); `error_descriptor` re-verified; new `handle_errors` transient case asserting `TransientError:` prefix; existing `TestHandleErrors` preserved. Then `pytest tests/ -q && ruff check src/ && mypy src/http_clients` (mypy: no *new* errors beyond the 2 pre-existing costco ones).
- **Host (vitest):** `logCode` unit tests (ok / partial-with-failedProfiles / error-with-code). `classifyCliResult` tests unchanged and must stay green. The existing real-CLI logging test stays.

## Verification (end-to-end)

After both sides pass: rebuild nothing in the package (editable). Rebuild/restart the host so the logging change is live. A `--profile all` read with one profile failing should log `code:"partial" failedProfiles:[...]`; a forced transient (e.g. unreachable host) on a single-profile data fetch should classify as `transient`, not `cli_error`.

## Risk

Low. Host error-classification contract and OTP/exit-code wire format untouched. Package change is confined to classification/logging; no raise sites change, no consumer catches the affected subclasses, no existing stderr-assertion test breaks.
