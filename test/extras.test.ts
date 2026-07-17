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
