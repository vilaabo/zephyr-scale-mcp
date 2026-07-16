import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { addHint, atm, zephyrFetch, ZephyrApiError } from '../http.js';
import { compact, defineTool } from '../toolkit.js';
import { RESULT_STATUS_NOTE, testResultFieldsShape } from '../schemas.js';

const RUN_COMPOSITION_HINT =
  "A test run's item list is fixed when the run is created — the test case must already be one of the run's items. To change a run's composition you have to create a new run with the full items list (see README, 'API v1 limitations').";

/**
 * 400/404 from the result endpoints typically means the test case is not part of the run
 * (the endpoints only look up EXISTING run items) — attach the immutability hint (§7.3, §10.1).
 */
function withRunCompositionHint(err: unknown): unknown {
  if (err instanceof ZephyrApiError && (err.status === 400 || err.status === 404)) {
    return addHint(err, RUN_COMPOSITION_HINT);
  }
  return err;
}

/**
 * Optional run-item selectors, sent as QUERY parameters (never in the request body).
 * They pick WHICH run item is targeted when the same test case is included in a run
 * as several items (e.g. once per environment or per assignee).
 */
const itemSelectorsShape = {
  matchEnvironment: z
    .string()
    .optional()
    .describe(
      "Run-item selector, sent as the 'environment' QUERY parameter (never in the body): when the same test case is included in the run as several items, targets the item with this environment (case-sensitive). Distinct from the 'environment' body field, which sets the environment recorded on the result.",
    ),
  matchUserKey: z
    .string()
    .optional()
    .describe(
      "Run-item selector, sent as the 'userKey' QUERY parameter (never in the body): when the same test case is included in the run as several items, targets the item by its executor's Jira user key (e.g. 'JIRAUSER10000').",
    ),
};

function selectorQuery(args: { matchEnvironment?: string | undefined; matchUserKey?: string | undefined }): {
  environment: string | undefined;
  userKey: string | undefined;
} {
  return { environment: args.matchEnvironment, userKey: args.matchUserKey };
}

const RESULT_FIELD_KEYS = Object.keys(testResultFieldsShape) as Array<keyof typeof testResultFieldsShape>;

/** Build the request body from the result fields only — never keys or item selectors, never unpassed optionals. */
function resultFieldsBody(args: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of RESULT_FIELD_KEYS) picked[key] = args[key];
  return compact(picked);
}

const singleResultPath = (testRunKey: string, testCaseKey: string): string =>
  atm(`/testrun/${encodeURIComponent(testRunKey)}/testcase/${encodeURIComponent(testCaseKey)}/testresult`);

export function registerTestResultTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'create_test_result',
    description:
      'Create a NEW execution (test result) for a test case that is already an item of a test run (test cycle). ' +
      'Appends a new result to the item\'s execution history — to amend the latest result instead, use update_last_test_result. ' +
      "This tool CANNOT add a test case to a run: the run's item list is fixed when the run is created, and the call fails if the case is not among the run's items. " +
      `Only the fields you pass are sent. ${RESULT_STATUS_NOTE} ` +
      'Durations (executionTime) are in milliseconds; dates are ISO 8601. scriptResults record per-step outcomes for STEP_BY_STEP scripts as { index (0-based), status, comment? }. ' +
      'If the same test case is included in the run as several items, disambiguate with matchEnvironment / matchUserKey. ' +
      'Returns { id } of the created result.',
    inputSchema: {
      testRunKey: z.string().describe('Test run (cycle) key, e.g. PROJ-R123'),
      testCaseKey: z.string().describe('Test case key, e.g. PROJ-T123 — must already be one of the run\'s items'),
      ...itemSelectorsShape,
      ...testResultFieldsShape,
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      try {
        return await zephyrFetch(cfg, {
          method: 'POST',
          path: singleResultPath(args.testRunKey, args.testCaseKey),
          query: selectorQuery(args),
          body: resultFieldsBody(args),
        });
      } catch (err) {
        throw withRunCompositionHint(err);
      }
    },
  });

  defineTool(server, cfg, {
    name: 'update_last_test_result',
    description:
      'Update the LAST (most recent) test result of a run item. Partial update: ONLY the fields you pass are changed, everything else is preserved — do not send fields you do not want to modify. ' +
      'Older executions cannot be targeted; to record a new execution use create_test_result. ' +
      "The test case must already be one of the run's items (the run's composition is fixed at creation). " +
      `${RESULT_STATUS_NOTE} ` +
      'Durations (executionTime) are in milliseconds; dates are ISO 8601. scriptResults record per-step outcomes as { index (0-based), status, comment? }. ' +
      'If the same test case is included in the run as several items, disambiguate with matchEnvironment / matchUserKey.',
    inputSchema: {
      testRunKey: z.string().describe('Test run (cycle) key, e.g. PROJ-R123'),
      testCaseKey: z.string().describe('Test case key, e.g. PROJ-T123 — must already be one of the run\'s items'),
      ...itemSelectorsShape,
      ...testResultFieldsShape,
    },
    annotations: { idempotentHint: true },
    handler: async (args, { cfg }) => {
      let res: unknown;
      try {
        res = await zephyrFetch(cfg, {
          method: 'PUT',
          path: singleResultPath(args.testRunKey, args.testCaseKey),
          query: selectorQuery(args),
          body: resultFieldsBody(args),
        });
      } catch (err) {
        throw withRunCompositionHint(err);
      }
      if (res !== null && typeof res === 'object' && !Array.isArray(res) && Object.keys(res).length === 0) {
        return { updated: true, testRunKey: args.testRunKey, testCaseKey: args.testCaseKey };
      }
      return res;
    },
  });

  defineTool(server, cfg, {
    name: 'create_test_results_bulk',
    description:
      'Create NEW executions (test results) for several test cases of one test run in a single call. ' +
      "Every element's testCaseKey must already be one of the run's items — the run's item list is fixed when the run is created and this tool cannot extend it. " +
      `In each element only the fields you pass are sent. ${RESULT_STATUS_NOTE} ` +
      'Durations (executionTime) are in milliseconds; dates are ISO 8601. scriptResults record per-step outcomes as { index (0-based), status, comment? }. ' +
      'matchEnvironment / matchUserKey apply to the whole batch and disambiguate run items when the same test case is included in the run several times. ' +
      'Returns the array of created result ids.',
    inputSchema: {
      testRunKey: z.string().describe('Test run (cycle) key, e.g. PROJ-R123'),
      results: z
        .array(
          z
            .object({
              testCaseKey: z.string().describe('Test case key, e.g. PROJ-T123 — must already be one of the run\'s items'),
              ...testResultFieldsShape,
            })
            .strict(),
        )
        .min(1)
        .describe('One entry per result to create; each targets an existing run item by testCaseKey'),
      ...itemSelectorsShape,
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      try {
        return await zephyrFetch(cfg, {
          method: 'POST',
          path: atm(`/testrun/${encodeURIComponent(args.testRunKey)}/testresults`),
          query: selectorQuery(args),
          body: args.results.map((result) => compact(result)),
        });
      } catch (err) {
        throw withRunCompositionHint(err);
      }
    },
  });

  defineTool(server, cfg, {
    name: 'get_latest_result_for_test_case',
    description:
      'Get the latest (most recent) execution result of a test case across ALL test runs (cycles). ' +
      'Use get_test_run_results to read the results of one specific run instead.',
    inputSchema: {
      testCaseKey: z.string().describe('Test case key, e.g. PROJ-T123'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) =>
      zephyrFetch(cfg, {
        method: 'GET',
        path: atm(`/testcase/${encodeURIComponent(args.testCaseKey)}/testresult/latest`),
      }),
  });
}
