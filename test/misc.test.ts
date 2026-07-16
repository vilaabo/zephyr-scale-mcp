import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, createTestClient } from './helpers.js';

const mock = setupServer();

beforeAll(() => mock.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

describe('health_check', () => {
  it('reports the Jira user without touching Zephyr when no default project is set', async () => {
    mock.use(http.get(`${BASE_URL}/rest/api/2/myself`, () => HttpResponse.json({ name: 'vladimir', displayName: 'Vladimir' })));
    const t = await createTestClient();
    const res = await t.call('health_check');
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ ok: true, jiraUser: 'vladimir', baseUrl: BASE_URL });
    await t.close();
  });

  it('probes the Zephyr plugin when a default project is configured', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/api/2/myself`, () => HttpResponse.json({ name: 'vladimir' })),
      http.get(`${BASE_URL}/rest/atm/1.0/environments`, () => HttpResponse.json([])),
    );
    const t = await createTestClient({ defaultProjectKey: 'PROJ' });
    const res = await t.call('health_check');
    expect(res.json.zephyrPluginReachable).toBe(true);
    await t.close();
  });

  it('reports zephyrPluginReachable=false when /rest/atm answers with an HTML 404', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/api/2/myself`, () => HttpResponse.json({ name: 'vladimir' })),
      http.get(
        `${BASE_URL}/rest/atm/1.0/environments`,
        () => new HttpResponse('<html>nope</html>', { status: 404, headers: { 'Content-Type': 'text/html' } }),
      ),
    );
    const t = await createTestClient({ defaultProjectKey: 'PROJ' });
    const res = await t.call('health_check');
    expect(res.json).toMatchObject({ ok: true, zephyrPluginReachable: false });
    await t.close();
  });

  it('returns isError with an auth hint when credentials are rejected', async () => {
    mock.use(http.get(`${BASE_URL}/rest/api/2/myself`, () => new HttpResponse('', { status: 401 })));
    const t = await createTestClient();
    const res = await t.call('health_check');
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/401/);
    expect(res.text).toMatch(/JIRA_PAT/);
    await t.close();
  });
});

describe('find_jira_user', () => {
  it('passes the query and maps the response to key/name/displayName/emailAddress', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/api/2/user/search`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([
          { key: 'JIRAUSER10100', name: 'vpupkin', displayName: 'Vasya Pupkin', emailAddress: 'v@x.com', avatarUrls: {} },
        ]);
      }),
    );
    const t = await createTestClient();
    const res = await t.call('find_jira_user', { query: 'pupkin', maxResults: 5 });
    expect(res.json).toEqual([
      { key: 'JIRAUSER10100', name: 'vpupkin', displayName: 'Vasya Pupkin', emailAddress: 'v@x.com' },
    ]);
    const url = new URL(capturedUrl);
    expect(url.searchParams.get('username')).toBe('pupkin');
    expect(url.searchParams.get('maxResults')).toBe('5');
    await t.close();
  });
});

describe('environments', () => {
  it('list_environments requires a project key when no default is configured', async () => {
    const t = await createTestClient();
    const res = await t.call('list_environments');
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/projectKey is required/);
    await t.close();
  });

  it('list_environments falls back to the default project key', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/environments`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([{ id: 1, name: 'Chrome' }]);
      }),
    );
    const t = await createTestClient({ defaultProjectKey: 'PROJ' });
    const res = await t.call('list_environments');
    expect(res.json).toEqual([{ id: 1, name: 'Chrome' }]);
    expect(new URL(capturedUrl).searchParams.get('projectKey')).toBe('PROJ');
    await t.close();
  });

  it('create_environment sends a compact body', async () => {
    let capturedBody: unknown;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/environments`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: 42 }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_environment', { projectKey: 'PROJ', name: 'Firefox' });
    expect(res.json).toEqual({ id: 42 });
    expect(capturedBody).toEqual({ projectKey: 'PROJ', name: 'Firefox' });
    await t.close();
  });
});

describe('server behavior', () => {
  it('rejects unknown arguments (strict schemas)', async () => {
    const t = await createTestClient();
    const res = await t.call('health_check', { unexpected: true });
    expect(res.isError).toBe(true);
    await t.close();
  });

  it('blocks write tools in read-only mode but allows reads', async () => {
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/environments`, () => HttpResponse.json([])),
    );
    const t = await createTestClient({ readonly: true, defaultProjectKey: 'PROJ' });
    const write = await t.call('create_environment', { name: 'X' });
    expect(write.isError).toBe(true);
    expect(write.text).toMatch(/read-only mode/);
    const read = await t.call('list_environments');
    expect(read.isError).toBe(false);
    await t.close();
  });
});
