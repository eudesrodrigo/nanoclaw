import { createServer, Server } from 'http';
import { spawn } from 'child_process';

import { HTTP_CLIENTS_BIN } from './config.js';
import { log } from './log.js';
import { applyProjection } from './http-clients-projections.js';

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
        let body: {
          service?: string;
          command?: string;
          args?: Record<string, CliArgValue>;
          raw?: boolean;
        };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          respond(res, 400, { status: 'error', message: 'Invalid JSON' });
          return;
        }

        const { service, command, args, raw } = body;

        const cliArgs = buildCliArgs(service, command, args);

        const startedAt = Date.now();
        runCli(cliArgs, !command, service)
          .then((result) => {
            const projected = raw === true ? result : applyProjection(service, command, result);
            const code = (projected as { code?: string; status?: string }).code ?? 'ok';
            const detail = {
              service: service ?? null,
              command: command ?? null,
              profile: args?.profile ?? null,
              code,
              projected: (projected as { projected?: string }).projected ?? null,
              durationMs: Date.now() - startedAt,
            };
            if (code === 'ok') {
              log.info('http-clients call', detail);
            } else {
              // The code alone says a call failed, never why. Carry the CLI's
              // own text, at a level that reaches the error log, so the cause
              // survives past the container that saw it.
              const message = (projected as { message?: string }).message;
              log.warn('http-clients call failed', { ...detail, message: (message ?? '').slice(0, 500) });
            }
            respond(res, 200, projected);
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

export type CliArgValue = string | number | boolean | string[];

export const CLI_TIMEOUT_MS = 60_000;

export function cliEnv(): NodeJS.ProcessEnv {
  // Rich wraps to 80 columns when COLUMNS is unset, shredding the help
  // output the agent uses to discover commands. Widen it.
  return { ...process.env, COLUMNS: '200' };
}

/**
 * Read a list argument, in either shape the agent sends it.
 *
 * Observed live on 2026-08-09: the agent sent `ids` as the string
 * `'["ca-cash-a","tfsa-b"]'` instead of an array. The whole string became one
 * `--ids` value and the API answered `GraphQLResponseError: ['NOT_FOUND']` — a
 * message that names nothing about the argument shape. The agent spent a help
 * call and a retry to find its own typo. Accepting both shapes costs nothing
 * and removes the round trip.
 *
 * Only an array of primitives counts. A value that merely starts with `[`
 * stays a value, so a search term like `[draft] tfsa` is never split.
 */
function asStringList(value: CliArgValue): string[] | null {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value.trim().startsWith('[')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const primitive = (item: unknown): boolean =>
    typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean';
  if (!parsed.every(primitive)) return null;

  return parsed.map(String);
}

export function buildCliArgs(service?: string, command?: string, args?: Record<string, CliArgValue>): string[] {
  const cliArgs: string[] = [];
  if (service) cliArgs.push(service);
  if (command) cliArgs.push(command);
  if (!args) return cliArgs;

  // `_` is reserved for positional arguments. Click stops parsing options at
  // `--`, so every flag has to be emitted before the separator no matter where
  // `_` sits in the object. A repeated separator is not a second separator —
  // Click reads it as a value — so there is exactly one, or none.
  const positionals: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    const list = asStringList(value);

    if (key === '_') {
      if (list) positionals.push(...list);
      else positionals.push(String(value));
    } else if (list) {
      // Typer collects a `list[str]` option by repeating the flag —
      // `--ids A --ids B`. A comma-joined single value is a different and
      // wrong thing to the API on the far side.
      for (const item of list) cliArgs.push(`--${key}`, item);
    } else if (typeof value === 'boolean') {
      // Typer renders a `bool` option as a `--flag / --no-flag` pair that
      // accepts no value, so the value has to live in the flag name.
      cliArgs.push(value ? `--${key}` : `--no-${key}`);
    } else {
      cliArgs.push(`--${key}`, String(value));
    }
  }

  if (positionals.length > 0) cliArgs.push('--', ...positionals);
  return cliArgs;
}

function runCli(args: string[], isListing = false, service?: string): Promise<object> {
  return new Promise((resolve, reject) => {
    const proc = spawn(HTTP_CLIENTS_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS,
      env: cliEnv(),
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on('data', (d) => stdout.push(d));
    proc.stderr.on('data', (d) => stderr.push(d));

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      const out = Buffer.concat(stdout).toString().trim();
      const errOut = Buffer.concat(stderr).toString().trim();
      resolve(classifyCliResult(code, out, errOut, { isListing, service }));
    });
  });
}

// Services whose re-auth is a pasted refresh token, not a one-time code. The
// CLI reports both as `AuthenticationError`, so the stderr text alone cannot
// tell them apart. Default is `otp` because Wealthsimple uses OTP and it is
// the only other service. Add a service here when it authenticates by token.
const TOKEN_FLOW_SERVICES = new Set(['costco']);

export function classifyCliResult(
  code: number | null,
  stdout: string,
  stderr: string,
  opts: { isListing?: boolean; service?: string } = {},
): object {
  const { isListing = false, service } = opts;
  // A caller that names no command is asking for a listing. Typer prints the
  // list to stdout and exits 2, so classifying by exit code alone reported the
  // requested result as a failure — and an agent that skips an `error` envelope
  // skips the command names with it. Measured in production: the agent called
  // discovery, ignored the 26 KB it got back, and guessed 35 command names.
  if (isListing && stdout) {
    return { status: 'ok', data: stdout };
  }

  if (code === 0 && stdout) {
    try {
      return { status: 'ok', data: JSON.parse(stdout) };
    } catch {
      return { status: 'ok', data: stdout };
    }
  }

  // OTP-required is its own auth flow: the host has the credentials but needs a
  // fresh one-time code from the user. The CLI emits `OTPRequired:<hint>` on
  // stderr when run non-interactively.
  const otpMatch = stderr.match(/OTPRequired:(.*)/);
  if (otpMatch) {
    return {
      status: 'error',
      code: 'auth_required',
      flow: 'otp',
      hint: otpMatch[1].trim(),
      message: stderr.split('\n')[0],
    };
  }

  // Transient = retryable (network, timeout, 5xx, rate limit). NOT an auth
  // problem — the credentials are fine, so the agent must retry the original
  // command, never start a re-auth/OTP flow.
  if (stderr.includes('TransientError')) {
    return { status: 'error', code: 'transient', message: stderr.split('\n')[0] };
  }

  if (stderr.includes('TokenNotFoundError')) {
    return { status: 'error', code: 'auth_required', flow: 'token', message: stderr.split('\n')[0] };
  }
  if (stderr.includes('AuthenticationError')) {
    return {
      status: 'error',
      code: 'auth_required',
      flow: service && TOKEN_FLOW_SERVICES.has(service) ? 'token' : 'otp',
      message: stderr.split('\n')[0],
    };
  }

  return {
    status: 'error',
    code: 'cli_error',
    exitCode: code,
    message: mergeStreams(stdout, stderr) || `CLI exited with code ${code}`,
  };
}

function mergeStreams(stdout: string, stderr: string): string {
  // This CLI puts its command list on stdout and its errors on stderr, never
  // both at once, so `stderr || stdout` already surfaced the discovery
  // list. This function is defensive against a future CLI that does write
  // to both streams on the same failure — stdout leads because it is the
  // useful half.
  if (stdout && stderr) return `${stdout}\n\n${stderr}`;
  return stderr || stdout;
}
