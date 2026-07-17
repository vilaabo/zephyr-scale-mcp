import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { addHint, atm, zephyrFetch } from '../http.js';
import { fetchRunResultsPage } from '../runResults.js';
import { customFieldsSchema, testResultFieldsShape, USER_KEY_NOTE } from '../schemas.js';
import { compact, defineTool, resolveProjectKey } from '../toolkit.js';

/** Result fields (§7.4) that may be carried over into the items of the recreated run. */
const RESULT_FIELD_KEYS = Object.keys(testResultFieldsShape);

/** Page size used while collecting the source run's results when copyResults=true. */
const RESULTS_PAGE_SIZE = 200;
/** Safety cap so an inconsistent `total` can never loop forever. */
const MAX_RESULT_PAGES = 50;

const addItemSchema = z
  .object({
    testCaseKey: z.string().describe('Key of the test case to add to the new run, e.g. PROJ-T123'),
    ...testResultFieldsShape,
  })
  .strict();

/** Segment of the internal foldertree endpoint per folder type. */
const FOLDER_TREE_SEGMENT = { test_case: 'testcase', test_plan: 'testplan', test_run: 'testrun' } as const;

/** Strip stored script results down to the { index, status, comment } shape POST /testrun accepts. */
function sanitizeScriptResults(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const e = entry as Record<string, unknown>;
    return compact({ index: e.index, status: e.status, comment: e.comment ?? undefined });
  });
}

/** Pick only the §7.4 result fields from a stored execution result (drops ids, read-only junk and nulls). */
function copyableResultFields(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of RESULT_FIELD_KEYS) {
    const value = result[key];
    if (value === undefined || value === null) continue;
    out[key] = key === 'scriptResults' ? sanitizeScriptResults(value) : value;
  }
  return out;
}

/** Explicit argument wins; otherwise the source run's value, with JSON null treated as absent. */
const inherit = (explicit: unknown, sourceValue: unknown): unknown => (explicit !== undefined ? explicit : (sourceValue ?? undefined));

/** Collect the LAST execution of every item of the run, indexed by testCaseKey. */
async function collectLatestResults(
  cfg: Config,
  testRunKey: string,
): Promise<{ latest: Map<string, Record<string, unknown>>; truncated: boolean }> {
  const latest = new Map<string, Record<string, unknown>>();
  let startAt = 0;
  let truncated = false;
  for (let page = 0; ; page++) {
    const res = await fetchRunResultsPage(cfg, testRunKey, {
      startAt,
      maxResults: RESULTS_PAGE_SIZE,
      onlyLastExecutions: true,
    });
    for (const value of res.values as Array<Record<string, unknown>>) {
      if (typeof value?.testCaseKey === 'string') latest.set(value.testCaseKey, value);
    }
    startAt += res.values.length;
    if (res.values.length === 0 || startAt >= res.total) break;
    if (page + 1 >= MAX_RESULT_PAGES) {
      truncated = true;
      break;
    }
  }
  return { latest, truncated };
}

export function registerRunMaintenanceTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'recreate_test_run_with_items',
    description:
      'Composite workaround for a hard API v1 limitation: a Zephyr Scale test run (test cycle) is IMMUTABLE after creation — ' +
      'there is no PUT /testrun, so a run cannot be renamed, moved to another folder, and test cases cannot be added or removed. ' +
      "This tool is the ONLY way to change a run's composition, name or folder: it reads the source run, builds a new items list " +
      '(kept source items in their original order, minus removeTestCaseKeys, plus addItems appended), creates a NEW run and returns ' +
      'its NEW key — references to the old key are not updated anywhere. Header fields not passed explicitly (name, folder, ' +
      "testPlanKey, issueLinks, iteration, version, owner, plannedStartDate, plannedEndDate, customFields) default to the source run's values. " +
      'With copyResults=true the LAST execution of each kept item is carried over as the initial result of the new run ' +
      '(status, comment, executedBy, executionTime, actual dates, per-step scriptResults, …); when the same test case is included ' +
      "as several items, each of them receives that case's latest execution while keeping its own environment/assignee. The source run is KEPT unless " +
      'deleteOriginal=true, and it is never deleted when creating the new run failed. ' +
      'Returns { key, originalKey, itemCount, copiedResults, deletedOriginal }.',
    inputSchema: {
      testRunKey: z.string().describe('Key of the SOURCE test run to recreate, e.g. PROJ-R123'),
      name: z.string().optional().describe("Name of the new run (defaults to the source run's name)"),
      folder: z
        .string()
        .optional()
        .describe(
          'Full path of a TEST_RUN folder starting with "/", e.g. "/Regression" (defaults to the source run\'s folder). The folder MUST already exist.',
        ),
      testPlanKey: z
        .string()
        .optional()
        .describe("Test plan to associate the new run with, e.g. PROJ-P123 (defaults to the source run's value)"),
      issueLinks: z
        .array(z.string())
        .optional()
        .describe('Jira issue keys to link, e.g. ["PROJ-123"] (defaults to the source run\'s links)'),
      iteration: z.string().optional().describe("Defaults to the source run's value"),
      version: z.string().optional().describe("Defaults to the source run's value"),
      owner: z.string().optional().describe(`Owner (defaults to the source run's value). ${USER_KEY_NOTE}`),
      plannedStartDate: z.string().optional().describe("ISO 8601 (defaults to the source run's value)"),
      plannedEndDate: z.string().optional().describe("ISO 8601 (defaults to the source run's value)"),
      customFields: customFieldsSchema.optional().describe("Custom field values keyed by field name (defaults to the source run's values)"),
      addItems: z
        .array(addItemSchema)
        .optional()
        .describe(
          'Extra items appended AFTER the kept source items. Each item requires testCaseKey and may carry full execution result fields ' +
            '(status, environment, executedBy, assignedTo, comment, executionTime, actualStartDate, actualEndDate, customFields, issueLinks, scriptResults).',
        ),
      removeTestCaseKeys: z
        .array(z.string())
        .optional()
        .describe('Source items whose test case key is in this list are DROPPED from the new run, e.g. ["PROJ-T5"]'),
      copyResults: z
        .boolean()
        .optional()
        .describe('When true, carry the LAST execution of each kept source item over as the initial result of the new run (default false)'),
      deleteOriginal: z
        .boolean()
        .optional()
        .describe(
          'When true, permanently DELETE the source run (with all its execution results) after the new run was created successfully ' +
            '(default false). The source run is NEVER deleted otherwise, and never when creating the new run failed.',
        ),
    },
    annotations: { destructiveHint: true },
    handler: async (args, { cfg }) => {
      const runPath = `/testrun/${encodeURIComponent(args.testRunKey)}`;
      const source = (await zephyrFetch(cfg, { method: 'GET', path: atm(runPath) })) as Record<string, unknown>;
      const sourceItems = (Array.isArray(source.items) ? source.items : []) as Array<Record<string, unknown>>;

      const remove = new Set(args.removeTestCaseKeys ?? []);
      const kept = sourceItems.filter(
        (item): item is Record<string, unknown> & { testCaseKey: string } =>
          typeof item.testCaseKey === 'string' && !remove.has(item.testCaseKey),
      );

      const { latest: latestResults, truncated: resultsTruncated } = args.copyResults
        ? await collectLatestResults(cfg, args.testRunKey)
        : { latest: new Map<string, Record<string, unknown>>(), truncated: false };

      let copiedResults = 0;
      const items: Array<Record<string, unknown>> = kept.map((item) => {
        // Items of GET /testrun carry read-only junk (ids, statuses, execution dates) — keep only the planning fields.
        const base = compact({
          testCaseKey: item.testCaseKey,
          environment: item.environment ?? undefined,
          assignedTo: item.assignedTo ?? undefined,
        });
        const result = latestResults.get(item.testCaseKey);
        if (!result) return base;
        copiedResults++;
        // Planning fields (base) win: when the same case is included as several items, each item
        // keeps its own environment/assignee while receiving the case's latest execution fields.
        return { ...copyableResultFields(result), ...base };
      });
      items.push(...(args.addItems ?? []).map((item) => compact(item)));

      const body = compact({
        projectKey: source.projectKey ?? args.testRunKey.split('-')[0],
        name: inherit(args.name, source.name),
        folder: inherit(args.folder, source.folder),
        testPlanKey: inherit(args.testPlanKey, source.testPlanKey),
        issueLinks: inherit(args.issueLinks, Array.isArray(source.issueLinks) ? source.issueLinks : undefined),
        iteration: inherit(args.iteration, source.iteration),
        version: inherit(args.version, source.version),
        owner: inherit(args.owner, source.owner),
        plannedStartDate: inherit(args.plannedStartDate, source.plannedStartDate),
        plannedEndDate: inherit(args.plannedEndDate, source.plannedEndDate),
        customFields: inherit(args.customFields, source.customFields),
        items,
      });
      const created = (await zephyrFetch(cfg, { method: 'POST', path: atm('/testrun'), body })) as { key: string };

      let deletedOriginal = false;
      if (args.deleteOriginal === true) {
        try {
          await zephyrFetch(cfg, { method: 'DELETE', path: atm(runPath) });
        } catch (err) {
          const note = `The new run ${created.key} WAS created successfully — only deleting the source run ${args.testRunKey} failed.`;
          const hinted = addHint(err, note);
          // addHint only decorates ZephyrApiError; never lose the new key for other error kinds.
          if (hinted !== err) throw hinted;
          throw new Error(`${err instanceof Error ? err.message : String(err)}\n${note}`);
        }
        deletedOriginal = true;
      }

      return compact({
        key: created.key,
        originalKey: args.testRunKey,
        itemCount: items.length,
        copiedResults,
        deletedOriginal,
        copyResultsNote: resultsTruncated
          ? `Result copying stopped after ${MAX_RESULT_PAGES * RESULTS_PAGE_SIZE} results — items beyond that limit were recreated without copied results.`
          : undefined,
      });
    },
  });

  // UNOFFICIAL internal-API tools below — registered only behind ZEPHYR_ALLOW_INTERNAL_API=true (§7.6).
  if (!cfg.allowInternalApi) return;

  defineTool(server, cfg, {
    name: 'get_folder_tree',
    description:
      'UNOFFICIAL: list the complete folder tree of a project (the public API v1 cannot list folders at all). ' +
      'Backed by the INTERNAL Zephyr Scale API /rest/tests/1.0 which the vendor does NOT support — it may change or be absent ' +
      'on any Jira/Zephyr Scale version, and errors from this tool usually mean the endpoint simply does not exist on this instance. ' +
      'The tool is available only because ZEPHYR_ALLOW_INTERNAL_API=true is set; the risks of using the internal API are on the user. ' +
      'Returns the raw folder tree response (nested folders with numeric ids, usable e.g. for rename_folder).',
    inputSchema: {
      projectKey: z.string().optional().describe('Jira project key; defaults to ZEPHYR_DEFAULT_PROJECT_KEY'),
      folderType: z
        .enum(['test_case', 'test_plan', 'test_run'])
        .optional()
        .describe('Which folder tree to read (default test_case)'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const projectKey = resolveProjectKey(cfg, args.projectKey);
      const project = (await zephyrFetch(cfg, {
        method: 'GET',
        path: `/rest/api/2/project/${encodeURIComponent(projectKey)}`,
      })) as Record<string, unknown>;
      const projectId = Number(project.id);
      if (!Number.isFinite(projectId)) {
        throw new Error(`Could not resolve the numeric id of project '${projectKey}' from Jira (got: ${JSON.stringify(project.id)})`);
      }
      try {
        return await zephyrFetch(cfg, {
          method: 'GET',
          path: `/rest/tests/1.0/project/${projectId}/foldertree/${FOLDER_TREE_SEGMENT[args.folderType ?? 'test_case']}`,
        });
      } catch (err) {
        throw addHint(
          err,
          'This tool uses the UNOFFICIAL internal API — an error here usually means the endpoint does not exist on this Zephyr Scale version.',
        );
      }
    },
  });
}
