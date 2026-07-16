import type { Config } from './config.js';
import { log } from './log.js';

/** Base path of the Zephyr Scale Server/DC REST API v1. */
export const ATM_BASE = '/rest/atm/1.0';

/** Prefix a path with the Zephyr Scale API base: atm('/testcase') -> '/rest/atm/1.0/testcase'. */
export const atm = (path: string): string => `${ATM_BASE}${path}`;

const MAX_ERROR_BODY_BYTES = 2048;
const MAX_RETRY_AFTER_MS = 60_000;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ZephyrFetchOptions {
  method: HttpMethod;
  /** Absolute path starting with /rest/..., without the base URL. */
  path: string;
  /** Query parameters; entries with undefined values are omitted. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body; omitted entirely when undefined. */
  body?: unknown;
}

export class ZephyrApiError extends Error {
  override name = 'ZephyrApiError';
  readonly hint: string | undefined;

  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly responseBody: string,
    hint?: string,
    /** True when the response was an HTML page instead of JSON (e.g. Jira served a generic 404 page). */
    readonly htmlBody: boolean = false,
  ) {
    // Per spec: method and path (no query string — it may contain sensitive data), body cut to 2 KB.
    super(`Zephyr API error ${status} (${method} ${path}): ${responseBody}${hint ? `\nHint: ${hint}` : ''}`);
    this.hint = hint;
  }
}

/** Append a tool-specific hint to an API error; other error kinds pass through unchanged. */
export function addHint(err: unknown, extra: string): unknown {
  if (err instanceof ZephyrApiError) {
    return new ZephyrApiError(
      err.status,
      err.method,
      err.path,
      err.responseBody,
      err.hint ? `${err.hint}\n${extra}` : extra,
      err.htmlBody,
    );
  }
  return err;
}

export class NetworkError extends Error {
  override name = 'NetworkError';
}

function authHeader(cfg: Config): string {
  if (cfg.auth === 'basic') {
    return `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
  }
  return `Bearer ${cfg.pat}`;
}

function truncate(text: string, max = MAX_ERROR_BODY_BYTES): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

function buildHint(status: number, path: string, body: string, looksLikeHtml: boolean): string | undefined {
  switch (status) {
    case 400: {
      if (/folder/i.test(body) && /(exist|found|invalid)/i.test(body)) {
        return 'Folders are not created automatically — create the folder first with create_folder (full path from the root, e.g. "/Regression/Payments").';
      }
      if (/status|priority/i.test(body)) {
        return 'Status/priority values are case-sensitive internal (non-localized) names; check how they are configured for this project.';
      }
      if (/query|tql/i.test(body) || /\/search$/.test(path)) {
        return 'TQL syntax is strict: spaces around operators are mandatory, string values go in double quotes, and only AND is supported as the logical operator.';
      }
      return undefined;
    }
    case 401:
      return 'Authentication failed — check JIRA_PAT (or JIRA_USERNAME/JIRA_PASSWORD) and that the token is not expired or revoked.';
    case 403:
      return 'Missing permission — the response body may name the required Zephyr Scale permission (e.g. CREATE_TEST_CASE). Check the Zephyr permission scheme of the project.';
    case 404:
      if (looksLikeHtml && path.startsWith(ATM_BASE)) {
        return `Received an HTML page instead of JSON — the Zephyr Scale plugin is probably not reachable at ${ATM_BASE}. Check that the plugin is installed/licensed and JIRA_BASE_URL is correct.`;
      }
      return 'Entity not found — check the key/id (test case: PROJ-T1, test plan: PROJ-P1, test run: PROJ-R1).';
    default:
      return undefined;
  }
}

function retryDelayMs(attempt: number, retryAfter: string | null, baseMs: number): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
  }
  return baseMs * 2 ** attempt + Math.floor(Math.random() * 100);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function toApiError(res: Response, opts: ZephyrFetchOptions): Promise<ZephyrApiError> {
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    // keep empty body
  }
  const contentType = res.headers.get('content-type') ?? '';
  const looksLikeHtml = contentType.includes('html') || /^\s*</.test(bodyText);
  const body = truncate(bodyText.trim()) || res.statusText || '(empty response body)';
  return new ZephyrApiError(res.status, opts.method, opts.path, body, buildHint(res.status, opts.path, bodyText, looksLikeHtml), looksLikeHtml);
}

async function parseSuccess(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return {};
  const text = await res.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Perform an HTTP request against Jira / Zephyr Scale.
 *
 * Retry policy (per spec §9): 429/503 are retried for any method honoring Retry-After;
 * other 5xx, network errors and timeouts are retried for GET only, with exponential
 * backoff (retryBaseDelayMs * 2^n + jitter), at most cfg.maxRetries retries.
 */
export async function zephyrFetch(cfg: Config, opts: ZephyrFetchOptions): Promise<unknown> {
  const url = new URL(cfg.baseUrl + opts.path);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const maxAttempts = cfg.maxRetries + 1;
  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt >= maxAttempts - 1;
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method,
        headers: {
          Authorization: authHeader(cfg),
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (cause) {
      const reason =
        cause instanceof Error && cause.name === 'TimeoutError'
          ? `timed out after ${cfg.timeoutMs} ms`
          : cause instanceof Error
            ? `${cause.message}${cause.cause instanceof Error ? ` (${cause.cause.message})` : ''}`
            : String(cause);
      if (opts.method === 'GET' && !isLastAttempt) {
        log('debug', `retrying ${opts.method} ${opts.path} after network error: ${reason}`);
        await sleep(retryDelayMs(attempt, null, cfg.retryBaseDelayMs));
        continue;
      }
      throw new NetworkError(`Network error (${opts.method} ${opts.path}): ${reason}`);
    }

    if (res.ok) return parseSuccess(res);

    const retryable = res.status === 429 || res.status === 503 || (opts.method === 'GET' && res.status >= 500);
    if (retryable && !isLastAttempt) {
      await res.text().catch(() => undefined); // drain the body so the connection can be reused
      log('debug', `retrying ${opts.method} ${opts.path} after HTTP ${res.status}`);
      await sleep(retryDelayMs(attempt, res.headers.get('retry-after'), cfg.retryBaseDelayMs));
      continue;
    }
    throw await toApiError(res, opts);
  }
}
