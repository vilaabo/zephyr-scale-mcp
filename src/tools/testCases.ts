import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { atm, zephyrFetch } from '../http.js';
import {
  compact,
  defineTool,
  fieldsParam,
  pageEnvelope,
  resolveProjectKey,
  testCaseWebUrl,
  ToolInputError,
} from '../toolkit.js';
import {
  maxResultsSchema,
  newStepSchema,
  startAtSchema,
  stepSchema,
  testCaseFieldsShape,
  testScriptSchema,
  testScriptTypeSchema,
  TQL_CHEATSHEET,
} from '../schemas.js';

/** TQL queries longer than this are sent via POST /testcase/search (URL length limits). */
const SEARCH_POST_THRESHOLD = 1500;
/** API limit: unique test case keys per link-issues call. */
const MAX_UNIQUE_LINKED_TEST_CASES = 2500;

const projectKeySchema = z.string().optional().describe('Jira project key; defaults to ZEPHYR_DEFAULT_PROJECT_KEY');
const testCaseKeySchema = z.string().describe('Test case key, e.g. PROJ-T123');
const fieldsSchema = z
  .array(z.string())
  .optional()
  .describe('Return only these fields, e.g. ["key","name","status","testScript"]; sent to the API as a comma-separated list');

/** Every create field made optional for partial updates (name included; projectKey cannot change). */
const updatableTestCaseFieldsShape = {
  ...testCaseFieldsShape,
  name: testCaseFieldsShape.name.optional(),
};

const bulkTestCaseSchema = z
  .object({
    projectKey: z
      .string()
      .optional()
      .describe('Project key for this test case; falls back to the shared projectKey parameter, then ZEPHYR_DEFAULT_PROJECT_KEY'),
    ...testCaseFieldsShape,
  })
  .strict();

const issueLinkPairSchema = z
  .object({
    testCaseKey: testCaseKeySchema,
    issueKey: z.string().describe('Jira issue key, e.g. PROJ-123'),
  })
  .strict();

/** Raw step as returned by GET /testcase — may carry extra fields (index, attachments, …). */
type RawStep = Record<string, unknown>;

/** Keep only the writable step fields the PUT endpoint understands; drop index and other read-only extras. */
function toWritableStep(step: RawStep): Record<string, unknown> {
  return compact({
    id: step.id,
    description: step.description,
    testData: step.testData,
    expectedResult: step.expectedResult,
    testCaseKey: step.testCaseKey,
  });
}

export function registerTestCaseTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'create_test_case',
    description:
      "Create a Zephyr Scale test case (POST /testcase). Returns { key, url } with a key like PROJ-T123. Constraints: the folder, if given, MUST already exist — the API never creates folders (use create_folder first); status and priority are case-sensitive internal names (defaults 'Draft'/'Approved'/'Deprecated' and 'High'/'Normal'/'Low'; instances may define custom ones); owner is a Jira user key like JIRAUSER10000 (resolve with find_jira_user); estimatedTime is in milliseconds. testScript formats: STEP_BY_STEP with steps (a step carrying testCaseKey is a 'Call to Test' that inlines another test case), PLAIN_TEXT with text, or BDD with text holding the full Gherkin document (stored verbatim).",
    inputSchema: {
      projectKey: projectKeySchema,
      ...testCaseFieldsShape,
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      const { projectKey, ...fields } = args;
      const res = (await zephyrFetch(cfg, {
        method: 'POST',
        path: atm('/testcase'),
        body: compact({ projectKey: resolveProjectKey(cfg, projectKey), ...fields }),
      })) as { key: string };
      return { key: res.key, url: testCaseWebUrl(cfg, res.key) };
    },
  });

  defineTool(server, cfg, {
    name: 'get_test_case',
    description:
      'Read a Zephyr Scale test case by key (GET /testcase/{testCaseKey}). Optionally restrict the payload with fields. STEP_BY_STEP scripts come back with per-step ids — those ids are required to edit steps safely via update_test_case (add_test_steps handles them automatically).',
    inputSchema: {
      testCaseKey: testCaseKeySchema,
      fields: fieldsSchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) =>
      zephyrFetch(cfg, {
        method: 'GET',
        path: atm(`/testcase/${encodeURIComponent(args.testCaseKey)}`),
        query: { fields: fieldsParam(args.fields) },
      }),
  });

  defineTool(server, cfg, {
    name: 'search_test_cases',
    description: `Search Zephyr Scale test cases with a TQL query (GET /testcase/search). Returns { startAt, maxResults, count, isLast, values }; isLast is the heuristic count < maxResults. Paginate with startAt (default 0) and maxResults (default 50; the API server-side default is 200).

${TQL_CHEATSHEET}

Note: queries longer than 1500 characters (typically large IN lists) are automatically sent via POST /testcase/search, which is RESTRICTED to the fields projectKey, key and name, and to at most 2500 values in an IN list.`,
    inputSchema: {
      query: z.string().describe('TQL query, e.g. projectKey = "PROJ" AND status = "Draft"'),
      fields: fieldsSchema,
      startAt: startAtSchema,
      maxResults: maxResultsSchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const startAt = args.startAt ?? 0;
      const maxResults = args.maxResults ?? 50;
      const raw =
        args.query.length > SEARCH_POST_THRESHOLD
          ? await zephyrFetch(cfg, {
              method: 'POST',
              path: atm('/testcase/search'),
              body: compact({ query: args.query, startAt, maxResults, fields: args.fields }),
            })
          : await zephyrFetch(cfg, {
              method: 'GET',
              path: atm('/testcase/search'),
              query: { query: args.query, startAt, maxResults, fields: fieldsParam(args.fields) },
            });
      return pageEnvelope(startAt, maxResults, Array.isArray(raw) ? raw : []);
    },
  });

  defineTool(server, cfg, {
    name: 'update_test_case',
    description:
      'Update a Zephyr Scale test case (PUT /testcase/{testCaseKey}). PARTIAL update: only the fields you pass are changed; omitted fields keep their current values — never send empty placeholders. projectKey cannot be changed. STEP_BY_STEP step synchronization: when testScript.steps is passed, steps are matched by id — a step WITHOUT an id is CREATED, a step WITH an id is UPDATED, and any existing step MISSING from the list is DELETED. Therefore always pass the COMPLETE final list of steps, carrying over the ids of steps to keep (read them with get_test_case). To merely add steps, prefer add_test_steps, which performs that read-merge-write safely. Returns { key, url }.',
    inputSchema: {
      testCaseKey: testCaseKeySchema,
      ...updatableTestCaseFieldsShape,
    },
    annotations: { idempotentHint: true },
    handler: async (args, { cfg }) => {
      const { testCaseKey, ...fields } = args;
      await zephyrFetch(cfg, {
        method: 'PUT',
        path: atm(`/testcase/${encodeURIComponent(testCaseKey)}`),
        body: compact(fields),
      });
      return { key: testCaseKey, url: testCaseWebUrl(cfg, testCaseKey) };
    },
  });

  defineTool(server, cfg, {
    name: 'add_test_steps',
    description:
      "Add steps to a STEP_BY_STEP test case without losing the existing ones. Composite operation: reads the test case, merges the new steps at the requested position while preserving existing step ids (so nothing is deleted), and writes the full list back. position: 'append' (default) adds after the last step, 'prepend' before the first, an integer inserts at that 0-based index (clamped to the current length). Only valid when the current script is STEP_BY_STEP or the test case has no script yet (a step-by-step script is then created); for a PLAIN_TEXT or BDD script use set_test_script instead. Returns { key, totalSteps }.",
    inputSchema: {
      testCaseKey: testCaseKeySchema,
      steps: z
        .array(newStepSchema)
        .min(1)
        .describe('New steps to insert, in order (no ids). A step carrying testCaseKey is a "Call to Test".'),
      position: z
        .union([z.literal('append'), z.literal('prepend'), z.number().int().min(0)])
        .optional()
        .describe("'append' (default), 'prepend', or a 0-based insertion index into the existing steps (clamped to the list length)"),
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      const key = encodeURIComponent(args.testCaseKey);
      const existing = (await zephyrFetch(cfg, { method: 'GET', path: atm(`/testcase/${key}`) })) as {
        testScript?: { type?: string; steps?: RawStep[] } | null;
      };
      const script = existing.testScript ?? undefined;
      if (script && script.type !== 'STEP_BY_STEP') {
        throw new ToolInputError(
          `Test case ${args.testCaseKey} has a ${script.type} script — add_test_steps only works with STEP_BY_STEP scripts. Use set_test_script to replace the script (this irreversibly deletes the current ${script.type} content).`,
        );
      }
      const existingSteps = (script?.steps ?? []).map(toWritableStep);
      const newSteps = args.steps.map((step) => compact(step));
      const position = args.position ?? 'append';
      const insertAt =
        position === 'append' ? existingSteps.length : position === 'prepend' ? 0 : Math.min(position, existingSteps.length);
      const merged = [...existingSteps.slice(0, insertAt), ...newSteps, ...existingSteps.slice(insertAt)];
      await zephyrFetch(cfg, {
        method: 'PUT',
        path: atm(`/testcase/${key}`),
        body: { testScript: { type: 'STEP_BY_STEP', steps: merged } },
      });
      return { key: args.testCaseKey, totalSteps: merged.length };
    },
  });

  defineTool(server, cfg, {
    name: 'set_test_script',
    description:
      "Replace a test case's ENTIRE script or change its format (PUT /testcase/{testCaseKey} with a full testScript). WARNING — destructive: switching a STEP_BY_STEP script to PLAIN_TEXT or BDD irreversibly deletes all existing steps, and a STEP_BY_STEP replacement deletes every existing step omitted from the list. Pass text for PLAIN_TEXT/BDD (for BDD the full Gherkin document, stored verbatim); pass steps for STEP_BY_STEP. Returns { key, url }.",
    inputSchema: {
      testCaseKey: testCaseKeySchema,
      type: testScriptTypeSchema.describe('New script format'),
      text: z.string().optional().describe('Script body — required for PLAIN_TEXT and BDD (full Gherkin document), not allowed for STEP_BY_STEP'),
      steps: z
        .array(stepSchema)
        .optional()
        .describe(
          'Complete final list of steps — required for STEP_BY_STEP, not allowed otherwise. Existing steps omitted here are deleted; keep their ids (from get_test_case) to update them in place.',
        ),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (args, { cfg }) => {
      const testScript = testScriptSchema.parse(compact({ type: args.type, text: args.text, steps: args.steps }));
      await zephyrFetch(cfg, {
        method: 'PUT',
        path: atm(`/testcase/${encodeURIComponent(args.testCaseKey)}`),
        body: { testScript },
      });
      return { key: args.testCaseKey, url: testCaseWebUrl(cfg, args.testCaseKey) };
    },
  });

  defineTool(server, cfg, {
    name: 'delete_test_case',
    description:
      'Permanently delete a Zephyr Scale test case (DELETE /testcase/{testCaseKey}). This cannot be undone. Returns { deleted: true, key }.',
    inputSchema: {
      testCaseKey: testCaseKeySchema,
    },
    annotations: { destructiveHint: true },
    handler: async (args, { cfg }) => {
      await zephyrFetch(cfg, {
        method: 'DELETE',
        path: atm(`/testcase/${encodeURIComponent(args.testCaseKey)}`),
      });
      return { deleted: true, key: args.testCaseKey };
    },
  });

  defineTool(server, cfg, {
    name: 'create_test_cases_bulk',
    description:
      'Create multiple Zephyr Scale test cases in one call (POST /testcase/bulk). Each item accepts the same fields as create_test_case; an item without its own projectKey uses the shared projectKey parameter (or ZEPHYR_DEFAULT_PROJECT_KEY). The same constraints apply: folders must already exist, status/priority values are case-sensitive, owner is a Jira user key. Returns an array of { key, url } for the created test cases.',
    inputSchema: {
      projectKey: z
        .string()
        .optional()
        .describe('Shared project key for items that do not specify their own; defaults to ZEPHYR_DEFAULT_PROJECT_KEY'),
      testCases: z.array(bulkTestCaseSchema).min(1).describe('Test cases to create, each shaped like create_test_case input'),
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      const body = args.testCases.map((item) => {
        const { projectKey, ...fields } = item;
        return compact({ projectKey: resolveProjectKey(cfg, projectKey ?? args.projectKey), ...fields });
      });
      const raw = await zephyrFetch(cfg, { method: 'POST', path: atm('/testcase/bulk'), body });
      const entries = Array.isArray(raw) ? raw : [raw];
      return entries.map((entry) => {
        const key =
          typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? (entry as { key?: unknown }).key : undefined;
        return typeof key === 'string' ? { key, url: testCaseWebUrl(cfg, key) } : entry;
      });
    },
  });

  defineTool(server, cfg, {
    name: 'link_issues_to_test_cases',
    description:
      'Link Jira issues to Zephyr Scale test cases in bulk (POST /testcase/link-issues). Each entry links one test case (testCaseKey, e.g. PROJ-T123) to one Jira issue (issueKey, e.g. PROJ-123); repeat a test case key across entries to link it to several issues. API limit: at most 2500 UNIQUE test case keys per call — validated locally before any request is sent.',
    inputSchema: {
      links: z.array(issueLinkPairSchema).min(1).describe('Pairs of { testCaseKey, issueKey } to link'),
    },
    annotations: { idempotentHint: true },
    handler: async (args, { cfg }) => {
      const uniqueKeys = new Set(args.links.map((link) => link.testCaseKey));
      if (uniqueKeys.size > MAX_UNIQUE_LINKED_TEST_CASES) {
        throw new ToolInputError(
          `The API accepts at most ${MAX_UNIQUE_LINKED_TEST_CASES} unique test case keys per call, got ${uniqueKeys.size}. Split the links into smaller batches.`,
        );
      }
      const raw = await zephyrFetch(cfg, {
        method: 'POST',
        path: atm('/testcase/link-issues'),
        body: args.links,
      });
      const empty = raw === null || raw === undefined || (typeof raw === 'object' && Object.keys(raw as object).length === 0);
      return empty ? { linked: args.links.length } : raw;
    },
  });

  defineTool(server, cfg, {
    name: 'get_test_cases_linked_to_issue',
    description:
      'List the Zephyr Scale test cases linked to a Jira issue (GET /issuelink/{issueKey}/testcases). Useful for traceability from a requirement or bug to its tests.',
    inputSchema: {
      issueKey: z.string().describe('Jira issue key, e.g. PROJ-123'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) =>
      zephyrFetch(cfg, {
        method: 'GET',
        path: atm(`/issuelink/${encodeURIComponent(args.issueKey)}/testcases`),
      }),
  });
}
