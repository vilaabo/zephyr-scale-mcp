import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';

// Implemented in phase 3 (§7.6 of the spec): recreate_test_run_with_items and
// UNOFFICIAL internal-API tools (registered only when ZEPHYR_ALLOW_INTERNAL_API=true).
export function registerRunMaintenanceTools(_server: McpServer, _cfg: Config): void {}
