import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, createTestClient } from './helpers.js';

const mock = setupServer();

beforeAll(() => mock.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

describe('create_test_plan', () => {
  it('sends a minimal body of exactly projectKey and name and returns { key } without url', async () => {
    let capturedBody: unknown;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testplan`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'PROJ-P123' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_plan', { projectKey: 'PROJ', name: 'Release plan' });
    expect(res.isError).toBe(false);
    expect(capturedBody).toEqual({ projectKey: 'PROJ', name: 'Release plan' });
    expect(res.json).toEqual({ key: 'PROJ-P123' });
    expect(res.json).not.toHaveProperty('url');
    await t.close();
  });

  it('passes a full body through exactly (deep equality — no extra keys, no dropped fields)', async () => {
    let capturedBody: unknown;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testplan`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'PROJ-P42' }, { status: 201 });
      }),
    );
    const args = {
      projectKey: 'PROJ',
      name: 'Релиз 2026.07',
      objective: '<p>Проверить релизный контур</p>',
      folder: '/Releases/2026',
      status: 'Approved',
      owner: 'JIRAUSER10100',
      labels: ['release', 'smoke'],
      issueLinks: ['PROJ-123', 'PROJ-456'],
      customFields: { Reviewer: 'QA Lead' },
    };
    const t = await createTestClient();
    const res = await t.call('create_test_plan', args);
    expect(res.isError).toBe(false);
    // Deep equality: optionals that were not passed must be absent from the body.
    expect(capturedBody).toEqual(args);
    expect(res.json).toEqual({ key: 'PROJ-P42' });
    await t.close();
  });

  it('falls back to ZEPHYR_DEFAULT_PROJECT_KEY when projectKey is omitted', async () => {
    let capturedBody: unknown;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testplan`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: 'DEF-P9' }, { status: 201 });
      }),
    );
    const t = await createTestClient({ defaultProjectKey: 'DEF' });
    const res = await t.call('create_test_plan', { name: 'Nightly plan' });
    expect(res.isError).toBe(false);
    expect(capturedBody).toEqual({ projectKey: 'DEF', name: 'Nightly plan' });
    await t.close();
  });

  it('errors without any HTTP call when projectKey is missing and no default is configured', async () => {
    let called = false;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testplan`, () => {
        called = true;
        return HttpResponse.json({ key: 'PROJ-P1' }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_plan', { name: 'Orphan plan' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/projectKey is required/);
    expect(called).toBe(false);
    await t.close();
  });

  it('propagates a 400 for a missing folder with the response body and the create_folder hint', async () => {
    mock.use(
      http.post(
        `${BASE_URL}/rest/atm/1.0/testplan`,
        () => HttpResponse.json({ errorMessages: ['The folder /Releases/2026 does not exist'] }, { status: 400 }),
      ),
    );
    const t = await createTestClient();
    const res = await t.call('create_test_plan', { projectKey: 'PROJ', name: 'Plan', folder: '/Releases/2026' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Zephyr API error 400 \(POST \/rest\/atm\/1\.0\/testplan\)/);
    expect(res.text).toMatch(/The folder \/Releases\/2026 does not exist/);
    expect(res.text).toMatch(/create_folder/);
    await t.close();
  });
});

describe('get_test_plan', () => {
  it('fetches by key and serializes fields comma-separated', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testplan/PROJ-P7`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ key: 'PROJ-P7', name: 'Release plan', status: 'Approved' });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('get_test_plan', { testPlanKey: 'PROJ-P7', fields: ['key', 'name', 'status'] });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ key: 'PROJ-P7', name: 'Release plan', status: 'Approved' });
    expect(new URL(capturedUrl).searchParams.get('fields')).toBe('key,name,status');
    await t.close();
  });

  it('omits the fields query parameter when not requested', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testplan/PROJ-P7`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ key: 'PROJ-P7' });
      }),
    );
    const t = await createTestClient();
    await t.call('get_test_plan', { testPlanKey: 'PROJ-P7' });
    expect(new URL(capturedUrl).searchParams.has('fields')).toBe(false);
    await t.close();
  });

  it('propagates a 404 with the entity-not-found hint', async () => {
    mock.use(
      http.get(
        `${BASE_URL}/rest/atm/1.0/testplan/PROJ-P404`,
        () => HttpResponse.json({ errorMessages: ['Test plan PROJ-P404 does not exist'] }, { status: 404 }),
      ),
    );
    const t = await createTestClient();
    const res = await t.call('get_test_plan', { testPlanKey: 'PROJ-P404' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Zephyr API error 404/);
    expect(res.text).toMatch(/Entity not found/);
    await t.close();
  });
});

describe('update_test_plan', () => {
  it('sends only the passed fields (partial update) and returns { key }', async () => {
    let capturedBody: unknown;
    mock.use(
      http.put(`${BASE_URL}/rest/atm/1.0/testplan/PROJ-P5`, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('update_test_plan', {
      testPlanKey: 'PROJ-P5',
      status: 'Deprecated',
      objective: '<p>Outdated</p>',
    });
    expect(res.isError).toBe(false);
    // Only the passed fields — no name, folder, owner, labels, … placeholders.
    expect(capturedBody).toEqual({ status: 'Deprecated', objective: '<p>Outdated</p>' });
    expect(res.json).toEqual({ key: 'PROJ-P5' });
    await t.close();
  });

  it('propagates a 400 without producing a success envelope', async () => {
    mock.use(
      http.put(
        `${BASE_URL}/rest/atm/1.0/testplan/PROJ-P5`,
        () => HttpResponse.json({ errorMessages: ['Status Bogus is not valid'] }, { status: 400 }),
      ),
    );
    const t = await createTestClient();
    const res = await t.call('update_test_plan', { testPlanKey: 'PROJ-P5', status: 'Bogus' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Zephyr API error 400 \(PUT \/rest\/atm\/1\.0\/testplan\/PROJ-P5\)/);
    expect(res.text).not.toContain('"key": "PROJ-P5"');
    expect(res.json).toBeUndefined();
    await t.close();
  });
});

describe('delete_test_plan', () => {
  it('maps a 204 response to { deleted: true, key }', async () => {
    let called = false;
    mock.use(
      http.delete(`${BASE_URL}/rest/atm/1.0/testplan/PROJ-P3`, () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('delete_test_plan', { testPlanKey: 'PROJ-P3' });
    expect(res.isError).toBe(false);
    expect(called).toBe(true);
    expect(res.json).toEqual({ deleted: true, key: 'PROJ-P3' });
    await t.close();
  });

  it('propagates a 404 for an unknown test plan', async () => {
    mock.use(
      http.delete(
        `${BASE_URL}/rest/atm/1.0/testplan/PROJ-P404`,
        () => HttpResponse.json({ errorMessages: ['Test plan PROJ-P404 does not exist'] }, { status: 404 }),
      ),
    );
    const t = await createTestClient();
    const res = await t.call('delete_test_plan', { testPlanKey: 'PROJ-P404' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Zephyr API error 404/);
    await t.close();
  });
});

describe('search_test_plans', () => {
  it('sends query params and returns the page envelope (isLast=false when the page is full)', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testplan/search`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([{ key: 'PROJ-P1' }, { key: 'PROJ-P2' }]);
      }),
    );
    const t = await createTestClient();
    const res = await t.call('search_test_plans', {
      query: 'projectKey = "PROJ" AND status = "Approved"',
      fields: ['key', 'name'],
      startAt: 0,
      maxResults: 2,
    });
    expect(res.isError).toBe(false);
    const params = new URL(capturedUrl).searchParams;
    expect(params.get('query')).toBe('projectKey = "PROJ" AND status = "Approved"');
    expect(params.get('fields')).toBe('key,name');
    expect(params.get('startAt')).toBe('0');
    expect(params.get('maxResults')).toBe('2');
    expect(res.json).toEqual({
      startAt: 0,
      maxResults: 2,
      count: 2,
      isLast: false, // values.length === maxResults -> there may be more pages
      values: [{ key: 'PROJ-P1' }, { key: 'PROJ-P2' }],
    });
    await t.close();
  });

  it('defaults startAt=0 and maxResults=50 and reports isLast=true on a short page', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testplan/search`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([{ key: 'PROJ-P1' }]);
      }),
    );
    const t = await createTestClient();
    const res = await t.call('search_test_plans', { query: 'projectKey = "PROJ"' });
    const params = new URL(capturedUrl).searchParams;
    expect(params.get('startAt')).toBe('0');
    expect(params.get('maxResults')).toBe('50');
    expect(params.has('fields')).toBe(false);
    expect(res.json).toMatchObject({ startAt: 0, maxResults: 50, count: 1, isLast: true });
    await t.close();
  });

  it('propagates a 400 for an invalid TQL query with the TQL hint', async () => {
    mock.use(
      http.get(
        `${BASE_URL}/rest/atm/1.0/testplan/search`,
        () => HttpResponse.json({ errorMessages: ['Invalid TQL query'] }, { status: 400 }),
      ),
    );
    const t = await createTestClient();
    const res = await t.call('search_test_plans', { query: 'projectKey="PROJ"' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Zephyr API error 400/);
    expect(res.text).toMatch(/TQL syntax is strict/);
    await t.close();
  });
});
