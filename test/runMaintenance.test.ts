import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, createTestClient } from './helpers.js';

const mock = setupServer();

beforeAll(() => mock.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

const runUrl = `${BASE_URL}/rest/atm/1.0/testrun/PROJ-R1`;
const createUrl = `${BASE_URL}/rest/atm/1.0/testrun`;
const resultsUrl = `${runUrl}/testresults/page`;

/** GET /testrun response whose items carry read-only junk that must never reach POST /testrun. */
const sourceRun = {
  key: 'PROJ-R1',
  projectKey: 'PROJ',
  name: 'Sprint 1',
  folder: '/Regression',
  status: 'Done',
  estimatedTime: 99000,
  items: [
    {
      id: 101,
      testCaseKey: 'PROJ-T1',
      environment: 'Chrome',
      assignedTo: 'JIRAUSER10100',
      status: 'Pass',
      executionDate: '2026-01-01T00:00:00Z',
      userKey: 'JIRAUSER1',
      automated: false,
    },
    { id: 102, testCaseKey: 'PROJ-T2', comment: null },
  ],
};

describe('recreate_test_run_with_items', () => {
  it('recreates the run keeping only planning fields of the source items and does NOT delete the source', async () => {
    let capturedBody: any;
    let deleteCount = 0;
    mock.use(
      http.get(runUrl, () => HttpResponse.json(sourceRun)),
      http.post(createUrl, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'PROJ-R2' }, { status: 201 });
      }),
      http.delete(runUrl, () => {
        deleteCount++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('recreate_test_run_with_items', { testRunKey: 'PROJ-R1' });
    expect(res.isError).toBe(false);
    // Junk item fields (id, status, executionDate, userKey, automated) are stripped;
    // run-level junk (status, estimatedTime) never reaches the create body either.
    expect(capturedBody).toEqual({
      projectKey: 'PROJ',
      name: 'Sprint 1',
      folder: '/Regression',
      items: [
        { testCaseKey: 'PROJ-T1', environment: 'Chrome', assignedTo: 'JIRAUSER10100' },
        { testCaseKey: 'PROJ-T2' },
      ],
    });
    expect(res.json).toEqual({
      key: 'PROJ-R2',
      originalKey: 'PROJ-R1',
      itemCount: 2,
      copiedResults: 0,
      deletedOriginal: false,
    });
    expect(deleteCount).toBe(0);
    await t.close();
  });

  it('lets explicit name/folder win over the source values and derives projectKey from the run key when missing', async () => {
    let capturedBody: any;
    mock.use(
      http.get(runUrl, () =>
        HttpResponse.json({ key: 'PROJ-R1', name: 'Old name', folder: '/Old', items: [{ testCaseKey: 'PROJ-T1' }] }),
      ),
      http.post(createUrl, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'PROJ-R2' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('recreate_test_run_with_items', {
      testRunKey: 'PROJ-R1',
      name: 'New name',
      folder: '/New',
    });
    expect(res.isError).toBe(false);
    expect(capturedBody).toEqual({
      projectKey: 'PROJ', // no projectKey in the source -> prefix of the run key
      name: 'New name',
      folder: '/New',
      items: [{ testCaseKey: 'PROJ-T1' }],
    });
    await t.close();
  });

  it('drops removeTestCaseKeys items and appends compacted addItems after the kept ones', async () => {
    let capturedBody: any;
    mock.use(
      http.get(runUrl, () => HttpResponse.json(sourceRun)),
      http.post(createUrl, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'PROJ-R2' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('recreate_test_run_with_items', {
      testRunKey: 'PROJ-R1',
      removeTestCaseKeys: ['PROJ-T1'],
      addItems: [{ testCaseKey: 'PROJ-T9', status: 'Pass' }],
    });
    expect(res.isError).toBe(false);
    // Deep equality: unpassed optionals of the added item must be absent (compact).
    expect(capturedBody.items).toEqual([
      { testCaseKey: 'PROJ-T2' },
      { testCaseKey: 'PROJ-T9', status: 'Pass' },
    ]);
    expect(res.json).toMatchObject({ itemCount: 2, copiedResults: 0 });
    await t.close();
  });

  it('copyResults=true merges only §7.4 result fields and sanitizes scriptResults to {index,status,comment}', async () => {
    let capturedBody: any;
    let capturedResultsUrl = '';
    mock.use(
      http.get(runUrl, () => HttpResponse.json(sourceRun)),
      http.get(resultsUrl, ({ request }) => {
        capturedResultsUrl = request.url;
        return HttpResponse.json({
          total: 1,
          values: [
            {
              id: 9,
              testCaseKey: 'PROJ-T1',
              status: 'Fail',
              comment: 'Broken button',
              executionTime: 60000,
              executionDate: '2026-01-02T00:00:00Z', // deprecated/read-only junk
              automated: false,
              scriptResults: [
                { id: 77, index: 0, status: 'Pass', comment: 'ok', testData: 'junk' },
                { id: 78, index: 1, status: 'Fail' },
              ],
            },
          ],
        });
      }),
      http.post(createUrl, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'PROJ-R2' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('recreate_test_run_with_items', { testRunKey: 'PROJ-R1', copyResults: true });
    expect(res.isError).toBe(false);
    const params = new URL(capturedResultsUrl).searchParams;
    expect(params.get('onlyLastExecutions')).toBe('true');
    expect(params.get('maxResults')).toBe('200');
    expect(capturedBody.items).toEqual([
      {
        testCaseKey: 'PROJ-T1',
        environment: 'Chrome',
        assignedTo: 'JIRAUSER10100',
        status: 'Fail',
        comment: 'Broken button',
        executionTime: 60000,
        scriptResults: [
          { index: 0, status: 'Pass', comment: 'ok' },
          { index: 1, status: 'Fail' },
        ],
      },
      { testCaseKey: 'PROJ-T2' }, // no stored result -> nothing merged
    ]);
    expect(res.json).toMatchObject({ itemCount: 2, copiedResults: 1 });
    await t.close();
  });

  it('pages through the results until total is collected', async () => {
    let capturedBody: any;
    const startAts: Array<string | null> = [];
    mock.use(
      http.get(runUrl, () =>
        HttpResponse.json({
          key: 'PROJ-R1',
          projectKey: 'PROJ',
          name: 'Sprint 1',
          items: [{ testCaseKey: 'PROJ-T1' }, { testCaseKey: 'PROJ-T2' }, { testCaseKey: 'PROJ-T3' }],
        }),
      ),
      http.get(resultsUrl, ({ request }) => {
        const startAt = new URL(request.url).searchParams.get('startAt');
        startAts.push(startAt);
        if (startAt === '0') {
          return HttpResponse.json({
            total: 3,
            values: [
              { testCaseKey: 'PROJ-T1', status: 'Pass' },
              { testCaseKey: 'PROJ-T2', status: 'Fail' },
            ],
          });
        }
        return HttpResponse.json({ total: 3, values: [{ testCaseKey: 'PROJ-T3', status: 'Blocked' }] });
      }),
      http.post(createUrl, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'PROJ-R2' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('recreate_test_run_with_items', { testRunKey: 'PROJ-R1', copyResults: true });
    expect(res.isError).toBe(false);
    expect(startAts).toEqual(['0', '2']);
    expect(capturedBody.items).toEqual([
      { testCaseKey: 'PROJ-T1', status: 'Pass' },
      { testCaseKey: 'PROJ-T2', status: 'Fail' },
      { testCaseKey: 'PROJ-T3', status: 'Blocked' },
    ]);
    expect(res.json).toMatchObject({ itemCount: 3, copiedResults: 3 });
    await t.close();
  });

  it('deleteOriginal=true deletes the source AFTER the new run was created', async () => {
    const events: string[] = [];
    mock.use(
      http.get(runUrl, () => {
        events.push('GET');
        return HttpResponse.json(sourceRun);
      }),
      http.post(createUrl, () => {
        events.push('POST');
        return HttpResponse.json({ key: 'PROJ-R2' }, { status: 201 });
      }),
      http.delete(runUrl, () => {
        events.push('DELETE');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('recreate_test_run_with_items', { testRunKey: 'PROJ-R1', deleteOriginal: true });
    expect(res.isError).toBe(false);
    expect(events).toEqual(['GET', 'POST', 'DELETE']);
    expect(res.json).toMatchObject({ key: 'PROJ-R2', deletedOriginal: true });
    await t.close();
  });

  it('never deletes the source when creating the new run failed, even with deleteOriginal=true', async () => {
    let deleteCount = 0;
    mock.use(
      http.get(runUrl, () => HttpResponse.json(sourceRun)),
      http.post(createUrl, () => HttpResponse.json({ errorMessages: ['bad folder'] }, { status: 400 })),
      http.delete(runUrl, () => {
        deleteCount++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('recreate_test_run_with_items', { testRunKey: 'PROJ-R1', deleteOriginal: true });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/400/);
    expect(deleteCount).toBe(0);
    await t.close();
  });
});

describe('get_folder_tree', () => {
  it('is not registered at all when ZEPHYR_ALLOW_INTERNAL_API is off', async () => {
    const t = await createTestClient(); // allowInternalApi: false by default
    const tools = await t.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).not.toContain('get_folder_tree');
    const res = await t.call('get_folder_tree', { projectKey: 'PROJ' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/get_folder_tree not found/);
    await t.close();
  });

  it('resolves the numeric project id and passes the folder tree through (default folderType test_case)', async () => {
    const tree = { id: 123, name: 'Root', children: [{ id: 124, name: 'Regression', children: [] }] };
    mock.use(
      http.get(`${BASE_URL}/rest/api/2/project/PROJ`, () => HttpResponse.json({ id: 10001, key: 'PROJ' })),
      http.get(`${BASE_URL}/rest/tests/1.0/project/10001/foldertree/testcase`, () => HttpResponse.json(tree)),
    );
    const t = await createTestClient({ allowInternalApi: true });
    const res = await t.call('get_folder_tree', { projectKey: 'PROJ' });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual(tree);
    await t.close();
  });

  it('maps folderType test_run to the /foldertree/testrun segment (project id may come back as a string)', async () => {
    let treeUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/api/2/project/PROJ`, () => HttpResponse.json({ id: '10001' })),
      http.get(`${BASE_URL}/rest/tests/1.0/project/10001/foldertree/testrun`, ({ request }) => {
        treeUrl = request.url;
        return HttpResponse.json([]);
      }),
    );
    const t = await createTestClient({ allowInternalApi: true, defaultProjectKey: 'PROJ' });
    const res = await t.call('get_folder_tree', { folderType: 'test_run' });
    expect(res.isError).toBe(false);
    expect(treeUrl).toContain('/rest/tests/1.0/project/10001/foldertree/testrun');
    await t.close();
  });
});

describe('recreate_test_run_with_items: review fixes', () => {
  it('does not forward JSON null header fields from the source run', async () => {
    let capturedBody: any;
    mock.use(
      http.get(runUrl, () =>
        HttpResponse.json({
          key: 'PROJ-R1',
          projectKey: 'PROJ',
          name: 'Sprint 1',
          folder: null,
          testPlanKey: null,
          owner: null,
          items: [{ testCaseKey: 'PROJ-T1' }],
        }),
      ),
      http.post(createUrl, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'PROJ-R2' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('recreate_test_run_with_items', { testRunKey: 'PROJ-R1' });
    expect(res.isError).toBe(false);
    expect(capturedBody).toEqual({ projectKey: 'PROJ', name: 'Sprint 1', items: [{ testCaseKey: 'PROJ-T1' }] });
    await t.close();
  });

  it('inherits issueLinks from the source run and lets an explicit value win', async () => {
    let bodies: any[] = [];
    mock.use(
      http.get(runUrl, () =>
        HttpResponse.json({
          key: 'PROJ-R1',
          projectKey: 'PROJ',
          name: 'Sprint 1',
          issueLinks: ['PROJ-7', 'PROJ-8'],
          items: [{ testCaseKey: 'PROJ-T1' }],
        }),
      ),
      http.post(createUrl, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ key: 'PROJ-R2' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    await t.call('recreate_test_run_with_items', { testRunKey: 'PROJ-R1' });
    await t.call('recreate_test_run_with_items', { testRunKey: 'PROJ-R1', issueLinks: ['PROJ-99'] });
    expect(bodies[0].issueLinks).toEqual(['PROJ-7', 'PROJ-8']);
    expect(bodies[1].issueLinks).toEqual(['PROJ-99']);
    await t.close();
  });

  it("copyResults keeps each item's own environment when the copied result carries a different one", async () => {
    let capturedBody: any;
    mock.use(
      http.get(runUrl, () =>
        HttpResponse.json({
          key: 'PROJ-R1',
          projectKey: 'PROJ',
          name: 'Sprint 1',
          items: [
            { testCaseKey: 'PROJ-T1', environment: 'Chrome' },
            { testCaseKey: 'PROJ-T1', environment: 'Firefox' },
          ],
        }),
      ),
      http.get(resultsUrl, () =>
        HttpResponse.json({
          total: 1,
          values: [{ testCaseKey: 'PROJ-T1', status: 'Pass', environment: 'Chrome' }],
        }),
      ),
      http.post(createUrl, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'PROJ-R2' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('recreate_test_run_with_items', { testRunKey: 'PROJ-R1', copyResults: true });
    expect(res.isError).toBe(false);
    // Both duplicate items receive the case's latest execution, but each keeps its own environment.
    expect(capturedBody.items).toEqual([
      { testCaseKey: 'PROJ-T1', environment: 'Chrome', status: 'Pass' },
      { testCaseKey: 'PROJ-T1', environment: 'Firefox', status: 'Pass' },
    ]);
    expect(res.json).toMatchObject({ copiedResults: 2 });
    await t.close();
  });
});
