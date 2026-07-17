/**
 * Negative contract tests (spec §12: "позитив/негатив на каждый инструмент") for the tools
 * whose module test files only exercise API error paths partially: the API answers with an
 * error and the tool must surface isError=true with the normalized message, never a success
 * envelope.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, createTestClient, type TestClient } from './helpers.js';

const mock = setupServer();

beforeAll(() => mock.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

const error404 = () => HttpResponse.json({ errorMessages: ['No test case has been found with the given key.'] }, { status: 404 });

async function withClient(fn: (t: TestClient) => Promise<void>): Promise<void> {
  const t = await createTestClient();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

describe('test case tools: API error propagation', () => {
  it('get_test_case surfaces a 404 with method and path', async () => {
    mock.use(http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T404`, error404));
    await withClient(async (t) => {
      const res = await t.call('get_test_case', { testCaseKey: 'PROJ-T404' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Zephyr API error 404 (GET /rest/atm/1.0/testcase/PROJ-T404)');
    });
  });

  it('search_test_cases surfaces a 400 with the TQL syntax hint', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/search`, () =>
        HttpResponse.json({ errorMessages: ['Invalid TQL query'] }, { status: 400 }),
      ),
    );
    await withClient(async (t) => {
      const res = await t.call('search_test_cases', { query: 'name ~ "oops"' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Zephyr API error 400 (GET /rest/atm/1.0/testcase/search)');
      expect(res.text).toMatch(/TQL/);
    });
  });

  it('update_test_case surfaces a 400 and never returns the success envelope', async () => {
    mock.use(
      http.put(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1`, () =>
        HttpResponse.json({ errorMessages: ['Test case status Draftt does not exist'] }, { status: 400 }),
      ),
    );
    await withClient(async (t) => {
      const res = await t.call('update_test_case', { testCaseKey: 'PROJ-T1', status: 'Draftt' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Zephyr API error 400 (PUT /rest/atm/1.0/testcase/PROJ-T1)');
      expect(res.text).not.toContain('"url"');
    });
  });

  it('delete_test_case surfaces a 404', async () => {
    mock.use(http.delete(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T404`, error404));
    await withClient(async (t) => {
      const res = await t.call('delete_test_case', { testCaseKey: 'PROJ-T404' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Zephyr API error 404 (DELETE /rest/atm/1.0/testcase/PROJ-T404)');
      expect(res.text).not.toContain('"deleted"');
    });
  });

  it('get_test_cases_linked_to_issue surfaces a 404', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/issuelink/PROJ-9999/testcases`, () =>
        HttpResponse.json({ errorMessages: ['Issue was not found'] }, { status: 404 }),
      ),
    );
    await withClient(async (t) => {
      const res = await t.call('get_test_cases_linked_to_issue', { issueKey: 'PROJ-9999' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Zephyr API error 404 (GET /rest/atm/1.0/issuelink/PROJ-9999/testcases)');
    });
  });
});

describe('test run tools: API error propagation', () => {
  it('create_test_run passes through a 400 with the folder hint', async () => {
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testrun`, () =>
        HttpResponse.json({ errorMessages: ['Folder /Nope does not exist'] }, { status: 400 }),
      ),
    );
    await withClient(async (t) => {
      const res = await t.call('create_test_run', { projectKey: 'PROJ', name: 'Run', folder: '/Nope' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Folder /Nope does not exist');
      expect(res.text).toContain('create_folder');
    });
  });

  it('get_test_run surfaces a 404', async () => {
    mock.use(http.get(`${BASE_URL}/rest/atm/1.0/testrun/PROJ-R404`, error404));
    await withClient(async (t) => {
      const res = await t.call('get_test_run', { testRunKey: 'PROJ-R404' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Zephyr API error 404 (GET /rest/atm/1.0/testrun/PROJ-R404)');
    });
  });

  it('search_test_runs surfaces a 400 for an unsupported TQL field', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testrun/search`, () =>
        HttpResponse.json({ errorMessages: ['Field name is not supported for test run queries'] }, { status: 400 }),
      ),
    );
    await withClient(async (t) => {
      const res = await t.call('search_test_runs', { query: 'name = "oops"' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Zephyr API error 400 (GET /rest/atm/1.0/testrun/search)');
      expect(res.text).toContain('Field name is not supported');
    });
  });

  it('delete_test_run surfaces a 404', async () => {
    mock.use(http.delete(`${BASE_URL}/rest/atm/1.0/testrun/PROJ-R404`, error404));
    await withClient(async (t) => {
      const res = await t.call('delete_test_run', { testRunKey: 'PROJ-R404' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Zephyr API error 404 (DELETE /rest/atm/1.0/testrun/PROJ-R404)');
      expect(res.text).not.toContain('"deleted"');
    });
  });

  it('get_test_run_results surfaces a 404 for a missing run instead of fabricating an empty page', async () => {
    // Both the paginated endpoint and the flat fallback answer 404 — the run does not exist.
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testrun/PROJ-R404/testresults/page`, error404),
      http.get(`${BASE_URL}/rest/atm/1.0/testrun/PROJ-R404/testresults`, error404),
    );
    await withClient(async (t) => {
      const res = await t.call('get_test_run_results', { testRunKey: 'PROJ-R404' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Zephyr API error 404 (GET /rest/atm/1.0/testrun/PROJ-R404/testresults)');
      expect(res.text).not.toContain('"values"');
    });
  });

  it('get_test_run_results falls back to the flat endpoint when /page is missing (older Zephyr versions)', async () => {
    const flatResults = [
      { id: 1, testCaseKey: 'PROJ-T1', status: 'Fail' },
      { id: 2, testCaseKey: 'PROJ-T1', status: 'Pass' },
      { id: 3, testCaseKey: 'PROJ-T2', status: 'Pass' },
    ];
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testrun/PROJ-R1/testresults/page`, error404),
      http.get(`${BASE_URL}/rest/atm/1.0/testrun/PROJ-R1/testresults`, () => HttpResponse.json(flatResults)),
    );
    await withClient(async (t) => {
      const paged = await t.call('get_test_run_results', { testRunKey: 'PROJ-R1', maxResults: 2 });
      expect(paged.isError).toBe(false);
      expect(paged.json).toMatchObject({ startAt: 0, maxResults: 2, total: 3, count: 2, isLast: false });
      expect(paged.json.note).toMatch(/flat endpoint/);
      expect(paged.json.values.map((v: { id: number }) => v.id)).toEqual([1, 2]);

      const last = await t.call('get_test_run_results', { testRunKey: 'PROJ-R1', onlyLastExecutions: true });
      expect(last.isError).toBe(false);
      expect(last.json.total).toBe(2);
      expect(last.json.values.map((v: { id: number }) => v.id)).toEqual([2, 3]);
    });
  });
});

describe('test result and misc tools: API error propagation', () => {
  it('get_latest_result_for_test_case surfaces a 404 without the run-composition hint', async () => {
    mock.use(http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1/testresult/latest`, error404));
    await withClient(async (t) => {
      const res = await t.call('get_latest_result_for_test_case', { testCaseKey: 'PROJ-T1' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Zephyr API error 404 (GET /rest/atm/1.0/testcase/PROJ-T1/testresult/latest)');
    });
  });

  it('find_jira_user surfaces a 403', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/api/2/user/search`, () =>
        HttpResponse.json({ errorMessages: ['You do not have permission to browse users.'] }, { status: 403 }),
      ),
    );
    await withClient(async (t) => {
      const res = await t.call('find_jira_user', { query: 'pupkin' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Zephyr API error 403 (GET /rest/api/2/user/search)');
    });
  });

  it('find_jira_user reports a controlled error on a 200 non-array body', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/api/2/user/search`, () => HttpResponse.json({ errorMessages: ['unexpected'] })),
    );
    await withClient(async (t) => {
      const res = await t.call('find_jira_user', { query: 'pupkin' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Unexpected response from Jira user search');
    });
  });

  it('list_attachments surfaces a 404', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T404/attachments`, () =>
        HttpResponse.json({ errorMessages: ['Test case not found'] }, { status: 404 }),
      ),
    );
    await withClient(async (t) => {
      const res = await t.call('list_attachments', { target: 'test_case', testCaseKey: 'PROJ-T404' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Zephyr API error 404 (GET /rest/atm/1.0/testcase/PROJ-T404/attachments)');
    });
  });

  it('delete_attachment surfaces a 404', async () => {
    mock.use(
      http.delete(`${BASE_URL}/rest/atm/1.0/attachments/999`, () =>
        HttpResponse.json({ errorMessages: ['Attachment not found'] }, { status: 404 }),
      ),
    );
    await withClient(async (t) => {
      const res = await t.call('delete_attachment', { attachmentId: 999 });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Zephyr API error 404 (DELETE /rest/atm/1.0/attachments/999)');
      expect(res.text).not.toContain('"deleted"');
    });
  });

  it('health_check treats a JSON 403 from the plugin as reachable', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/api/2/myself`, () => HttpResponse.json({ name: 'vladimir' })),
      http.get(`${BASE_URL}/rest/atm/1.0/environments`, () =>
        HttpResponse.json({ errorMessages: ['Project PROJ is not enabled for Zephyr'] }, { status: 403 }),
      ),
    );
    const t = await createTestClient({ defaultProjectKey: 'PROJ' });
    const res = await t.call('health_check');
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ ok: true, zephyrPluginReachable: true });
    await t.close();
  });
});

describe('automation tools: error paths and read-only mode', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zephyr-mcp-neg-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('upload_cucumber_results surfaces a 400 with the response body', async () => {
    const zipPath = join(dir, 'cucumber.zip');
    await writeFile(zipPath, Buffer.from('PKfake'));
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/automation/execution/cucumber/PROJ`, () =>
        HttpResponse.json({ errorMessages: ['No Cucumber reports found in the archive'] }, { status: 400 }),
      ),
    );
    await withClient(async (t) => {
      const res = await t.call('upload_cucumber_results', { projectKey: 'PROJ', filePath: zipPath });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('Zephyr API error 400 (POST /rest/atm/1.0/automation/execution/cucumber/PROJ)');
      expect(res.text).toContain('No Cucumber reports found');
    });
  });

  it('download_feature_files works in ZEPHYR_READONLY mode (it only reads from Zephyr)', async () => {
    const zipBytes = Buffer.from('PKfeature-zip');
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/automation/testcases`, () =>
        HttpResponse.arrayBuffer(zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength) as ArrayBuffer, {
          headers: { 'Content-Type': 'application/zip' },
        }),
      ),
    );
    const t = await createTestClient({ readonly: true });
    const out = join(dir, 'features-readonly.zip');
    const res = await t.call('download_feature_files', { outputPath: out });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ savedTo: out, bytes: zipBytes.length });
    await t.close();
  });

  it('download_feature_files rejects a 200 that is not a ZIP and writes nothing', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/automation/testcases`, () =>
        HttpResponse.text('<html>SSO login required</html>', { headers: { 'Content-Type': 'text/html' } }),
      ),
    );
    await withClient(async (t) => {
      const out = join(dir, 'not-a-zip.zip');
      const res = await t.call('download_feature_files', { outputPath: out });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('did not return a ZIP archive');
      expect(res.text).toContain('SSO login required');
      await expect(import('node:fs/promises').then((fs) => fs.access(out))).rejects.toThrow();
    });
  });
});
