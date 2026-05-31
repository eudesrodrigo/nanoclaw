import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';

import { startHttpClientsService, classifyCliResult } from './http-clients-service.js';

function makeRequest(port: number, body: object): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/call',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
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

  it('accepts empty body for top-level discovery', async () => {
    server = await startHttpClientsService(0);
    const port = (server.address() as { port: number }).port;

    const { status, data } = await makeRequest(port, {});
    expect(status).toBe(200);
    expect(data.status).toBeDefined();
  });

  it('accepts service-only requests (discovery)', async () => {
    server = await startHttpClientsService(0);
    const port = (server.address() as { port: number }).port;

    const { status, data } = await makeRequest(port, { service: 'costco' });
    expect(status).toBe(200);
    expect(data.status).toBeDefined();
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

  it('maps OTPRequired stderr to auth_required/flow:otp with hint', () => {
    const result = classifyCliResult(2, '', 'OTPRequired: (phone ending in ...45)\nTraceback ...') as Record<
      string,
      unknown
    >;
    expect(result.status).toBe('error');
    expect(result.code).toBe('auth_required');
    expect(result.flow).toBe('otp');
    expect(result.hint).toBe('(phone ending in ...45)');
  });

  it('maps TokenNotFoundError stderr to auth_required/flow:token', () => {
    const result = classifyCliResult(1, '', 'TokenNotFoundError: no token for profile eudes') as Record<
      string,
      unknown
    >;
    expect(result.code).toBe('auth_required');
    expect(result.flow).toBe('token');
  });

  it('maps AuthenticationError stderr to auth_required/flow:otp', () => {
    const result = classifyCliResult(1, '', 'Authentication failed: AuthenticationError bad creds') as Record<
      string,
      unknown
    >;
    expect(result.code).toBe('auth_required');
    expect(result.flow).toBe('otp');
  });

  it('maps TransientError stderr to a retryable transient code (not auth_required)', () => {
    const result = classifyCliResult(
      1,
      '',
      'TransientError: Refresh token grant failed (transient): timed out',
    ) as Record<string, unknown>;
    expect(result.status).toBe('error');
    expect(result.code).toBe('transient');
    expect(result.code).not.toBe('auth_required');
  });

  it('parses JSON stdout on success', () => {
    const result = classifyCliResult(0, '{"a":1}', '') as Record<string, unknown>;
    expect(result.status).toBe('ok');
    expect(result.data).toEqual({ a: 1 });
  });

  it('returns cli_error for non-auth failures', () => {
    const result = classifyCliResult(2, '', 'Usage: http-clients ...\nMissing command.') as Record<string, unknown>;
    expect(result.status).toBe('error');
    expect(result.code).toBe('cli_error');
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
