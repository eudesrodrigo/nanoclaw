import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const HTTP_CLIENTS_URL = process.env.HTTP_CLIENTS_URL;

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

type CliArgValue = string | number | boolean | string[];

const httpClientsTool: McpToolDefinition = {
  tool: {
    name: 'http_clients',
    description:
      'Call the http-clients CLI on the host. Credentials are managed securely on the host — this tool never sees them. ' +
      'Omit all args to list available services. Pass service only to list its commands. ' +
      'Pass service + command to execute. Returns JSON; on auth failure returns {status:"error", code:"auth_required", flow:"token"|"otp"}.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Service name (e.g. costco, wealthsimple-v2). Omit to list available services.',
        },
        command: {
          type: 'string',
          description: 'CLI command (e.g. receipts, fetch-identity-positions, login). Omit to list the service\'s commands.',
        },
        args: {
          type: 'object',
          description:
            'Key-value pairs passed as CLI flags. String or number becomes "--key value"; true becomes "--key"; false becomes "--no-key"; an array repeats the flag once per item ("--ids A --ids B"). Pass {help: true} for a command\'s own help.',
          additionalProperties: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
      },
      required: [],
    },
  },
  handler: async (params) => {
    if (!HTTP_CLIENTS_URL) {
      return err('HTTP_CLIENTS_URL not configured — host service not available');
    }

    const { service, command, args } = params as {
      service?: string;
      command?: string;
      args?: Record<string, CliArgValue>;
    };

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
