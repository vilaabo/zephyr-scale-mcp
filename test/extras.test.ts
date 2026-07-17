/**
 * Tests for the convenience tools added on top of the ТЗ scope (user-requested):
 * get_test_run_summary, clone_test_case, get_issue_test_coverage and the
 * UNOFFICIAL get_status_options.
 */
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, createTestClient } from './helpers.js';

const mock = setupServer();

beforeAll(() => mock.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

describe('get_test_run_summary', () => {
  it('aggregates latest results by verbatim status with progress and pass rate', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testrun/PROJ-R1`, () =>
        HttpResponse.json({ key: 'PROJ-R1', name: 'Sprint 1', status: 'In Progress', items: [{}, {}, {}, {}] }),
      ),
      http.get(`${BASE_URL}/rest/atm/1.0/testrun/PROJ-R1/testresults/page`, () =>
        HttpResponse.json({
          total: 4,
          values: [
            { testCaseKey: 'PROJ-T1', status: 'Pass' },
            { testCaseKey: 'PROJ-T2', status: 'Fail' },
            { testCaseKey: 'PROJ-T3', status: 'Ручной' },
            { testCaseKey: 'PROJ-T4', status: 'Not Executed' },
          ],
        }),
      ),
    );
    const t = await createTestClient();
    const res = await t.call('get_test_run_summary', { testRunKey: 'PROJ-R1' });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({
      key: 'PROJ-R1',
      name: 'Sprint 1',
      runStatus: 'In Progress',
      itemCount: 4,
      latestResults: 4,
      executed: 3,
      executionProgressPct: 75,
      byStatus: { Pass: 1, Fail: 1, 'Ручной': 1, 'Not Executed': 1 },
      passRatePct: 33.3,
    });
    await t.close();
  });

  it('works through the flat-endpoint fallback and omits passRatePct without a Pass status', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testrun/PROJ-R1`, () =>
        HttpResponse.json({ key: 'PROJ-R1', name: 'Old stand', status: 'Done', items: [{}] }),
      ),
      http.get(
        `${BASE_URL}/rest/atm/1.0/testrun/PROJ-R1/testresults/page`,
        () => new HttpResponse('nope', { status: 404 }),
      ),
      http.get(`${BASE_URL}/rest/atm/1.0/testrun/PROJ-R1/testresults`, () =>
        HttpResponse.json([{ id: 1, testCaseKey: 'PROJ-T1', status: 'Выполнен' }]),
      ),
    );
    const t = await createTestClient();
    const res = await t.call('get_test_run_summary', { testRunKey: 'PROJ-R1' });
    expect(res.isError).toBe(false);
    expect(res.json.byStatus).toEqual({ 'Выполнен': 1 });
    expect(res.json.passRatePct).toBeUndefined();
    expect(res.json.note).toMatch(/flat endpoint/);
    await t.close();
  });
});

describe('clone_test_case', () => {
  const source = {
    key: 'PROJ-T1',
    projectKey: 'PROJ',
    name: 'Login works',
    objective: 'Check login',
    folder: '/Regression',
    status: 'Approved',
    priority: 'High',
    owner: 'JIRAUSER10100',
    labels: ['smoke'],
    estimatedTime: 60000,
    component: null,
    customFields: { 'My Field': 'Value' },
    createdOn: '2026-01-01T00:00:00Z', // read-only junk that must not be copied
    majorVersion: 3,
    testScript: {
      id: 42,
      type: 'STEP_BY_STEP',
      steps: [
        { id: 7, index: 0, description: 'Open login page', expectedResult: 'Form shown' },
        { id: 8, index: 1, description: 'Submit', testData: 'valid creds', expectedResult: 'Dashboard' },
      ],
    },
  };

  it('copies writable fields and the script without step ids', async () => {
    let capturedBody: any;
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1`, () => HttpResponse.json(source)),
      http.post(`${BASE_URL}/rest/atm/1.0/testcase`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'PROJ-T99' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('clone_test_case', { testCaseKey: 'PROJ-T1' });
    expect(res.isError).toBe(false);
    expect(capturedBody).toEqual({
      projectKey: 'PROJ',
      name: 'Login works (copy)',
      objective: 'Check login',
      folder: '/Regression',
      status: 'Approved',
      priority: 'High',
      owner: 'JIRAUSER10100',
      estimatedTime: 60000,
      labels: ['smoke'],
      customFields: { 'My Field': 'Value' },
      testScript: {
        type: 'STEP_BY_STEP',
        steps: [
          { description: 'Open login page', expectedResult: 'Form shown' },
          { description: 'Submit', testData: 'valid creds', expectedResult: 'Dashboard' },
        ],
      },
    });
    expect(res.json).toEqual({
      key: 'PROJ-T99',
      url: `${BASE_URL}/secure/Tests.jspa#/testCase/PROJ-T99`,
      sourceKey: 'PROJ-T1',
    });
    await t.close();
  });

  it('honors name/folder overrides and includeScript=false', async () => {
    let capturedBody: any;
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1`, () => HttpResponse.json(source)),
      http.post(`${BASE_URL}/rest/atm/1.0/testcase`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'PROJ-T100' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('clone_test_case', {
      testCaseKey: 'PROJ-T1',
      name: 'Login works v2',
      folder: '/Regression/New',
      includeScript: false,
    });
    expect(res.isError).toBe(false);
    expect(capturedBody.name).toBe('Login works v2');
    expect(capturedBody.folder).toBe('/Regression/New');
    expect(capturedBody.testScript).toBeUndefined();
    await t.close();
  });
});

describe('get_issue_test_coverage', () => {
  it('expands linked cases with their latest results, capped by maxCases', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/issuelink/PROJ-5/testcases`, () =>
        HttpResponse.json([{ key: 'PROJ-T1' }, { key: 'PROJ-T2' }, { key: 'PROJ-T3' }]),
      ),
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1`, () =>
        HttpResponse.json({ key: 'PROJ-T1', name: 'Case 1', status: 'Approved' }),
      ),
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T2`, () =>
        HttpResponse.json({ key: 'PROJ-T2', name: 'Case 2', status: 'Draft' }),
      ),
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1/testresult/latest`, () =>
        HttpResponse.json({ status: 'Fail', environment: 'Chrome', actualEndDate: '2026-07-01T00:00:00Z', junk: 'x' }),
      ),
      http.get(
        `${BASE_URL}/rest/atm/1.0/testcase/PROJ-T2/testresult/latest`,
        () => new HttpResponse('', { status: 404 }),
      ),
    );
    const t = await createTestClient();
    const res = await t.call('get_issue_test_coverage', { issueKey: 'PROJ-5', maxCases: 2 });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({
      issueKey: 'PROJ-5',
      totalLinked: 3,
      returned: 2,
      note: 'Expanded only the first 2 of 3 linked cases (maxCases).',
      cases: [
        {
          key: 'PROJ-T1',
          name: 'Case 1',
          status: 'Approved',
          lastResult: { status: 'Fail', environment: 'Chrome', actualEndDate: '2026-07-01T00:00:00Z' },
        },
        { key: 'PROJ-T2', name: 'Case 2', status: 'Draft', lastResult: null },
      ],
    });
    await t.close();
  });

  it('skips result lookups when includeLastResults=false', async () => {
    let latestCalls = 0;
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/issuelink/PROJ-5/testcases`, () => HttpResponse.json([{ key: 'PROJ-T1' }])),
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1`, () => HttpResponse.json({ key: 'PROJ-T1', name: 'Case 1' })),
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1/testresult/latest`, () => {
        latestCalls++;
        return HttpResponse.json({});
      }),
    );
    const t = await createTestClient();
    const res = await t.call('get_issue_test_coverage', { issueKey: 'PROJ-5', includeLastResults: false });
    expect(res.isError).toBe(false);
    expect(res.json.cases[0].lastResult).toBeNull();
    expect(latestCalls).toBe(0);
    await t.close();
  });
});

describe('get_status_options (UNOFFICIAL, gated)', () => {
  const statuses = [
    { id: 1, name: 'Not Executed' },
    { id: 2, name: 'Выполнен' },
    { id: 3, name: 'Провален' },
  ];

  it('is not registered without ZEPHYR_ALLOW_INTERNAL_API', async () => {
    const t = await createTestClient();
    const res = await t.call('get_status_options', {});
    expect(res.isError).toBe(true);
    await t.close();
  });

  it('resolves the project id and reads execution statuses from the internal API', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/api/2/project/PROJ`, () => HttpResponse.json({ id: '10001' })),
      http.get(`${BASE_URL}/rest/tests/1.0/project/10001/testresultstatus`, () => HttpResponse.json(statuses)),
    );
    const t = await createTestClient({ allowInternalApi: true });
    const res = await t.call('get_status_options', { projectKey: 'PROJ' });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ source: '/rest/tests/1.0/project/10001/testresultstatus', values: statuses });
    await t.close();
  });

  it('falls back to the projectId-query variant when the first path 404s', async () => {
    let fallbackUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/api/2/project/PROJ`, () => HttpResponse.json({ id: 10001 })),
      http.get(`${BASE_URL}/rest/tests/1.0/project/10001/testcasestatus`, () => new HttpResponse('nope', { status: 404 })),
      http.get(`${BASE_URL}/rest/tests/1.0/testcasestatus`, ({ request }) => {
        fallbackUrl = request.url;
        return HttpResponse.json(statuses);
      }),
    );
    const t = await createTestClient({ allowInternalApi: true });
    const res = await t.call('get_status_options', { projectKey: 'PROJ', kind: 'test_case' });
    expect(res.isError).toBe(false);
    expect(res.json.source).toBe('/rest/tests/1.0/testcasestatus');
    expect(new URL(fallbackUrl).searchParams.get('projectId')).toBe('10001');
    await t.close();
  });

  it('reports a clear error with the UI hint when no variant exists', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/api/2/project/PROJ`, () => HttpResponse.json({ id: 10001 })),
      http.get(`${BASE_URL}/rest/tests/1.0/project/10001/testresultstatus`, () => new HttpResponse('nope', { status: 404 })),
      http.get(`${BASE_URL}/rest/tests/1.0/testresultstatus`, () => new HttpResponse('nope', { status: 404 })),
    );
    const t = await createTestClient({ allowInternalApi: true });
    const res = await t.call('get_status_options', { projectKey: 'PROJ' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Project settings/);
    await t.close();
  });
});

describe('download_attachment', () => {
  const bytes = Buffer.from('attachment-bytes-éé');

  it('downloads by attachmentId to the local path', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'zephyr-dl-'));
    mock.use(
      http.get(`${BASE_URL}/rest/tests/1.0/attachment/54975`, () =>
        HttpResponse.arrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
      ),
    );
    const t = await createTestClient();
    const out = join(dir, 'file.txt');
    const res = await t.call('download_attachment', { attachmentId: 54975, outputPath: out });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ savedTo: out, bytes: bytes.length });
    expect((await readFile(out)).equals(bytes)).toBe(true);
    await rm(dir, { recursive: true, force: true });
    await t.close();
  });

  it('accepts a same-origin url from list_attachments and rejects foreign hosts without any HTTP call', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'zephyr-dl-'));
    let requests = 0;
    mock.use(
      http.get(`${BASE_URL}/rest/tests/1.0/attachment/1`, () => {
        requests++;
        return HttpResponse.arrayBuffer(new ArrayBuffer(4));
      }),
    );
    const t = await createTestClient();
    const ok = await t.call('download_attachment', { url: `${BASE_URL}/rest/tests/1.0/attachment/1`, outputPath: join(dir, 'a.bin') });
    expect(ok.isError).toBe(false);
    const foreign = await t.call('download_attachment', {
      url: 'https://evil.example.com/rest/tests/1.0/attachment/1',
      outputPath: join(dir, 'b.bin'),
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('configured Jira host');
    expect(requests).toBe(1);
    await rm(dir, { recursive: true, force: true });
    await t.close();
  });

  it('requires exactly one of attachmentId or url', async () => {
    const t = await createTestClient();
    const neither = await t.call('download_attachment', { outputPath: '/tmp/x.bin' });
    expect(neither.isError).toBe(true);
    expect(neither.text).toContain('exactly ONE');
    const both = await t.call('download_attachment', {
      attachmentId: 1,
      url: `${BASE_URL}/rest/tests/1.0/attachment/1`,
      outputPath: '/tmp/x.bin',
    });
    expect(both.isError).toBe(true);
    await t.close();
  });

  it('propagates a 404 and writes no file', async () => {
    const { access } = await import('node:fs/promises');
    mock.use(http.get(`${BASE_URL}/rest/tests/1.0/attachment/999`, () => new HttpResponse('', { status: 404 })));
    const t = await createTestClient();
    const out = '/tmp/zephyr-dl-never-written.bin';
    const res = await t.call('download_attachment', { attachmentId: 999, outputPath: out });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('404');
    await expect(access(out)).rejects.toThrow();
    await t.close();
  });
});

describe('delete_folder (UNOFFICIAL, gated)', () => {
  it('is not registered without ZEPHYR_ALLOW_INTERNAL_API', async () => {
    const t = await createTestClient();
    const res = await t.call('delete_folder', { folderId: 8926 });
    expect(res.isError).toBe(true);
    await t.close();
  });

  it('deletes a folder via the internal endpoint', async () => {
    let method = '';
    mock.use(
      http.delete(`${BASE_URL}/rest/tests/1.0/folder/8926`, ({ request }) => {
        method = request.method;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = await createTestClient({ allowInternalApi: true });
    const res = await t.call('delete_folder', { folderId: 8926 });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ deleted: true, id: 8926 });
    expect(method).toBe('DELETE');
    await t.close();
  });

  it('surfaces internal-API errors with the UNOFFICIAL hint', async () => {
    mock.use(
      http.delete(`${BASE_URL}/rest/tests/1.0/folder/999`, () => new HttpResponse('nope', { status: 404 })),
    );
    const t = await createTestClient({ allowInternalApi: true });
    const res = await t.call('delete_folder', { folderId: 999 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('404');
    expect(res.text).toMatch(/internal API/);
    await t.close();
  });
});

describe('create_test_cases_bulk: fallback when the bulk endpoint is broken (issue #1)', () => {
  const bulk500 = () => new HttpResponse(null, { status: 500 });

  it('falls back to one-by-one creation on 500 with an empty body', async () => {
    const singleBodies: any[] = [];
    let keySeq = 100;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testcase/bulk`, bulk500),
      http.post(`${BASE_URL}/rest/atm/1.0/testcase`, async ({ request }) => {
        singleBodies.push(await request.json());
        return HttpResponse.json({ key: `PROJ-T${keySeq++}` }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_cases_bulk', {
      projectKey: 'PROJ',
      testCases: [{ name: 'Кейс 1', folder: '/Inbox' }, { name: 'Case 2' }],
    });
    expect(res.isError).toBe(false);
    expect(res.json.note).toMatch(/bulk endpoint may be unavailable/);
    expect(res.json.note).toContain('2/2 created');
    expect(res.json.created).toEqual([
      { key: 'PROJ-T100', url: `${BASE_URL}/secure/Tests.jspa#/testCase/PROJ-T100` },
      { key: 'PROJ-T101', url: `${BASE_URL}/secure/Tests.jspa#/testCase/PROJ-T101` },
    ]);
    expect(res.json.failed).toBeUndefined();
    expect(singleBodies).toEqual([
      { projectKey: 'PROJ', name: 'Кейс 1', folder: '/Inbox' },
      { projectKey: 'PROJ', name: 'Case 2' },
    ]);
    await t.close();
  });

  it('reports partially failed items without losing the created ones', async () => {
    let call = 0;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testcase/bulk`, bulk500),
      http.post(`${BASE_URL}/rest/atm/1.0/testcase`, () => {
        call++;
        if (call === 2) {
          return HttpResponse.json({ errorMessages: ['The folder /Nope does not exist'] }, { status: 400 });
        }
        return HttpResponse.json({ key: `PROJ-T${200 + call}` }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_cases_bulk', {
      projectKey: 'PROJ',
      testCases: [{ name: 'ok-1' }, { name: 'bad', folder: '/Nope' }, { name: 'ok-2' }],
    });
    expect(res.isError).toBe(false);
    expect(res.json.created.map((c: { key: string }) => c.key)).toEqual(['PROJ-T201', 'PROJ-T203']);
    expect(res.json.failed).toHaveLength(1);
    expect(res.json.failed[0]).toMatchObject({ index: 1, name: 'bad' });
    expect(res.json.failed[0].error).toContain('does not exist');
    await t.close();
  });

  it('surfaces a combined error when the fallback also fails for every item', async () => {
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testcase/bulk`, bulk500),
      http.post(
        `${BASE_URL}/rest/atm/1.0/testcase`,
        () => new HttpResponse('', { status: 401 }),
      ),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_cases_bulk', { projectKey: 'PROJ', testCases: [{ name: 'x' }] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/bulk endpoint may be unavailable/);
    expect(res.text).toMatch(/fallback via POST \/testcase also failed/);
    await t.close();
  });

  it('does NOT fall back on a 400 from the bulk endpoint (payload problem, not a broken endpoint)', async () => {
    let singleCalls = 0;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testcase/bulk`, () =>
        HttpResponse.json({ errorMessages: ['Test case status Nope does not exist'] }, { status: 400 }),
      ),
      http.post(`${BASE_URL}/rest/atm/1.0/testcase`, () => {
        singleCalls++;
        return HttpResponse.json({ key: 'PROJ-T1' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_cases_bulk', { projectKey: 'PROJ', testCases: [{ name: 'x', status: 'Nope' }] });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('Zephyr API error 400 (POST /rest/atm/1.0/testcase/bulk)');
    expect(singleCalls).toBe(0);
    await t.close();
  });
});
