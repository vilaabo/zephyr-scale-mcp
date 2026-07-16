import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import type { Config } from './config.js';
import { NetworkError, ZephyrApiError } from './http.js';
import { log } from './log.js';

export interface ToolContext {
  cfg: Config;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface ToolSpec<S extends ZodRawShape> {
  name: string;
  /** English description targeted at LLM clients. */
  description: string;
  inputSchema: S;
  annotations?: ToolAnnotations;
  handler: (args: z.output<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}

/** Thrown by tools for invalid input detected before any HTTP call. */
export class ToolInputError extends Error {
  override name = 'ToolInputError';
}

interface TextResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function textResult(text: string, isError = false): TextResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

/** Defensive scrubbing: secrets must never appear in tool output or error texts. */
function scrubSecrets(cfg: Config, text: string): string {
  let out = text;
  for (const secret of [cfg.pat, cfg.password]) {
    if (secret && secret.length > 0) out = out.split(secret).join('***');
  }
  return out;
}

function errorText(err: unknown): string {
  if (err instanceof ZephyrApiError || err instanceof NetworkError || err instanceof ToolInputError) {
    return err.message;
  }
  if (err instanceof z.ZodError) {
    return `Invalid arguments:\n${err.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Register a tool on the MCP server: strict zod input schema, read-only mode guard,
 * pretty-printed JSON success payloads and normalized `isError` failures.
 */
export function defineTool<S extends ZodRawShape>(server: McpServer, cfg: Config, spec: ToolSpec<S>): void {
  const schema = z.object(spec.inputSchema).strict();
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: schema,
      annotations: { ...spec.annotations },
    },
    async (args: z.output<typeof schema>) => {
      if (cfg.readonly && !spec.annotations?.readOnlyHint) {
        return textResult(`Server is in read-only mode (ZEPHYR_READONLY=true) — '${spec.name}' performs writes and is disabled.`, true);
      }
      try {
        const data = await spec.handler(args, { cfg });
        return textResult(scrubSecrets(cfg, JSON.stringify(data ?? null, null, 2)));
      } catch (err) {
        // §5: secrets must never reach logs either — scrub before logging, same as for the client.
        log('debug', scrubSecrets(cfg, `tool ${spec.name} failed: ${err instanceof Error ? err.message : String(err)}`));
        return textResult(scrubSecrets(cfg, errorText(err)), true);
      }
    },
  );
}

/** Resolve the effective project key: explicit argument or ZEPHYR_DEFAULT_PROJECT_KEY. */
export function resolveProjectKey(cfg: Config, projectKey: string | undefined): string {
  const key = projectKey ?? cfg.defaultProjectKey;
  if (!key) {
    throw new ToolInputError('projectKey is required (and no ZEPHYR_DEFAULT_PROJECT_KEY is configured).');
  }
  return key;
}

/** Drop undefined values so optional params never reach the request body (§6.7). */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

/** UI link for a test case, per spec §6.3. */
export function testCaseWebUrl(cfg: Config, key: string): string {
  return `${cfg.baseUrl}/secure/Tests.jspa#/testCase/${key}`;
}

/** Standard envelope for search tools (§6.5). */
export function pageEnvelope(startAt: number, maxResults: number, values: unknown[]): {
  startAt: number;
  maxResults: number;
  count: number;
  isLast: boolean;
  values: unknown[];
} {
  return { startAt, maxResults, count: values.length, isLast: values.length < maxResults, values };
}

/** Serialize a `fields` array to the comma-separated form the API expects. */
export function fieldsParam(fields: string[] | undefined): string | undefined {
  return fields && fields.length > 0 ? fields.join(',') : undefined;
}
