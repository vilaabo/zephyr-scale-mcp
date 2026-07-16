import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { atm, zephyrFetch } from '../http.js';
import { fetchRunResultsPage } from '../runResults.js';
import { customFieldsSchema, maxResultsSchema, startAtSchema, testResultFieldsShape, USER_KEY_NOTE } from '../schemas.js';
import { compact, defineTool, fieldsParam, pageEnvelope, resolveProjectKey } from '../toolkit.js';

const IMMUTABILITY_NOTE =
  'IMPORTANT API v1 limitation: a test run is IMMUTABLE after creation — there is no PUT /testrun/{key}. A run cannot be renamed, moved to another folder, and test cases cannot be added to or removed from it later; the set of items is fixed ONLY at creation time. The run status is computed automatically from the statuses of its items and cannot be set directly.';

/**
 * One item of a test run: the test case to include plus (optionally) full execution
 * result fields, so a run can be imported together with its results in one call.
 */
const testRunItemSchema = z
  .object({
    testCaseKey: z.string().describe('Key of the test case to include in the run, e.g. PROJ-T123'),
    ...testResultFieldsShape,
  })
  .strict();

export function registerTestRunTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'create_test_run',
    description:
      `Create a Zephyr Scale test run (test cycle; key like PROJ-R123). ${IMMUTABILITY_NOTE} ` +
      'Therefore pass the COMPLETE list of test cases in `items` now — each item may also carry full execution result fields ' +
      '(status, executedBy, executionTime, actualStartDate/actualEndDate, per-step scriptResults, etc.), which allows importing a run together ' +
      'with its results in a single call. To record or update executions of the included items afterwards, use the test result tools. ' +
      "Item/result statuses default to 'Not Executed', 'In Progress', 'Pass', 'Fail', 'Blocked' (case-sensitive; instances may define custom ones).",
    inputSchema: {
      projectKey: z.string().optional().describe('Jira project key; defaults to ZEPHYR_DEFAULT_PROJECT_KEY'),
      name: z.string().describe('Test run name (cannot be changed after creation)'),
      folder: z
        .string()
        .optional()
        .describe(
          'Full path of a TEST_RUN folder starting with "/", e.g. "/Regression". The folder MUST already exist (create it with create_folder, type TEST_RUN); it is not created automatically.',
        ),
      testPlanKey: z.string().optional().describe('Key of the test plan to associate the run with, e.g. PROJ-P123'),
      issueLinks: z.array(z.string()).optional().describe('Jira issue keys to link, e.g. ["PROJ-123"]'),
      iteration: z.string().optional(),
      version: z.string().optional(),
      owner: z.string().optional().describe(`Owner. ${USER_KEY_NOTE}`),
      plannedStartDate: z.string().optional().describe('ISO 8601, e.g. 2026-07-20T00:00:00Z (passed through as-is)'),
      plannedEndDate: z.string().optional().describe('ISO 8601 (passed through as-is)'),
      customFields: customFieldsSchema.optional().describe('Custom field values keyed by field name'),
      items: z
        .array(testRunItemSchema)
        .optional()
        .describe(
          'Test cases to include in the run — this is the ONLY place where the run composition can be set. Each item requires testCaseKey and may carry full execution result fields (status, environment, executedBy, assignedTo, comment, executionTime, actualStartDate, actualEndDate, customFields, issueLinks, scriptResults).',
        ),
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      const body = compact({
        projectKey: resolveProjectKey(cfg, args.projectKey),
        name: args.name,
        folder: args.folder,
        testPlanKey: args.testPlanKey,
        issueLinks: args.issueLinks,
        iteration: args.iteration,
        version: args.version,
        owner: args.owner,
        plannedStartDate: args.plannedStartDate,
        plannedEndDate: args.plannedEndDate,
        customFields: args.customFields,
        items: args.items?.map((item) => compact(item)),
      });
      const res = (await zephyrFetch(cfg, { method: 'POST', path: atm('/testrun'), body })) as { key: string };
      return { key: res.key };
    },
  });

  defineTool(server, cfg, {
    name: 'get_test_run',
    description:
      `Read a Zephyr Scale test run (test cycle) by key, including its items. ${IMMUTABILITY_NOTE} ` +
      'Use get_test_run_results to page through the execution results of the run.',
    inputSchema: {
      testRunKey: z.string().describe('Test run key, e.g. PROJ-R123'),
      fields: z
        .array(z.string())
        .optional()
        .describe('Restrict the response to these fields (serialized comma-separated), e.g. ["key", "name", "status"]'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) =>
      zephyrFetch(cfg, {
        method: 'GET',
        path: atm(`/testrun/${encodeURIComponent(args.testRunKey)}`),
        query: { fields: fieldsParam(args.fields) },
      }),
  });

  defineTool(server, cfg, {
    name: 'search_test_runs',
    description:
      'Search Zephyr Scale test runs (test cycles) with TQL. For test runs TQL supports ONLY the fields `projectKey` and `folder`, ' +
      'ONLY the operators = and IN, and AND as the only logical connector (no OR, no other fields). ' +
      'Syntax is strict: spaces around operators are mandatory, string values go in double quotes, folder paths start with "/" ("/" is the root). ' +
      'Examples: projectKey = "PROJ" · projectKey = "PROJ" AND folder = "/Regression". ' +
      'Returns { startAt, maxResults, count, isLast, values }.',
    inputSchema: {
      query: z.string().describe('TQL query; for test runs only projectKey and folder are searchable'),
      fields: z
        .array(z.string())
        .optional()
        .describe('Restrict returned entities to these fields (serialized comma-separated)'),
      startAt: startAtSchema,
      maxResults: maxResultsSchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const startAt = args.startAt ?? 0;
      const maxResults = args.maxResults ?? 50;
      const values = (await zephyrFetch(cfg, {
        method: 'GET',
        path: atm('/testrun/search'),
        query: { query: args.query, fields: fieldsParam(args.fields), startAt, maxResults },
      })) as unknown[];
      return pageEnvelope(startAt, maxResults, values);
    },
  });

  defineTool(server, cfg, {
    name: 'delete_test_run',
    description:
      'Permanently delete a Zephyr Scale test run (test cycle) together with all its execution results. ' +
      'Since runs are immutable after creation, deleting and re-creating a run (create_test_run with the full desired `items`) ' +
      'is the only way to change its name, folder or composition.',
    inputSchema: {
      testRunKey: z.string().describe('Test run key, e.g. PROJ-R123'),
    },
    annotations: { destructiveHint: true },
    handler: async (args, { cfg }) => {
      await zephyrFetch(cfg, { method: 'DELETE', path: atm(`/testrun/${encodeURIComponent(args.testRunKey)}`) });
      return { deleted: true, key: args.testRunKey };
    },
  });

  defineTool(server, cfg, {
    name: 'get_test_run_results',
    description:
      'Page through the execution results of a Zephyr Scale test run (test cycle) via the paginated endpoint ' +
      'GET /testrun/{key}/testresults/page (the flat non-paginated variant is deprecated and used only as a fallback: ' +
      'older Zephyr Scale versions lack the /page endpoint, in which case the flat endpoint is read and paginated client-side — ' +
      'the response then carries a `note` field saying so). ' +
      'An item of a run can have several executions; set onlyLastExecutions to true to get only the most recent execution per item. ' +
      'Returns { startAt, maxResults, total, count, isLast, values } where total is the overall number of results on the server.',
    inputSchema: {
      testRunKey: z.string().describe('Test run key, e.g. PROJ-R123'),
      startAt: startAtSchema,
      maxResults: maxResultsSchema,
      onlyLastExecutions: z
        .boolean()
        .optional()
        .describe('When true, return only the last execution of each test run item (API default false — all executions)'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const startAt = args.startAt ?? 0;
      const maxResults = args.maxResults ?? 50;
      const page = await fetchRunResultsPage(cfg, args.testRunKey, {
        startAt,
        maxResults,
        onlyLastExecutions: args.onlyLastExecutions,
      });
      return compact({
        startAt,
        maxResults,
        total: page.total,
        count: page.values.length,
        isLast: startAt + page.values.length >= page.total,
        note: page.note,
        values: page.values,
      });
    },
  });
}
