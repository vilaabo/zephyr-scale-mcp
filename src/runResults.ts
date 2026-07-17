import type { Config } from './config.js';
import { atm, zephyrFetch, ZephyrApiError } from './http.js';

export interface RunResultsPage {
  total: number;
  values: unknown[];
  /** Present when the paginated endpoint is missing and the flat fallback was used. */
  note?: string;
}

export interface RunResultsQuery {
  startAt: number;
  maxResults: number;
  onlyLastExecutions?: boolean | undefined;
}

/**
 * Read one page of a test run's execution results via GET /testrun/{key}/testresults/page.
 * Older Zephyr Scale Server versions have no /page endpoint (404 for ANY run key) — in that
 * case the deprecated flat endpoint is read and paginated client-side. A run that genuinely
 * does not exist makes the flat call 404 too, so real errors still surface.
 */
/** Page size used when collecting all results of a run. */
export const COLLECT_PAGE_SIZE = 200;
/** Safety cap so an inconsistent `total` can never loop forever (200 * 50 = 10 000 results). */
export const COLLECT_MAX_PAGES = 50;

export interface CollectedRunResults {
  results: Array<Record<string, unknown>>;
  /** True when COLLECT_MAX_PAGES was hit before `total` was reached. */
  truncated: boolean;
  /** Present when the flat-endpoint fallback was used. */
  note?: string | undefined;
}

/** Collect ALL execution results of a run (paginating through fetchRunResultsPage). */
export async function collectRunResults(
  cfg: Config,
  testRunKey: string,
  onlyLastExecutions: boolean,
): Promise<CollectedRunResults> {
  const results: Array<Record<string, unknown>> = [];
  let startAt = 0;
  let truncated = false;
  let note: string | undefined;
  for (let page = 0; ; page++) {
    const res = await fetchRunResultsPage(cfg, testRunKey, { startAt, maxResults: COLLECT_PAGE_SIZE, onlyLastExecutions });
    results.push(...(res.values as Array<Record<string, unknown>>));
    note ??= res.note;
    startAt += res.values.length;
    if (res.values.length === 0 || startAt >= res.total) break;
    if (page + 1 >= COLLECT_MAX_PAGES) {
      truncated = true;
      break;
    }
  }
  return { results, truncated, note };
}

export async function fetchRunResultsPage(cfg: Config, testRunKey: string, query: RunResultsQuery): Promise<RunResultsPage> {
  const runPath = `/testrun/${encodeURIComponent(testRunKey)}`;
  try {
    const res = (await zephyrFetch(cfg, {
      method: 'GET',
      path: atm(`${runPath}/testresults/page`),
      query: { startAt: query.startAt, maxResults: query.maxResults, onlyLastExecutions: query.onlyLastExecutions },
    })) as { total: number; values?: unknown[] };
    return { total: res.total, values: res.values ?? [] };
  } catch (err) {
    if (!(err instanceof ZephyrApiError) || err.status !== 404) throw err;
    const flat = await zephyrFetch(cfg, { method: 'GET', path: atm(`${runPath}/testresults`) });
    if (!Array.isArray(flat)) throw err;
    let all = flat as Array<Record<string, unknown>>;
    if (query.onlyLastExecutions) {
      // Best-effort emulation: keep the newest (highest id) execution per test case.
      const latest = new Map<unknown, Record<string, unknown>>();
      for (const r of all) {
        const prev = latest.get(r.testCaseKey);
        if (!prev || Number(r.id ?? 0) >= Number(prev.id ?? 0)) latest.set(r.testCaseKey, r);
      }
      all = [...latest.values()];
    }
    return {
      total: all.length,
      values: all.slice(query.startAt, query.startAt + query.maxResults),
      note: 'The paginated /testresults/page endpoint is unavailable on this Zephyr Scale version; results were read from the deprecated flat endpoint and paginated client-side.',
    };
  }
}
