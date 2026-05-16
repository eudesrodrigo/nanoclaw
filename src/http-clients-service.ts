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
