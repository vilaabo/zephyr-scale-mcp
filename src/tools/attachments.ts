import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import { atm, zephyrFetch } from '../http.js';
import { defineTool, ToolInputError } from '../toolkit.js';

const ADDRESSING_NOTE =
  "Addressing: target 'test_case' requires testCaseKey (stepIndex optional to address a specific step); " +
  "target 'test_run' requires testRunKey (no step addressing — the API has no per-step endpoint for runs); " +
  "target 'test_result' requires testResultId (stepIndex optional). " +
  'Pass ONLY the identifier that matches the chosen target.';

/** Input fields shared by upload_attachment and list_attachments (§7.6). */
const addressingShape = {
  target: z
    .enum(['test_case', 'test_run', 'test_result'])
    .describe('Kind of entity the attachment belongs to: test_case, test_run or test_result'),
  testCaseKey: z.string().optional().describe("Test case key, e.g. PROJ-T123 — required when target is 'test_case'"),
  testRunKey: z.string().optional().describe("Test run (cycle) key, e.g. PROJ-R123 — required when target is 'test_run'"),
  testResultId: z
    .number()
    .int()
    .optional()
    .describe(
      "Numeric test result id — required when target is 'test_result'. " +
        'Result ids are returned by create_test_result / update_last_test_result / get_test_run_results.',
    ),
  stepIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("0-based step index to address a single step instead of the whole entity (targets 'test_case' and 'test_result' only)"),
};

type Addressing = {
  target: 'test_case' | 'test_run' | 'test_result';
  testCaseKey?: string | undefined;
  testRunKey?: string | undefined;
  testResultId?: number | undefined;
  stepIndex?: number | undefined;
};

function rejectForeignIds(target: string, foreign: Array<[name: string, value: unknown]>): void {
  for (const [name, value] of foreign) {
    if (value !== undefined) {
      throw new ToolInputError(`${name} is not allowed when target is '${target}' — pass only the identifier matching the target.`);
    }
  }
}

/** Resolve the addressed attachments endpoint, validating the target/identifier combination before any I/O. */
function attachmentsPath(args: Addressing): string {
  const step = args.stepIndex !== undefined ? `/step/${args.stepIndex}` : '';
  switch (args.target) {
    case 'test_case': {
      if (args.testCaseKey === undefined) throw new ToolInputError("testCaseKey is required when target is 'test_case'.");
      rejectForeignIds('test_case', [['testRunKey', args.testRunKey], ['testResultId', args.testResultId]]);
      return atm(`/testcase/${encodeURIComponent(args.testCaseKey)}${step}/attachments`);
    }
    case 'test_run': {
      if (args.testRunKey === undefined) throw new ToolInputError("testRunKey is required when target is 'test_run'.");
      rejectForeignIds('test_run', [['testCaseKey', args.testCaseKey], ['testResultId', args.testResultId]]);
      if (args.stepIndex !== undefined) {
        throw new ToolInputError(
          "stepIndex is not supported when target is 'test_run' — the API has no per-step attachments endpoint for test runs. " +
            "To attach to a step of an execution, use target 'test_result' with the result id.",
        );
      }
      return atm(`/testrun/${encodeURIComponent(args.testRunKey)}/attachments`);
    }
    case 'test_result': {
      if (args.testResultId === undefined) throw new ToolInputError("testResultId is required when target is 'test_result'.");
      rejectForeignIds('test_result', [['testCaseKey', args.testCaseKey], ['testRunKey', args.testRunKey]]);
      return atm(`/testresult/${encodeURIComponent(String(args.testResultId))}${step}/attachments`);
    }
  }
}

export function registerAttachmentTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'upload_attachment',
    description:
      'Upload a file as an attachment to a Zephyr Scale test case, test run (cycle) or test result — optionally to a single step ' +
      '(POST multipart/form-data to /testcase/{key}[/step/{i}]/attachments, /testrun/{key}/attachments or /testresult/{id}[/step/{i}]/attachments). ' +
      `${ADDRESSING_NOTE} ` +
      'filePath must be an absolute path of a file ON THE MACHINE RUNNING THIS MCP SERVER (the file is read from local disk). ' +
      'Returns the attachment metadata reported by the API, or { uploaded, fileName, size } when the API responds with an empty body.',
    inputSchema: {
      ...addressingShape,
      filePath: z.string().describe('Absolute path of the file to upload on the machine running this MCP server'),
      fileName: z.string().optional().describe('File name to store in Zephyr Scale; defaults to the basename of filePath'),
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      const path = attachmentsPath(args); // validate addressing before touching the disk
      const fileName = args.fileName ?? basename(args.filePath);
      let buf: Buffer;
      try {
        buf = await readFile(args.filePath);
      } catch (err) {
        throw new ToolInputError(
          `Cannot read file '${args.filePath}': ${err instanceof Error ? err.message : String(err)}. ` +
            'filePath must be an absolute path readable on the machine running this MCP server.',
        );
      }
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(buf)]), fileName);
      const res = await zephyrFetch(cfg, { method: 'POST', path, form });
      if (res !== null && typeof res === 'object' && Object.keys(res).length === 0) {
        return { uploaded: true, fileName, size: buf.length };
      }
      return res;
    },
  });

  defineTool(server, cfg, {
    name: 'list_attachments',
    description:
      'List the attachments of a Zephyr Scale test case, test run (cycle) or test result — optionally of a single step ' +
      '(GET /testcase/{key}[/step/{i}]/attachments, /testrun/{key}/attachments or /testresult/{id}[/step/{i}]/attachments). ' +
      `${ADDRESSING_NOTE} ` +
      'Returns the attachment list as reported by the API; the numeric ids can be passed to delete_attachment.',
    inputSchema: { ...addressingShape },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => zephyrFetch(cfg, { method: 'GET', path: attachmentsPath(args) }),
  });

  defineTool(server, cfg, {
    name: 'delete_attachment',
    description:
      'Permanently delete a Zephyr Scale attachment by its numeric id (DELETE /attachments/{id}). This cannot be undone. ' +
      'Attachment ids come from list_attachments or from upload_attachment responses. Returns { deleted: true, id }.',
    inputSchema: {
      attachmentId: z.number().int().describe('Numeric attachment id (from list_attachments or an upload response)'),
    },
    annotations: { destructiveHint: true },
    handler: async (args, { cfg }) => {
      await zephyrFetch(cfg, { method: 'DELETE', path: atm(`/attachments/${encodeURIComponent(String(args.attachmentId))}`) });
      return { deleted: true, id: args.attachmentId };
    },
  });
}
