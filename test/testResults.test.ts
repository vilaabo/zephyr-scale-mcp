import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, createTestClient } from './helpers.js';

const mock = setupServer();

beforeAll(() => mock.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

const SINGLE_RESULT_URL = `${BASE_URL}/rest/atm/1.0/testrun/PROJ-R1/testcase/PROJ-T1/testresult`;
const BULK_RESULTS_URL = `${BASE_URL}/rest/atm/1.0/testrun/PROJ-R1/testresults`;

describe('create_test_result', () => {
  it('sends only the passed result fields as the body and returns the created id', async () => {
    let capturedBody: unknown;
    let capturedUrl = '';
    mock.use(
      http.post(SINGLE_RESULT_URL, async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({ id: 118 }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_result', {
      testRunKey: 'PROJ-R1',
      testCaseKey: 'PROJ-T1',
      status: 'Fail',
      comment: 'Login button stayed disabled',
      executionTime: 180000,
      scriptResults: [
        { index: 0, status: 'Pass' },
        { index: 1, status: 'Fail', comment: 'Button inactive' },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ id: 118 });
    // Exact body: passed fields pass through 1:1, unpassed optionals are absent, keys/selectors never leak in.
    expect(capturedBody).toEqual({
      status: 'Fail',
      comment: 'Login button stayed disabled',
      executionTime: 180000,
      scriptResults: [
        { index: 0, status: 'Pass' },
        { index: 1, status: 'Fail', comment: 'Button inactive' },
      ],
    });
    expect(new URL(capturedUrl).search).toBe('');
    await t.close();
  });

  it('sends matchEnvironment/matchUserKey as environment/userKey query params, never in the body', async () => {
    let capturedBody: unknown;
    let capturedUrl = '';
    mock.use(
      http.post(SINGLE_RESULT_URL, async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({ id: 119 }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_result', {
      testRunKey: 'PROJ-R1',
      testCaseKey: 'PROJ-T1',
      matchEnvironment: 'Chrome',
      matchUserKey: 'JIRAUSER10100',
      status: 'Pass',
    });
    expect(res.isError).toBe(false);
    const url = new URL(capturedUrl);
    expect(url.searchParams.get('environment')).toBe('Chrome');
    expect(url.searchParams.get('userKey')).toBe('JIRAUSER10100');
    expect(capturedBody).toEqual({ status: 'Pass' });
    await t.close();
  });

  it('adds the run-composition hint to a 400 when the case is not part of the run', async () => {
    mock.use(
      http.post(
        SINGLE_RESULT_URL,
        () => HttpResponse.json({ errorMessages: ['Test case PROJ-T1 is not part of test run PROJ-R1'] }, { status: 400 }),
      ),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_result', { testRunKey: 'PROJ-R1', testCaseKey: 'PROJ-T1', status: 'Pass' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/is not part of test run PROJ-R1/); // API body is passed through
    expect(res.text).toMatch(/fixed when the run is created/); // + immutability hint
    await t.close();
  });

  it('rejects the deprecated executionDate field without making an HTTP call', async () => {
    let called = false;
    mock.use(
      http.post(SINGLE_RESULT_URL, () => {
        called = true;
        return HttpResponse.json({ id: 1 }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_result', {
      testRunKey: 'PROJ-R1',
      testCaseKey: 'PROJ-T1',
      executionDate: '2026-07-16T00:00:00Z',
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/executionDate/);
    expect(called).toBe(false);
    await t.close();
  });
});

describe('update_last_test_result', () => {
  it('PUTs a partial body and normalizes an empty response to { updated: true, ... }', async () => {
    let capturedBody: unknown;
    let capturedUrl = '';
    mock.use(
      http.put(SINGLE_RESULT_URL, async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return new HttpResponse('', { status: 200 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('update_last_test_result', {
      testRunKey: 'PROJ-R1',
      testCaseKey: 'PROJ-T1',
      status: 'Blocked',
    });
    expect(res.isError).toBe(false);
    expect(capturedBody).toEqual({ status: 'Blocked' }); // only the passed field
    expect(new URL(capturedUrl).search).toBe(''); // no selectors -> no query params
    expect(res.json).toEqual({ updated: true, testRunKey: 'PROJ-R1', testCaseKey: 'PROJ-T1' });
    await t.close();
  });

  it('passes a non-empty API response through unchanged', async () => {
    mock.use(http.put(SINGLE_RESULT_URL, () => HttpResponse.json({ id: 77 })));
    const t = await createTestClient();
    const res = await t.call('update_last_test_result', { testRunKey: 'PROJ-R1', testCaseKey: 'PROJ-T1', comment: 'Re-checked' });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ id: 77 });
    await t.close();
  });

  it('adds the run-composition hint on 404', async () => {
    mock.use(http.put(SINGLE_RESULT_URL, () => HttpResponse.json({ errorMessages: ['No result found'] }, { status: 404 })));
    const t = await createTestClient();
    const res = await t.call('update_last_test_result', { testRunKey: 'PROJ-R1', testCaseKey: 'PROJ-T1', status: 'Pass' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/fixed when the run is created/);
    await t.close();
  });
});

describe('create_test_results_bulk', () => {
  it('sends the results array with compacted elements, selectors as query params, and passes ids through', async () => {
    let capturedBody: unknown;
    let capturedUrl = '';
    mock.use(
      http.post(BULK_RESULTS_URL, async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json([{ id: 200 }, { id: 201 }], { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_results_bulk', {
      testRunKey: 'PROJ-R1',
      matchEnvironment: 'Chrome',
      matchUserKey: 'JIRAUSER10100',
      results: [
        { testCaseKey: 'PROJ-T1', status: 'Pass', executionTime: 5000 },
        { testCaseKey: 'PROJ-T2' },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual([{ id: 200 }, { id: 201 }]);
    // Body is the bare array; unpassed optionals are absent from each element; selectors are not in the body.
    expect(capturedBody).toEqual([
      { testCaseKey: 'PROJ-T1', status: 'Pass', executionTime: 5000 },
      { testCaseKey: 'PROJ-T2' },
    ]);
    const url = new URL(capturedUrl);
    expect(url.searchParams.get('environment')).toBe('Chrome');
    expect(url.searchParams.get('userKey')).toBe('JIRAUSER10100');
    await t.close();
  });

  it('rejects an empty results array without making an HTTP call', async () => {
    let called = false;
    mock.use(
      http.post(BULK_RESULTS_URL, () => {
        called = true;
        return HttpResponse.json([], { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_results_bulk', { testRunKey: 'PROJ-R1', results: [] });
    expect(res.isError).toBe(true);
    expect(called).toBe(false);
    await t.close();
  });

  it('adds the run-composition hint when the API rejects unknown run items', async () => {
    mock.use(
      http.post(BULK_RESULTS_URL, () => HttpResponse.json({ errorMessages: ['PROJ-T9 not found in test run'] }, { status: 400 })),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_results_bulk', {
      testRunKey: 'PROJ-R1',
      results: [{ testCaseKey: 'PROJ-T9', status: 'Pass' }],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/PROJ-T9 not found in test run/);
    expect(res.text).toMatch(/fixed when the run is created/);
    await t.close();
  });
});

describe('get_latest_result_for_test_case', () => {
  it('GETs /testcase/{key}/testresult/latest and passes the response through', async () => {
    const latest = {
      id: 118,
      testCaseKey: 'PROJ-T1',
      status: 'Fail',
      environment: 'Chrome',
      executedBy: 'JIRAUSER10100',
      executionTime: 180000,
      scriptResults: [{ index: 0, status: 'Pass' }],
    };
    let requested = false;
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1/testresult/latest`, () => {
        requested = true;
        return HttpResponse.json(latest);
      }),
    );
    const t = await createTestClient();
    const res = await t.call('get_latest_result_for_test_case', { testCaseKey: 'PROJ-T1' });
    expect(res.isError).toBe(false);
    expect(requested).toBe(true);
    expect(res.json).toEqual(latest);
    await t.close();
  });
});
