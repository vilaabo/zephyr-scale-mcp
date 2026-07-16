import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, createTestClient } from './helpers.js';

const mock = setupServer();

beforeAll(() => mock.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

describe('create_test_run', () => {
  it('sends a minimal body of exactly projectKey and name', async () => {
    let capturedBody: unknown;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testrun`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'PROJ-R1' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_run', { projectKey: 'PROJ', name: 'Smoke run' });
    expect(res.isError).toBe(false);
    expect(capturedBody).toEqual({ projectKey: 'PROJ', name: 'Smoke run' });
    expect(res.json).toEqual({ key: 'PROJ-R1' });
    await t.close();
  });

  it('passes a full §8.2-style body with items and scriptResults through exactly', async () => {
    let capturedBody: unknown;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testrun`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'PROJ-R42' }, { status: 201 });
      }),
    );
    const args = {
      projectKey: 'PROJ',
      name: 'Регресс, спринт 42',
      folder: '/Регресс',
      testPlanKey: 'PROJ-P7',
      plannedStartDate: '2026-07-20T00:00:00Z',
      items: [
        {
          testCaseKey: 'PROJ-T123',
          environment: 'Chrome',
          executedBy: 'JIRAUSER10100',
          status: 'Fail',
          executionTime: 180000,
          scriptResults: [
            { index: 0, status: 'Pass' },
            { index: 1, status: 'Fail', comment: 'Кнопка неактивна' },
          ],
        },
        { testCaseKey: 'PROJ-T456' },
      ],
    };
    const t = await createTestClient();
    const res = await t.call('create_test_run', args);
    expect(res.isError).toBe(false);
    // Deep equality: the body is exactly the input — per-item optionals that were
    // not passed (e.g. everything on PROJ-T456 except testCaseKey) must be absent.
    expect(capturedBody).toEqual(args);
    expect(res.json).toEqual({ key: 'PROJ-R42' });
    expect(res.json).not.toHaveProperty('url');
    await t.close();
  });

  it('falls back to ZEPHYR_DEFAULT_PROJECT_KEY when projectKey is omitted', async () => {
    let capturedBody: any;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testrun`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'DEF-R9' }, { status: 201 });
      }),
    );
    const t = await createTestClient({ defaultProjectKey: 'DEF' });
    const res = await t.call('create_test_run', { name: 'Nightly' });
    expect(res.isError).toBe(false);
    expect(capturedBody).toEqual({ projectKey: 'DEF', name: 'Nightly' });
    await t.close();
  });

  it('errors without any HTTP call when projectKey is missing and no default is configured', async () => {
    let called = false;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testrun`, () => {
        called = true;
        return HttpResponse.json({ key: 'PROJ-R1' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_run', { name: 'Orphan run' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/projectKey is required/);
    expect(called).toBe(false);
    await t.close();
  });

  it('rejects the deprecated item field userKey (strict schema) without any HTTP call', async () => {
    let called = false;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testrun`, () => {
        called = true;
        return HttpResponse.json({ key: 'PROJ-R1' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_run', {
      projectKey: 'PROJ',
      name: 'Run',
      items: [{ testCaseKey: 'PROJ-T1', userKey: 'JIRAUSER10100' }],
    });
    expect(res.isError).toBe(true);
    expect(called).toBe(false);
    await t.close();
  });
});

describe('get_test_run', () => {
  it('fetches by key and serializes fields comma-separated', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testrun/PROJ-R7`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ key: 'PROJ-R7', name: 'Regression' });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('get_test_run', { testRunKey: 'PROJ-R7', fields: ['key', 'name'] });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ key: 'PROJ-R7', name: 'Regression' });
    expect(new URL(capturedUrl).searchParams.get('fields')).toBe('key,name');
    await t.close();
  });

  it('omits the fields query parameter when not requested', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testrun/PROJ-R7`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ key: 'PROJ-R7' });
      }),
    );
    const t = await createTestClient();
    await t.call('get_test_run', { testRunKey: 'PROJ-R7' });
    expect(new URL(capturedUrl).searchParams.has('fields')).toBe(false);
    await t.close();
  });
});

describe('search_test_runs', () => {
  it('sends query params and returns the page envelope (isLast=false when the page is full)', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testrun/search`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([{ key: 'PROJ-R1' }, { key: 'PROJ-R2' }]);
      }),
    );
    const t = await createTestClient();
    const res = await t.call('search_test_runs', {
      query: 'projectKey = "PROJ" AND folder = "/Regression"',
      fields: ['key', 'name'],
      startAt: 0,
      maxResults: 2,
    });
    expect(res.isError).toBe(false);
    const params = new URL(capturedUrl).searchParams;
    expect(params.get('query')).toBe('projectKey = "PROJ" AND folder = "/Regression"');
    expect(params.get('fields')).toBe('key,name');
    expect(params.get('startAt')).toBe('0');
    expect(params.get('maxResults')).toBe('2');
    expect(res.json).toEqual({
      startAt: 0,
      maxResults: 2,
      count: 2,
      isLast: false, // values.length === maxResults -> there may be more pages
      values: [{ key: 'PROJ-R1' }, { key: 'PROJ-R2' }],
    });
    await t.close();
  });

  it('defaults startAt=0 and maxResults=50 and reports isLast=true on a short page', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testrun/search`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([{ key: 'PROJ-R1' }]);
      }),
    );
    const t = await createTestClient();
    const res = await t.call('search_test_runs', { query: 'projectKey = "PROJ"' });
    const params = new URL(capturedUrl).searchParams;
    expect(params.get('startAt')).toBe('0');
    expect(params.get('maxResults')).toBe('50');
    expect(params.has('fields')).toBe(false);
    expect(res.json).toMatchObject({ startAt: 0, maxResults: 50, count: 1, isLast: true });
    await t.close();
  });
});

describe('delete_test_run', () => {
  it('maps a 204 response to { deleted: true, key }', async () => {
    let called = false;
    mock.use(
      http.delete(`${BASE_URL}/rest/atm/1.0/testrun/PROJ-R3`, () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('delete_test_run', { testRunKey: 'PROJ-R3' });
    expect(res.isError).toBe(false);
    expect(called).toBe(true);
    expect(res.json).toEqual({ deleted: true, key: 'PROJ-R3' });
    await t.close();
  });
});

describe('get_test_run_results', () => {
  const resultsUrl = `${BASE_URL}/rest/atm/1.0/testrun/PROJ-R5/testresults/page`;

  it('sends startAt/maxResults and omits onlyLastExecutions when not passed', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(resultsUrl, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ total: 1, values: [{ id: 11, status: 'Pass' }] });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('get_test_run_results', { testRunKey: 'PROJ-R5', startAt: 0, maxResults: 10 });
    expect(res.isError).toBe(false);
    const params = new URL(capturedUrl).searchParams;
    expect(params.get('startAt')).toBe('0');
    expect(params.get('maxResults')).toBe('10');
    expect(params.has('onlyLastExecutions')).toBe(false);
    expect(res.json).toEqual({
      startAt: 0,
      maxResults: 10,
      total: 1,
      count: 1,
      isLast: true,
      values: [{ id: 11, status: 'Pass' }],
    });
    await t.close();
  });

  it("sends onlyLastExecutions='true' when set", async () => {
    let capturedUrl = '';
    mock.use(
      http.get(resultsUrl, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ total: 0, values: [] });
      }),
    );
    const t = await createTestClient();
    await t.call('get_test_run_results', { testRunKey: 'PROJ-R5', onlyLastExecutions: true });
    const params = new URL(capturedUrl).searchParams;
    expect(params.get('onlyLastExecutions')).toBe('true');
    // defaults apply when startAt/maxResults are omitted
    expect(params.get('startAt')).toBe('0');
    expect(params.get('maxResults')).toBe('50');
    await t.close();
  });

  it('computes isLast from startAt + values.length vs total (middle page)', async () => {
    mock.use(
      http.get(resultsUrl, () => HttpResponse.json({ total: 5, values: [{ id: 1 }, { id: 2 }] })),
    );
    const t = await createTestClient();
    const res = await t.call('get_test_run_results', { testRunKey: 'PROJ-R5', startAt: 0, maxResults: 2 });
    expect(res.json).toMatchObject({ startAt: 0, maxResults: 2, total: 5, count: 2, isLast: false });
    await t.close();
  });

  it('computes isLast=true on the final page (startAt=3, 2 of 5 values)', async () => {
    mock.use(
      http.get(resultsUrl, () => HttpResponse.json({ total: 5, values: [{ id: 4 }, { id: 5 }] })),
    );
    const t = await createTestClient();
    const res = await t.call('get_test_run_results', { testRunKey: 'PROJ-R5', startAt: 3, maxResults: 2 });
    expect(res.json).toMatchObject({ startAt: 3, maxResults: 2, total: 5, count: 2, isLast: true });
    await t.close();
  });

  it('treats a response without values as an empty page', async () => {
    mock.use(http.get(resultsUrl, () => HttpResponse.json({ total: 0 })));
    const t = await createTestClient();
    const res = await t.call('get_test_run_results', { testRunKey: 'PROJ-R5' });
    expect(res.json).toEqual({ startAt: 0, maxResults: 50, total: 0, count: 0, isLast: true, values: [] });
    await t.close();
  });
});
