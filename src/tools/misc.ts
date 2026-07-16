import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { atm, zephyrFetch, ZephyrApiError } from '../http.js';
import { compact, defineTool, resolveProjectKey } from '../toolkit.js';

export function registerMiscTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'list_environments',
    description:
      'List Zephyr Scale environments configured for a Jira project. Environment names are case-sensitive and are referenced by name in test run items and test results.',
    inputSchema: {
      projectKey: z.string().optional().describe('Jira project key; defaults to ZEPHYR_DEFAULT_PROJECT_KEY'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) =>
      zephyrFetch(cfg, {
        method: 'GET',
        path: atm('/environments'),
        query: { projectKey: resolveProjectKey(cfg, args.projectKey) },
      }),
  });

  defineTool(server, cfg, {
    name: 'create_environment',
    description: 'Create a Zephyr Scale environment in a Jira project. The name must be unique within the project.',
    inputSchema: {
      projectKey: z.string().optional().describe('Jira project key; defaults to ZEPHYR_DEFAULT_PROJECT_KEY'),
      name: z.string().describe('Environment name (unique within the project)'),
      description: z.string().optional(),
    },
    annotations: {},
    handler: async (args, { cfg }) =>
      zephyrFetch(cfg, {
        method: 'POST',
        path: atm('/environments'),
        body: compact({
          projectKey: resolveProjectKey(cfg, args.projectKey),
          name: args.name,
          description: args.description,
        }),
      }),
  });

  defineTool(server, cfg, {
    name: 'find_jira_user',
    description:
      "Search Jira users by username, display name or e-mail. Use it to resolve the Jira *user key* (e.g. 'JIRAUSER10000') required by the owner / executedBy / assignedTo fields of other tools.",
    inputSchema: {
      query: z.string().describe('Username, display name or e-mail (substring match)'),
      maxResults: z.number().int().min(1).optional().describe('Maximum number of users to return'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const users = await zephyrFetch(cfg, {
        method: 'GET',
        path: '/rest/api/2/user/search',
        query: { username: args.query, maxResults: args.maxResults },
      });
      if (!Array.isArray(users)) {
        throw new Error(`Unexpected response from Jira user search (expected an array): ${JSON.stringify(users).slice(0, 300)}`);
      }
      return (users as Array<Record<string, unknown>>).map((u) => ({
        key: u.key,
        name: u.name,
        displayName: u.displayName,
        emailAddress: u.emailAddress,
      }));
    },
  });

  defineTool(server, cfg, {
    name: 'health_check',
    description:
      'Check connectivity and credentials: calls Jira /rest/api/2/myself and, when a default project key is configured, verifies that the Zephyr Scale plugin answers at /rest/atm/1.0.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async (_args, { cfg }) => {
      const me = (await zephyrFetch(cfg, { method: 'GET', path: '/rest/api/2/myself' })) as Record<string, unknown>;
      let zephyrPluginReachable: boolean | undefined;
      if (cfg.defaultProjectKey) {
        try {
          await zephyrFetch(cfg, {
            method: 'GET',
            path: atm('/environments'),
            query: { projectKey: cfg.defaultProjectKey },
          });
          zephyrPluginReachable = true;
        } catch (err) {
          // A JSON API error (400/403/404 from the plugin itself) still proves the plugin answered
          // at /rest/atm/1.0; only network failures and Jira's generic HTML 404 mean it is unreachable.
          zephyrPluginReachable = err instanceof ZephyrApiError && !(err.status === 404 && err.htmlBody);
        }
      }
      return compact({
        ok: true,
        jiraUser: (me.name ?? me.key ?? me.displayName) as string | undefined,
        baseUrl: cfg.baseUrl,
        zephyrPluginReachable,
      });
    },
  });
}
