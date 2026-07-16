import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { atm, zephyrFetch } from '../http.js';
import { compact, defineTool, fieldsParam, pageEnvelope, resolveProjectKey } from '../toolkit.js';
import { customFieldsSchema, maxResultsSchema, startAtSchema, USER_KEY_NOTE } from '../schemas.js';

const testPlanKeySchema = z.string().describe('Test plan key, e.g. PROJ-P123');
const fieldsSchema = z
  .array(z.string())
  .optional()
  .describe('Return only these fields, e.g. ["key","name","status"]; sent to the API as a comma-separated list');

/** Fields shared by create_test_plan / update_test_plan (§7.6); `name` is required on create only. */
const testPlanFieldsShape = {
  name: z.string().describe('Test plan name'),
  objective: z.string().optional().describe('Objective (HTML allowed)'),
  folder: z
    .string()
    .optional()
    .describe(
      'Full TEST_PLAN folder path from the root starting with "/", e.g. "/Releases/2026". The folder MUST already exist — create it first with create_folder using type TEST_PLAN.',
    ),
  status: z
    .string()
    .optional()
    .describe("Test plan status. Defaults: 'Draft', 'Approved', 'Deprecated' — case-sensitive; instances may define custom ones."),
  owner: z.string().optional().describe(`Owner. ${USER_KEY_NOTE}`),
  labels: z.array(z.string()).optional().describe('Labels; the API replaces spaces with underscores'),
  issueLinks: z.array(z.string()).optional().describe('Jira issue keys to link, e.g. ["PROJ-123"]'),
  customFields: customFieldsSchema.optional().describe('Custom field values keyed by field name'),
};

/** Every create field made optional for partial updates (name included; projectKey cannot change). */
const updatableTestPlanFieldsShape = {
  ...testPlanFieldsShape,
  name: testPlanFieldsShape.name.optional(),
};

export function registerTestPlanTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'create_test_plan',
    description:
      "Create a Zephyr Scale test plan (POST /testplan). Returns { key } with a key like PROJ-P123 (no UI url — it cannot be built reliably for test plans). Constraints: the folder, if given, MUST be an existing folder of type TEST_PLAN — the API never creates folders (use create_folder with type TEST_PLAN first); status is a case-sensitive internal name (defaults 'Draft'/'Approved'/'Deprecated'; instances may define custom ones); owner is a Jira user key like JIRAUSER10000 (resolve with find_jira_user).",
    inputSchema: {
      projectKey: z.string().optional().describe('Jira project key; defaults to ZEPHYR_DEFAULT_PROJECT_KEY'),
      ...testPlanFieldsShape,
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      const { projectKey, ...fields } = args;
      const res = (await zephyrFetch(cfg, {
        method: 'POST',
        path: atm('/testplan'),
        body: compact({ projectKey: resolveProjectKey(cfg, projectKey), ...fields }),
      })) as { key: string };
      return { key: res.key };
    },
  });

  defineTool(server, cfg, {
    name: 'get_test_plan',
    description:
      'Read a Zephyr Scale test plan by key (GET /testplan/{testPlanKey}). Optionally restrict the payload with fields. The response includes linked test runs and issues when present.',
    inputSchema: {
      testPlanKey: testPlanKeySchema,
      fields: fieldsSchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) =>
      zephyrFetch(cfg, {
        method: 'GET',
        path: atm(`/testplan/${encodeURIComponent(args.testPlanKey)}`),
        query: { fields: fieldsParam(args.fields) },
      }),
  });

  defineTool(server, cfg, {
    name: 'update_test_plan',
    description:
      'Update a Zephyr Scale test plan (PUT /testplan/{testPlanKey}). PARTIAL update: only the fields you pass are changed; omitted fields keep their current values — never send empty placeholders. projectKey cannot be changed. The same constraints as create_test_plan apply: the folder must be an existing TEST_PLAN folder, status is case-sensitive, owner is a Jira user key. Returns { key }.',
    inputSchema: {
      testPlanKey: testPlanKeySchema,
      ...updatableTestPlanFieldsShape,
    },
    annotations: { idempotentHint: true },
    handler: async (args, { cfg }) => {
      const { testPlanKey, ...fields } = args;
      await zephyrFetch(cfg, {
        method: 'PUT',
        path: atm(`/testplan/${encodeURIComponent(testPlanKey)}`),
        body: compact(fields),
      });
      return { key: testPlanKey };
    },
  });

  defineTool(server, cfg, {
    name: 'delete_test_plan',
    description:
      'Permanently delete a Zephyr Scale test plan (DELETE /testplan/{testPlanKey}). This cannot be undone. Returns { deleted: true, key }.',
    inputSchema: {
      testPlanKey: testPlanKeySchema,
    },
    annotations: { destructiveHint: true },
    handler: async (args, { cfg }) => {
      await zephyrFetch(cfg, {
        method: 'DELETE',
        path: atm(`/testplan/${encodeURIComponent(args.testPlanKey)}`),
      });
      return { deleted: true, key: args.testPlanKey };
    },
  });

  defineTool(server, cfg, {
    name: 'search_test_plans',
    description:
      'Search Zephyr Scale test plans with a TQL query (GET /testplan/search). Returns { startAt, maxResults, count, isLast, values }; isLast is the heuristic count < maxResults. Paginate with startAt (default 0) and maxResults (default 50; the API server-side default is 200). TQL syntax is strict: spaces around operators are mandatory, string values go in double quotes, and the only logical connector is AND (no OR). Commonly supported test plan fields are projectKey, folder, name and status (e.g. projectKey = "PROJ" AND status = "Approved") — the exact set varies by Zephyr Scale version.',
    inputSchema: {
      query: z.string().describe('TQL query, e.g. projectKey = "PROJ" AND folder = "/Releases"'),
      fields: fieldsSchema,
      startAt: startAtSchema,
      maxResults: maxResultsSchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const startAt = args.startAt ?? 0;
      const maxResults = args.maxResults ?? 50;
      const raw = await zephyrFetch(cfg, {
        method: 'GET',
        path: atm('/testplan/search'),
        query: { query: args.query, startAt, maxResults, fields: fieldsParam(args.fields) },
      });
      return pageEnvelope(startAt, maxResults, Array.isArray(raw) ? raw : []);
    },
  });
}
