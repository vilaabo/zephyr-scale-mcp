import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { atm, zephyrFetch } from '../http.js';
import { defineTool, resolveProjectKey, ToolInputError } from '../toolkit.js';

interface UploadArgs {
  projectKey?: string | undefined;
  filePath: string;
  autoCreateTestCases?: boolean | undefined;
}

/** Input shape shared by both automation upload tools (§7.6). */
const uploadInputSchema = {
  projectKey: z.string().optional().describe('Jira project key; defaults to ZEPHYR_DEFAULT_PROJECT_KEY'),
  filePath: z
    .string()
    .describe('Path to the results .zip archive on the machine running this MCP server (absolute path recommended)'),
  autoCreateTestCases: z
    .boolean()
    .optional()
    .describe(
      'When true, the server automatically creates test cases that are referenced in the results but do not exist in the project yet. Omitted from the request when not passed (server default: false).',
    ),
};

async function readResultsZip(filePath: string): Promise<Buffer> {
  try {
    return await readFile(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ToolInputError(`Cannot read the results ZIP at '${filePath}': ${reason}`);
  }
}

/** POST the ZIP as multipart/form-data (field 'file') to an automation execution endpoint. */
async function uploadResultsArchive(cfg: Config, endpoint: string, args: UploadArgs): Promise<unknown> {
  const projectKey = resolveProjectKey(cfg, args.projectKey);
  const buf = await readResultsZip(args.filePath);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buf)]), basename(args.filePath));
  const data = await zephyrFetch(cfg, {
    method: 'POST',
    path: atm(`${endpoint}/${encodeURIComponent(projectKey)}`),
    query: { autoCreateTestCases: args.autoCreateTestCases },
    form,
  });
  // The API usually answers with a description of the created test cycle — pass it through.
  if (data === null || data === undefined) return { uploaded: true };
  if (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0) return { uploaded: true };
  return data;
}

export function registerAutomationTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'upload_automation_results',
    description:
      'Publish automated test execution results to Zephyr Scale by uploading a ZIP archive. The archive must contain result files in the Zephyr Scale custom results format (JSON files listing executed test cases with their statuses, script results, etc.). The server processes the archive and creates a new test cycle (test run) holding the results; the API response describing that cycle is returned as-is. Pass autoCreateTestCases=true to let the server create test cases that appear in the results but do not exist in the project yet. filePath must point to a .zip file readable on the machine where this MCP server runs.',
    inputSchema: uploadInputSchema,
    annotations: {},
    handler: async (args, { cfg }) => uploadResultsArchive(cfg, '/automation/execution', args),
  });

  defineTool(server, cfg, {
    name: 'upload_cucumber_results',
    description:
      "Publish Cucumber test execution results to Zephyr Scale by uploading a ZIP archive. The archive must contain Cucumber JSON report files (the output of Cucumber's built-in json formatter); scenario names/tags are matched to BDD test cases. The server processes the archive and creates a new test cycle (test run) holding the results; the API response describing that cycle is returned as-is. Pass autoCreateTestCases=true to let the server create test cases that appear in the results but do not exist in the project yet. filePath must point to a .zip file readable on the machine where this MCP server runs.",
    inputSchema: uploadInputSchema,
    annotations: {},
    handler: async (args, { cfg }) => uploadResultsArchive(cfg, '/automation/execution/cucumber', args),
  });

  defineTool(server, cfg, {
    name: 'download_feature_files',
    description:
      'Export BDD test cases from Zephyr Scale as Gherkin .feature files. The server returns a ZIP archive containing one .feature file per exported BDD test case; the archive is written to outputPath on the machine running this MCP server (the parent directory must already exist). Use the optional TQL query to select which test cases to export, e.g. \'testCase.projectKey = "PROJ"\'; when omitted the server exports per its defaults. Returns { savedTo, bytes }. Does not modify anything in Zephyr Scale, but writes a local file.',
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe('TQL query selecting the BDD test cases to export, e.g. \'testCase.projectKey = "PROJ"\''),
      outputPath: z
        .string()
        .describe('Local path where the ZIP archive is written (the parent directory must exist)'),
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      const buf = (await zephyrFetch(cfg, {
        method: 'GET',
        path: atm('/automation/testcases'),
        query: { query: args.query },
        binaryResponse: true,
      })) as Buffer;
      await writeFile(args.outputPath, buf);
      return { savedTo: args.outputPath, bytes: buf.length };
    },
  });
}
