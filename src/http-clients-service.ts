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
        let body: { service?: string; command?: string; args?: Record<string, string> };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          respond(res, 400, { status: 'error', message: 'Invalid JSON' });
          return;
        }

        const { service, command, args } = body;

        const cliArgs: string[] = [];
        if (service) cliArgs.push(service);
        if (command) cliArgs.push(command);
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
    const proc = spawn(HTTP_CLIENTS_BIN, args, {
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
      resolve(classifyCliResult(code, out, errOut));
    });
  });
}

export function classifyCliResult(code: number | null, stdout: string, stderr: string): object {
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
    message: stderr || stdout || `CLI exited with code ${code}`,
  };
}
