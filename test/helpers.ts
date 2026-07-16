import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Config } from '../src/config.js';
import { registerAllTools } from '../src/tools/index.js';

/** Base URL that msw handlers should intercept. */
export const BASE_URL = 'http://jira.test';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: BASE_URL,
    auth: 'pat',
    pat: 'test-secret-token',
    timeoutMs: 5000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    tlsRejectUnauthorized: true,
    readonly: false,
    allowInternalApi: false,
    logLevel: 'error',
    ...overrides,
  };
}

export interface CallOutcome {
  isError: boolean;
  text: string;
  /** Parsed JSON payload, or undefined when the text is not JSON (e.g. error messages). */
  json: any;
}

export interface TestClient {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<CallOutcome>;
  close(): Promise<void>;
}

/** Spin up the real MCP server in-memory and return a connected client. */
export async function createTestClient(overrides: Partial<Config> = {}): Promise<TestClient> {
  const server = new McpServer({ name: 'zephyr-scale-mcp-test', version: '0.0.0' });
  registerAllTools(server, testConfig(overrides));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    async call(name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      const content = res.content as Array<{ type: string; text?: string }> | undefined;
      const text = content?.[0]?.text ?? '';
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { isError: res.isError === true, text, json };
    },
    async close() {
      await client.close();
    },
  };
}
