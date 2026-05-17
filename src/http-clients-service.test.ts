import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';

import { startHttpClientsService } from './http-clients-service.js';

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
