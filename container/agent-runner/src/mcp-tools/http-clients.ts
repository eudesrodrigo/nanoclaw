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
      'Call the http-clients CLI on the host. Omit arguments to discover what is available. See the http-clients skill for recipes.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Service name. Omit to list available services.',
        },
        command: {
          type: 'string',
          description: "CLI command. Omit to list the service's commands.",
        },
        args: {
          type: 'object',
          description:
            'CLI arguments. String or number becomes "--key value"; true becomes "--key"; false becomes "--no-key"; an array repeats the flag ("--ids A --ids B"). The reserved key "_" passes positional arguments. Pass {help: true} for a command\'s own help.',
          additionalProperties: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
        raw: {
          type: 'boolean',
          description:
            'Skip host-side projection and return the full payload. Use when the response carried a "projected" key and you need a field it dropped.',
        },
      },
      required: [],
    },
  },
  handler: async (params) => {
    if (!HTTP_CLIENTS_URL) {
      return err('HTTP_CLIENTS_URL not configured — host service not available');
    }

    const { service, command, args, raw } = params as {
      service?: string;
      command?: string;
      args?: Record<string, CliArgValue>;
      raw?: boolean;
    };

    try {
      const response = await fetch(`${HTTP_CLIENTS_URL}/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service, command, args: args ?? {}, raw }),
      });

      const data = await response.json();
      return ok(JSON.stringify(data, null, 2));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([httpClientsTool]);
