import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const HTTP_CLIENTS_URL = process.env.HTTP_CLIENTS_URL;

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const httpClientsTool: McpToolDefinition = {
  tool: {
    name: 'http_clients',
    description:
      'Call the http-clients service on the host for API access (Costco, Wealthsimple, etc). ' +
      'Credentials are managed securely on the host — this tool never sees them. ' +
      'Returns JSON from the CLI. On auth failure, returns {status:"error", code:"auth_required", flow:"token"|"otp"}.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name (e.g. costco, wealthsimple)' },
        command: { type: 'string', description: 'CLI command (e.g. receipts, positions, login, membership)' },
        args: {
          type: 'object',
          description: 'Key-value pairs passed as CLI flags (e.g. {profile: "eudes", type: "warehouse"})',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['service', 'command'],
    },
  },
  handler: async (params) => {
    if (!HTTP_CLIENTS_URL) {
      return err('HTTP_CLIENTS_URL not configured — host service not available');
    }

    const { service, command, args } = params as { service: string; command: string; args?: Record<string, string> };

    try {
      const response = await fetch(`${HTTP_CLIENTS_URL}/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service, command, args: args ?? {} }),
      });

      const data = await response.json();
      return ok(JSON.stringify(data, null, 2));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([httpClientsTool]);
