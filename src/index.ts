#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { log, setLogLevel } from './log.js';
import { registerAllTools } from './tools/index.js';

const SERVER_NAME = 'zephyr-scale-mcp';
const SERVER_VERSION = '0.1.0';

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(`[${SERVER_NAME}] Configuration error:\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  setLogLevel(cfg.logLevel);

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerAllTools(server, cfg);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(
    'info',
    `started (stdio); Jira: ${cfg.baseUrl}, auth: ${cfg.auth}${cfg.defaultProjectKey ? `, default project: ${cfg.defaultProjectKey}` : ''}${cfg.readonly ? ', READ-ONLY mode' : ''}`,
  );
}

main().catch((err) => {
  process.stderr.write(`[${SERVER_NAME}] Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
