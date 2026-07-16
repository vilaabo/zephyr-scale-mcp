import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { atm, zephyrFetch, ZephyrApiError } from '../http.js';
import { customFieldsSchema } from '../schemas.js';
import { compact, defineTool, resolveProjectKey } from '../toolkit.js';

const FOLDER_LISTING_NOTE =
  'The public Server/DC API v1 cannot LIST folders, so keep the numeric id returned by create_folder — rename_folder needs it (otherwise the id can only be found in the Jira UI).';

async function postFolder(cfg: Config, projectKey: string, name: string, type: string): Promise<{ id?: number }> {
  return (await zephyrFetch(cfg, {
    method: 'POST',
    path: atm('/folder'),
    body: { projectKey, name, type },
  })) as { id?: number };
}

export function registerFolderTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'create_folder',
    description:
      'Create a Zephyr Scale folder for test cases, test plans or test runs (test cycles). ' +
      '`name` is the FULL path from the root and must start with "/", e.g. "/Regression/Payments". ' +
      'With recursive=true (default) missing parent folders are created automatically: if the API rejects the full path with 400, ' +
      'every parent prefix is created from the root and the full path is retried. ' +
      'Folders are NOT auto-created by create_test_case / create_test_run — create them with this tool first. ' +
      FOLDER_LISTING_NOTE,
    inputSchema: {
      projectKey: z.string().optional().describe('Jira project key; defaults to ZEPHYR_DEFAULT_PROJECT_KEY'),
      name: z
        .string()
        .regex(/^\//, 'name must be a full folder path starting with "/"')
        .describe('Full folder path from the root, starting with "/", e.g. "/Regression/Payments"'),
      type: z
        .enum(['TEST_CASE', 'TEST_PLAN', 'TEST_RUN'])
        .describe('Folder kind: TEST_CASE (test case folders), TEST_PLAN (test plan folders) or TEST_RUN (test cycle folders)'),
      recursive: z
        .boolean()
        .optional()
        .describe('Create missing parent folders automatically on a 400 response (default true). Handled client-side, never sent to the API.'),
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      const projectKey = resolveProjectKey(cfg, args.projectKey);
      const recursive = args.recursive ?? true;
      let created: { id?: number };
      try {
        created = await postFolder(cfg, projectKey, args.name, args.type);
      } catch (err) {
        if (!recursive || !(err instanceof ZephyrApiError) || err.status !== 400) throw err;
        // Likely a missing parent folder: create every prefix path from the root
        // ("/a", "/a/b", ...), ignoring 400s (folder already exists), then retry the full path.
        const segments = args.name.split('/').filter((s) => s.length > 0);
        for (let i = 1; i < segments.length; i++) {
          const prefix = `/${segments.slice(0, i).join('/')}`;
          try {
            await postFolder(cfg, projectKey, prefix, args.type);
          } catch (prefixErr) {
            if (!(prefixErr instanceof ZephyrApiError) || prefixErr.status !== 400) throw prefixErr;
          }
        }
        created = await postFolder(cfg, projectKey, args.name, args.type);
      }
      return { id: created.id, name: args.name, type: args.type };
    },
  });

  defineTool(server, cfg, {
    name: 'rename_folder',
    description:
      'Rename an existing Zephyr Scale folder by its numeric id (and optionally update its custom fields). ' +
      '`name` is the new name of that single folder segment, NOT a path — it must not contain "/" or "\\". ' +
      FOLDER_LISTING_NOTE,
    inputSchema: {
      folderId: z.number().int().describe('Numeric folder id, as returned by create_folder (the API cannot list folders)'),
      name: z
        .string()
        .regex(/^[^/\\]+$/, 'name is the new folder segment name, not a path — it must not contain "/" or "\\"')
        .describe('New folder name (a single segment without "/" or "\\")'),
      customFields: customFieldsSchema.optional().describe('Custom field values keyed by field name'),
    },
    annotations: { idempotentHint: true },
    handler: async (args, { cfg }) => {
      await zephyrFetch(cfg, {
        method: 'PUT',
        path: atm(`/folder/${encodeURIComponent(String(args.folderId))}`),
        body: compact({ name: args.name, customFields: args.customFields }),
      });
      return { id: args.folderId, name: args.name };
    },
  });
}
