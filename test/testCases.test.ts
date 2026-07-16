import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, createTestClient } from './helpers.js';

const mock = setupServer();

beforeAll(() => mock.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

const ATM = `${BASE_URL}/rest/atm/1.0`;

const webUrl = (key: string) => `${BASE_URL}/secure/Tests.jspa#/testCase/${key}`;

describe('create_test_case', () => {
  function mockCreate(key = 'PROJ-T1') {
    const captured: { body?: unknown } = {};
    mock.use(
      http.post(`${ATM}/testcase`, async ({ request }) => {
        captured.body = await request.json();
        return HttpResponse.json({ key }, { status: 201 });
      }),
    );
    return captured;
  }

  it('creates a STEP_BY_STEP case with an exact body (unpassed optionals absent) and maps { key, url }', async () => {
    const captured = mockCreate('PROJ-T1');
    const t = await createTestClient();
    const res = await t.call('create_test_case', {
      projectKey: 'PROJ',
      name: 'Login works',
      folder: '/Regression',
      labels: ['smoke'],
      testScript: {
        type: 'STEP_BY_STEP',
        steps: [
          { description: 'Open login page', testData: 'URL: /login', expectedResult: 'Form shown' },
          { testCaseKey: 'PROJ-T45' },
        ],
      },
    });
    expect(res.isError).toBe(false);
    expect(captured.body).toEqual({
      projectKey: 'PROJ',
      name: 'Login works',
      folder: '/Regression',
      labels: ['smoke'],
      testScript: {
        type: 'STEP_BY_STEP',
        steps: [
          { description: 'Open login page', testData: 'URL: /login', expectedResult: 'Form shown' },
          { testCaseKey: 'PROJ-T45' },
        ],
      },
    });
    expect(res.json).toEqual({ key: 'PROJ-T1', url: webUrl('PROJ-T1') });
    await t.close();
  });

  it('creates a PLAIN_TEXT case with an exact body', async () => {
    const captured = mockCreate('PROJ-T2');
    const t = await createTestClient();
    const res = await t.call('create_test_case', {
      projectKey: 'PROJ',
      name: 'Plain case',
      testScript: { type: 'PLAIN_TEXT', text: 'Open the login page and verify the form is displayed.' },
    });
    expect(captured.body).toEqual({
      projectKey: 'PROJ',
      name: 'Plain case',
      testScript: { type: 'PLAIN_TEXT', text: 'Open the login page and verify the form is displayed.' },
    });
    expect(res.json).toEqual({ key: 'PROJ-T2', url: webUrl('PROJ-T2') });
    await t.close();
  });

  it('creates a BDD case preserving the Gherkin text byte-for-byte (newlines + unicode)', async () => {
    const gherkin =
      'Feature: Авторизация\n\nScenario: Успешный вход\n  Given открыта страница логина\n  When пользователь вводит валидные креды\n  Then открывается дашборд';
    const captured = mockCreate('PROJ-T3');
    const t = await createTestClient();
    const res = await t.call('create_test_case', {
      projectKey: 'PROJ',
      name: 'BDD case',
      testScript: { type: 'BDD', text: gherkin },
    });
    expect(captured.body).toEqual({
      projectKey: 'PROJ',
      name: 'BDD case',
      testScript: { type: 'BDD', text: gherkin },
    });
    expect((captured.body as any).testScript.text).toBe(gherkin);
    expect(res.json).toEqual({ key: 'PROJ-T3', url: webUrl('PROJ-T3') });
    await t.close();
  });

  it('falls back to ZEPHYR_DEFAULT_PROJECT_KEY when projectKey is not passed', async () => {
    const captured = mockCreate();
    const t = await createTestClient({ defaultProjectKey: 'DEF' });
    const res = await t.call('create_test_case', { name: 'Uses default project' });
    expect(res.isError).toBe(false);
    expect(captured.body).toEqual({ projectKey: 'DEF', name: 'Uses default project' });
    await t.close();
  });

  it('errors without any HTTP call when projectKey is missing everywhere', async () => {
    const t = await createTestClient();
    const res = await t.call('create_test_case', { name: 'No project' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/projectKey is required/);
    await t.close();
  });
});

describe('get_test_case', () => {
  it('serializes fields as a comma-separated query param and passes the payload through', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${ATM}/testcase/PROJ-T1`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ key: 'PROJ-T1', name: 'Login works' });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('get_test_case', { testCaseKey: 'PROJ-T1', fields: ['key', 'name'] });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ key: 'PROJ-T1', name: 'Login works' });
    expect(new URL(capturedUrl).searchParams.get('fields')).toBe('key,name');
    await t.close();
  });

  it('omits the fields param entirely when not passed', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${ATM}/testcase/PROJ-T1`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ key: 'PROJ-T1' });
      }),
    );
    const t = await createTestClient();
    await t.call('get_test_case', { testCaseKey: 'PROJ-T1' });
    expect(new URL(capturedUrl).searchParams.has('fields')).toBe(false);
    await t.close();
  });
});

describe('search_test_cases', () => {
  it('uses GET with query params and returns the page envelope (isLast=true when count < maxResults)', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${ATM}/testcase/search`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([{ key: 'PROJ-T1' }, { key: 'PROJ-T2' }]);
      }),
    );
    const t = await createTestClient();
    const res = await t.call('search_test_cases', {
      query: 'projectKey = "PROJ" AND status = "Draft"',
      fields: ['key', 'name'],
      startAt: 5,
      maxResults: 10,
    });
    const params = new URL(capturedUrl).searchParams;
    expect(params.get('query')).toBe('projectKey = "PROJ" AND status = "Draft"');
    expect(params.get('startAt')).toBe('5');
    expect(params.get('maxResults')).toBe('10');
    expect(params.get('fields')).toBe('key,name');
    expect(res.json).toEqual({
      startAt: 5,
      maxResults: 10,
      count: 2,
      isLast: true,
      values: [{ key: 'PROJ-T1' }, { key: 'PROJ-T2' }],
    });
    await t.close();
  });

  it('applies defaults startAt=0 / maxResults=50 and reports isLast=false on a full page', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${ATM}/testcase/search`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([{ key: 'PROJ-T1' }, { key: 'PROJ-T2' }]);
      }),
    );
    const t = await createTestClient();
    const res = await t.call('search_test_cases', { query: 'projectKey = "PROJ"', maxResults: 2 });
    expect(res.json).toMatchObject({ startAt: 0, maxResults: 2, count: 2, isLast: false });
    const dflt = await t.call('search_test_cases', { query: 'projectKey = "PROJ"' });
    const params = new URL(capturedUrl).searchParams;
    expect(params.get('startAt')).toBe('0');
    expect(params.get('maxResults')).toBe('50');
    expect(dflt.json).toMatchObject({ startAt: 0, maxResults: 50, count: 2, isLast: true });
    await t.close();
  });

  it('switches to POST /testcase/search when the query exceeds 1500 characters', async () => {
    const longQuery = `key IN (${Array.from({ length: 300 }, (_, i) => `"PROJ-T${i + 1}"`).join(', ')})`;
    expect(longQuery.length).toBeGreaterThan(1500);
    let getCount = 0;
    let capturedBody: unknown;
    mock.use(
      http.get(`${ATM}/testcase/search`, () => {
        getCount += 1;
        return HttpResponse.json([]);
      }),
      http.post(`${ATM}/testcase/search`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json([{ key: 'PROJ-T1' }]);
      }),
    );
    const t = await createTestClient();
    const res = await t.call('search_test_cases', { query: longQuery });
    expect(getCount).toBe(0);
    expect(capturedBody).toEqual({ query: longQuery, startAt: 0, maxResults: 50 });
    expect(res.json).toEqual({ startAt: 0, maxResults: 50, count: 1, isLast: true, values: [{ key: 'PROJ-T1' }] });
    await t.close();
  });

  it('includes fields as an array in the POST body when passed', async () => {
    const longQuery = `key IN (${Array.from({ length: 300 }, (_, i) => `"PROJ-T${i + 1}"`).join(', ')})`;
    let capturedBody: unknown;
    mock.use(
      http.post(`${ATM}/testcase/search`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json([]);
      }),
    );
    const t = await createTestClient();
    await t.call('search_test_cases', { query: longQuery, fields: ['key', 'name'], startAt: 10, maxResults: 5 });
    expect(capturedBody).toEqual({ query: longQuery, startAt: 10, maxResults: 5, fields: ['key', 'name'] });
    await t.close();
  });
});

describe('update_test_case', () => {
  it('sends only the passed fields (partial update) and returns { key, url }', async () => {
    let capturedBody: unknown;
    mock.use(
      http.put(`${ATM}/testcase/PROJ-T1`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({});
      }),
    );
    const t = await createTestClient();
    const res = await t.call('update_test_case', { testCaseKey: 'PROJ-T1', status: 'Approved' });
    expect(res.isError).toBe(false);
    expect(capturedBody).toEqual({ status: 'Approved' });
    expect(res.json).toEqual({ key: 'PROJ-T1', url: webUrl('PROJ-T1') });
    await t.close();
  });
});

describe('add_test_steps', () => {
  /** GET fixture: steps carry ids plus junk fields that must be stripped before the PUT. */
  const existingCase = {
    key: 'PROJ-T1',
    name: 'Login works',
    testScript: {
      type: 'STEP_BY_STEP',
      steps: [
        { id: 11, index: 0, description: 'old 1', testData: 'd1', expectedResult: 'r1', customFields: {}, attachments: [] },
        { id: 12, index: 1, description: 'old 2' },
      ],
    },
  };
  const cleanOld1 = { id: 11, description: 'old 1', testData: 'd1', expectedResult: 'r1' };
  const cleanOld2 = { id: 12, description: 'old 2' };

  function mockCase(getResponse: unknown) {
    const captured: { putBody?: any; putCount: number } = { putCount: 0 };
    mock.use(
      http.get(`${ATM}/testcase/PROJ-T1`, () => HttpResponse.json(getResponse as any)),
      http.put(`${ATM}/testcase/PROJ-T1`, async ({ request }) => {
        captured.putCount += 1;
        captured.putBody = await request.json();
        return HttpResponse.json({});
      }),
    );
    return captured;
  }

  it('appends by default, preserving existing step ids and stripping junk fields', async () => {
    const captured = mockCase(existingCase);
    const t = await createTestClient();
    const res = await t.call('add_test_steps', {
      testCaseKey: 'PROJ-T1',
      steps: [{ description: 'new step', expectedResult: 'ok' }],
    });
    expect(res.isError).toBe(false);
    expect(captured.putBody).toEqual({
      testScript: {
        type: 'STEP_BY_STEP',
        steps: [cleanOld1, cleanOld2, { description: 'new step', expectedResult: 'ok' }],
      },
    });
    expect(res.json).toEqual({ key: 'PROJ-T1', totalSteps: 3 });
    await t.close();
  });

  it('prepends when position="prepend"', async () => {
    const captured = mockCase(existingCase);
    const t = await createTestClient();
    const res = await t.call('add_test_steps', {
      testCaseKey: 'PROJ-T1',
      steps: [{ description: 'first now' }],
      position: 'prepend',
    });
    expect(captured.putBody.testScript.steps).toEqual([{ description: 'first now' }, cleanOld1, cleanOld2]);
    expect(res.json).toEqual({ key: 'PROJ-T1', totalSteps: 3 });
    await t.close();
  });

  it('inserts at a numeric 0-based index and clamps out-of-range indexes to the end', async () => {
    const captured = mockCase(existingCase);
    const t = await createTestClient();
    await t.call('add_test_steps', { testCaseKey: 'PROJ-T1', steps: [{ description: 'middle' }], position: 1 });
    expect(captured.putBody.testScript.steps).toEqual([cleanOld1, { description: 'middle' }, cleanOld2]);
    await t.call('add_test_steps', { testCaseKey: 'PROJ-T1', steps: [{ description: 'clamped' }], position: 99 });
    expect(captured.putBody.testScript.steps).toEqual([cleanOld1, cleanOld2, { description: 'clamped' }]);
    await t.close();
  });

  it('rejects non-STEP_BY_STEP scripts with a hint to use set_test_script, without writing', async () => {
    const captured = mockCase({ key: 'PROJ-T1', testScript: { type: 'PLAIN_TEXT', text: 'do things' } });
    const t = await createTestClient();
    const res = await t.call('add_test_steps', { testCaseKey: 'PROJ-T1', steps: [{ description: 'x' }] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/PLAIN_TEXT/);
    expect(res.text).toMatch(/set_test_script/);
    expect(captured.putCount).toBe(0);
    await t.close();
  });

  it('creates a STEP_BY_STEP script when the test case has no script at all', async () => {
    const captured = mockCase({ key: 'PROJ-T1', name: 'No script yet' });
    const t = await createTestClient();
    const res = await t.call('add_test_steps', { testCaseKey: 'PROJ-T1', steps: [{ description: 'the only step' }] });
    expect(res.isError).toBe(false);
    expect(captured.putBody).toEqual({
      testScript: { type: 'STEP_BY_STEP', steps: [{ description: 'the only step' }] },
    });
    expect(res.json).toEqual({ key: 'PROJ-T1', totalSteps: 1 });
    await t.close();
  });
});

describe('set_test_script', () => {
  it('PUTs the full testScript and returns { key, url }', async () => {
    let capturedBody: unknown;
    mock.use(
      http.put(`${ATM}/testcase/PROJ-T1`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({});
      }),
    );
    const t = await createTestClient();
    const res = await t.call('set_test_script', { testCaseKey: 'PROJ-T1', type: 'PLAIN_TEXT', text: 'Open the page.' });
    expect(res.isError).toBe(false);
    expect(capturedBody).toEqual({ testScript: { type: 'PLAIN_TEXT', text: 'Open the page.' } });
    expect(res.json).toEqual({ key: 'PROJ-T1', url: webUrl('PROJ-T1') });
    await t.close();
  });

  it('rejects an invalid combo (BDD without text) before any HTTP call', async () => {
    let requests = 0;
    mock.use(
      http.all(`${BASE_URL}/*`, () => {
        requests += 1;
        return HttpResponse.json({});
      }),
    );
    const t = await createTestClient();
    const res = await t.call('set_test_script', { testCaseKey: 'PROJ-T1', type: 'BDD' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/text is required/);
    expect(requests).toBe(0);
    await t.close();
  });
});

describe('delete_test_case', () => {
  it('maps a 204 to { deleted: true, key }', async () => {
    mock.use(http.delete(`${ATM}/testcase/PROJ-T1`, () => new HttpResponse(null, { status: 204 })));
    const t = await createTestClient();
    const res = await t.call('delete_test_case', { testCaseKey: 'PROJ-T1' });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ deleted: true, key: 'PROJ-T1' });
    await t.close();
  });
});

describe('create_test_cases_bulk', () => {
  it('fills per-item projectKey (item key wins over the shared param) and normalizes both response shapes', async () => {
    let capturedBody: unknown;
    mock.use(
      http.post(`${ATM}/testcase/bulk`, async ({ request }) => {
        capturedBody = await request.json();
        // Mixed shapes on purpose: [{key}] objects and bare string keys.
        return HttpResponse.json([{ key: 'ITEM-T1' }, 'SHARED-T2'], { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_cases_bulk', {
      projectKey: 'SHARED',
      testCases: [
        { projectKey: 'ITEM', name: 'One' },
        { name: 'Two', priority: 'High' },
      ],
    });
    expect(res.isError).toBe(false);
    expect(capturedBody).toEqual([
      { projectKey: 'ITEM', name: 'One' },
      { projectKey: 'SHARED', name: 'Two', priority: 'High' },
    ]);
    expect(res.json).toEqual([
      { key: 'ITEM-T1', url: webUrl('ITEM-T1') },
      { key: 'SHARED-T2', url: webUrl('SHARED-T2') },
    ]);
    await t.close();
  });

  it('errors without HTTP when an item resolves to no projectKey at all', async () => {
    const t = await createTestClient();
    const res = await t.call('create_test_cases_bulk', { testCases: [{ name: 'Orphan' }] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/projectKey is required/);
    await t.close();
  });
});

describe('link_issues_to_test_cases', () => {
  it('POSTs the links array and reports { linked: n } on an empty response', async () => {
    let capturedBody: unknown;
    mock.use(
      http.post(`${ATM}/testcase/link-issues`, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const t = await createTestClient();
    const links = [
      { testCaseKey: 'PROJ-T1', issueKey: 'PROJ-1' },
      { testCaseKey: 'PROJ-T2', issueKey: 'PROJ-1' },
    ];
    const res = await t.call('link_issues_to_test_cases', { links });
    expect(res.isError).toBe(false);
    expect(capturedBody).toEqual(links);
    expect(res.json).toEqual({ linked: 2 });
    await t.close();
  });

  it('rejects more than 2500 unique test case keys with zero HTTP requests', async () => {
    let requests = 0;
    mock.use(
      http.all(`${BASE_URL}/*`, () => {
        requests += 1;
        return HttpResponse.json({});
      }),
    );
    const links = Array.from({ length: 2501 }, (_, i) => ({ testCaseKey: `PROJ-T${i + 1}`, issueKey: 'PROJ-1' }));
    const t = await createTestClient();
    const res = await t.call('link_issues_to_test_cases', { links });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/2500/);
    expect(requests).toBe(0);
    await t.close();
  });
});

describe('get_test_cases_linked_to_issue', () => {
  it('passes the API response through', async () => {
    mock.use(
      http.get(`${ATM}/issuelink/PROJ-5/testcases`, () => HttpResponse.json([{ key: 'PROJ-T1' }, { key: 'PROJ-T2' }])),
    );
    const t = await createTestClient();
    const res = await t.call('get_test_cases_linked_to_issue', { issueKey: 'PROJ-5' });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual([{ key: 'PROJ-T1' }, { key: 'PROJ-T2' }]);
    await t.close();
  });
});
