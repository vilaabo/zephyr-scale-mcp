import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import { registerTestCaseTools } from './testCases.js';
import { registerFolderTools } from './folders.js';
import { registerTestRunTools } from './testRuns.js';
import { registerTestResultTools } from './testResults.js';
import { registerMiscTools } from './misc.js';
import { registerTestPlanTools } from './testPlans.js';
import { registerAttachmentTools } from './attachments.js';
import { registerAutomationTools } from './automation.js';
import { registerRunMaintenanceTools } from './runMaintenance.js';

export function registerAllTools(server: McpServer, cfg: Config): void {
  registerTestCaseTools(server, cfg);
  registerFolderTools(server, cfg);
  registerTestRunTools(server, cfg);
  registerTestResultTools(server, cfg);
  registerTestPlanTools(server, cfg);
  registerAttachmentTools(server, cfg);
  registerAutomationTools(server, cfg);
  registerRunMaintenanceTools(server, cfg);
  registerMiscTools(server, cfg);
}
