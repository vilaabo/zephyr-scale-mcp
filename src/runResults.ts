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
