import { z } from 'zod';

/** Custom field values keyed by the custom field name as configured on the instance. */
export const customFieldsSchema = z.record(z.unknown());

export const stepSchema = z
  .object({
    id: z
      .number()
      .int()
      .optional()
      .describe(
        'Existing step id (returned by get_test_case). On update, steps with an id are updated, steps without an id are created, and existing steps missing from the list are DELETED.',
      ),
    description: z.string().optional().describe('Step action (HTML allowed)'),
    testData: z.string().optional().describe('Test data for the step (HTML allowed)'),
    expectedResult: z.string().optional().describe('Expected result of the step (HTML allowed)'),
    testCaseKey: z
      .string()
      .optional()
      .describe('Key of another test case to invoke as this step ("Call to Test"), e.g. PROJ-T45'),
  })
  .strict();

/** Step shape for creation flows where ids must not be supplied. */
export const newStepSchema = stepSchema.omit({ id: true }).strict();

export type Step = z.infer<typeof stepSchema>;

export const testScriptTypeSchema = z.enum(['STEP_BY_STEP', 'PLAIN_TEXT', 'BDD']);

function validateScriptShape(
  val: { type: 'STEP_BY_STEP' | 'PLAIN_TEXT' | 'BDD'; text?: string | undefined; steps?: unknown[] | undefined },
  ctx: z.RefinementCtx,
): void {
  if (val.type === 'STEP_BY_STEP') {
    if (!val.steps) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'testScript.steps is required when type is STEP_BY_STEP' });
    }
    if (val.text !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'testScript.text is not allowed when type is STEP_BY_STEP' });
    }
  } else {
    if (val.text === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `testScript.text is required when type is ${val.type}` });
    }
    if (val.steps !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `testScript.steps is not allowed when type is ${val.type}` });
    }
  }
}

export const testScriptSchema = z
  .object({
    type: testScriptTypeSchema.describe('Script format'),
    text: z.string().optional().describe('Script body for PLAIN_TEXT, or the full Gherkin document for BDD'),
    steps: z.array(stepSchema).optional().describe('Steps for STEP_BY_STEP'),
  })
  .strict()
  .superRefine(validateScriptShape);

export const parametersSchema = z
  .object({
    variables: z.array(
      z.union([
        z.object({ name: z.string(), type: z.literal('FREE_TEXT') }).strict(),
        z.object({ name: z.string(), type: z.literal('DATA_SET'), dataSet: z.string() }).strict(),
      ]),
    ),
    entries: z
      .array(z.record(z.string()))
      .describe('Each entry maps variable names to values; unknown data sets / values are created automatically'),
  })
  .strict();

export const scriptResultSchema = z
  .object({
    index: z.number().int().min(0).describe('0-based index of the step'),
    status: z.string().describe('Step execution status (case-sensitive)'),
    comment: z.string().optional(),
  })
  .strict();

export const RESULT_STATUS_NOTE =
  "Default statuses: 'Not Executed', 'In Progress', 'Pass', 'Fail', 'Blocked' — case-sensitive internal names; instances may define custom ones.";

export const USER_KEY_NOTE =
  "Jira *user key* (e.g. 'JIRAUSER10000'), NOT a username or e-mail — resolve it with find_jira_user.";

/**
 * Common fields of a test execution result (§7.4), shared by test run items and result tools.
 * Deprecated API fields are intentionally not exposed: issueKey -> issueLinks,
 * executionDate -> actualEndDate, userKey -> executedBy.
 */
export const testResultFieldsShape = {
  status: z.string().optional().describe(`Execution status. ${RESULT_STATUS_NOTE}`),
  environment: z.string().optional().describe('Environment name as configured in the project (case-sensitive), e.g. "Chrome"'),
  comment: z.string().optional().describe('Comment (HTML allowed)'),
  assignedTo: z.string().optional().describe(`Assignee. ${USER_KEY_NOTE}`),
  executedBy: z.string().optional().describe(`Executor. ${USER_KEY_NOTE}`),
  executionTime: z.number().int().optional().describe('Execution duration in milliseconds'),
  actualStartDate: z.string().optional().describe('ISO 8601, e.g. 2026-07-20T14:00:00Z'),
  actualEndDate: z.string().optional().describe('ISO 8601'),
  iteration: z.string().optional(),
  version: z.string().optional(),
  customFields: customFieldsSchema.optional().describe('Custom field values keyed by field name'),
  issueLinks: z.array(z.string()).optional().describe('Jira issue keys to link, e.g. ["PROJ-123"]'),
  scriptResults: z.array(scriptResultSchema).optional().describe('Per-step results (STEP_BY_STEP scripts)'),
};

/**
 * Fields shared by create_test_case / update_test_case / bulk items (§7.1).
 * `name` is required on create; update tools relax it via .partial() equivalents.
 */
export const testCaseFieldsShape = {
  name: z.string().describe('Test case name'),
  objective: z.string().optional().describe('Objective (HTML allowed)'),
  precondition: z.string().optional().describe('Precondition (HTML allowed)'),
  folder: z
    .string()
    .optional()
    .describe('Full folder path from the root starting with "/", e.g. "/Regression/Payments". The folder MUST already exist (create it with create_folder).'),
  status: z
    .string()
    .optional()
    .describe("Test case status. Defaults: 'Draft', 'Approved', 'Deprecated' — case-sensitive; instances may define custom ones."),
  priority: z
    .string()
    .optional()
    .describe("Priority. Defaults: 'High', 'Normal', 'Low' — case-sensitive; instances may define custom ones."),
  component: z.string().optional().describe('Name of a Jira component of the project'),
  owner: z.string().optional().describe(`Owner. ${USER_KEY_NOTE}`),
  estimatedTime: z.number().int().optional().describe('Estimated duration in milliseconds'),
  labels: z.array(z.string()).optional().describe('Labels; the API replaces spaces with underscores'),
  issueLinks: z.array(z.string()).optional().describe('Jira issue keys to link, e.g. ["PROJ-123"]'),
  customFields: customFieldsSchema.optional().describe('Custom field values keyed by field name'),
  parameters: parametersSchema
    .optional()
    .describe('Test case parameters: { variables: [{name, type: FREE_TEXT | DATA_SET, dataSet?}], entries: [{<variable>: <value>}] }'),
  testScript: testScriptSchema
    .optional()
    .describe(
      'Test script. STEP_BY_STEP: {type, steps: [{description?, testData?, expectedResult?, testCaseKey?}]}; PLAIN_TEXT/BDD: {type, text}.',
    ),
};

export const startAtSchema = z.number().int().min(0).optional().describe('0-based index of the first result to return (default 0)');
export const maxResultsSchema = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('Maximum number of results to return (default 50; the API server-side default is 200)');

export const TQL_CHEATSHEET = `TQL quick reference:
- Test case fields: projectKey, key, name, status, priority, component, folder, estimatedTime, labels, owner, issueKeys + custom fields (field name in double quotes).
- Test run (cycle) fields: ONLY projectKey and folder.
- Operators: =, >, >=, <, <=, IN; the only logical connector is AND (no OR).
- Syntax is strict: spaces around operators are mandatory, string values in double quotes. Folder paths start with "/" ("/" is the root). For single/multi-choice custom fields '=' does not work — use IN.
- Examples:
  projectKey = "PROJ" AND status = "Draft" AND priority = "High"
  projectKey = "PROJ" AND folder = "/Regression/Payments"
  projectKey = "PROJ" AND labels IN ("smoke", "ui")
  projectKey = "PROJ" AND "My Field" IN ("Value")
  key IN ("PROJ-T50", "PROJ-T90")
  projectKey = "PROJ" AND issueKeys IN ("PROJ-5")`;
