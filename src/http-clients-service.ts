import { createServer, Server } from 'http';
import { spawn } from 'child_process';

import { HTTP_CLIENTS_BIN } from './config.js';
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
        let body: { service?: string; command?: string; args?: Record<string, CliArgValue> };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          respond(res, 400, { status: 'error', message: 'Invalid JSON' });
          return;
        }

        const { service, command, args } = body;

        const cliArgs = buildCliArgs(service, command, args);

        const startedAt = Date.now();
        runCli(cliArgs, !command)
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

export function buildCliArgs(service?: string, command?: string, args?: Record<string, CliArgValue>): string[] {
  const cliArgs: string[] = [];
  if (service) cliArgs.push(service);
  if (command) cliArgs.push(command);
  if (!args) return cliArgs;

  for (const [key, value] of Object.entries(args)) {
    if (Array.isArray(value)) {
      // Typer collects a `list[str]` option by repeating the flag —
      // `--ids A --ids B`. A comma-joined single value is a different and
      // wrong thing to the API on the far side.
      for (const item of value) cliArgs.push(`--${key}`, String(item));
    } else if (typeof value === 'boolean') {
      // Typer renders a `bool` option as a `--flag / --no-flag` pair that
      // accepts no value, so the value has to live in the flag name.
      cliArgs.push(value ? `--${key}` : `--no-${key}`);
    } else {
      cliArgs.push(`--${key}`, String(value));
    }
  }
  return cliArgs;
}

function runCli(args: string[], isListing = false): Promise<object> {
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
      resolve(classifyCliResult(code, out, errOut, isListing));
    });
  });
}

export function classifyCliResult(
  code: number | null,
  stdout: string,
  stderr: string,
  isListing = false,
): object {
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
    return { status: 'error', code: 'auth_required', flow: 'otp', message: stderr.split('\n')[0] };
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
