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
        aggregate: {
          type: 'object',
          description:
            'Ask the host to total the rows instead of returning them. The host sums exactly and returns { total, currency, rows: [{ key, <sums>, pct }] }. Use it for any "how much in total" or "what share" question — never add the amounts yourself.',
          properties: {
            group_by: { type: 'string', description: 'Row field to group on, e.g. "sym".' },
            sum: {
              type: 'array',
              items: { type: 'string' },
              description: 'Row fields to total. Defaults to ["value"]. Percentages use the first one.',
            },
            accounts: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keep only rows touching these account ids. Omit to keep every account.',
            },
            profiles: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keep only these profiles. Omit to keep every profile in the response.',
            },
          },
          required: ['group_by'],
        },
      },
      required: [],
    },
  },
  handler: async (params) => {
    if (!HTTP_CLIENTS_URL) {
      return err('HTTP_CLIENTS_URL not configured — host service not available');
    }

    const { service, command, args, raw, aggregate } = params as {
      service?: string;
      command?: string;
      args?: Record<string, CliArgValue>;
      raw?: boolean;
      aggregate?: object;
    };

    try {
      const response = await fetch(`${HTTP_CLIENTS_URL}/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service, command, args: args ?? {}, raw, aggregate }),
      });

      const data = await response.json();
      return ok(JSON.stringify(data, null, 2));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([httpClientsTool]);
