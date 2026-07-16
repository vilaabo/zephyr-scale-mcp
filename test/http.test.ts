import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NetworkError, ZephyrApiError, atm, zephyrFetch } from '../src/http.js';
import { BASE_URL, testConfig } from './helpers.js';

const mock = setupServer();

beforeAll(() => mock.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

describe('zephyrFetch', () => {
  it('sends Bearer auth and Accept headers and parses JSON', async () => {
    let capturedAuth: string | null = null;
    let capturedAccept: string | null = null;
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1`, ({ request }) => {
        capturedAuth = request.headers.get('authorization');
        capturedAccept = request.headers.get('accept');
        return HttpResponse.json({ key: 'PROJ-T1' });
      }),
    );
    const res = await zephyrFetch(testConfig(), { method: 'GET', path: atm('/testcase/PROJ-T1') });
    expect(res).toEqual({ key: 'PROJ-T1' });
    expect(capturedAuth).toBe('Bearer test-secret-token');
    expect(capturedAccept).toBe('application/json');
  });

  it('sends Basic auth when configured', async () => {
    let capturedAuth: string | null = null;
    mock.use(
      http.get(`${BASE_URL}/rest/api/2/myself`, ({ request }) => {
        capturedAuth = request.headers.get('authorization');
        return HttpResponse.json({});
      }),
    );
    await zephyrFetch(testConfig({ auth: 'basic', username: 'user', password: 'pa:ss' }), {
      method: 'GET',
      path: '/rest/api/2/myself',
    });
    expect(capturedAuth).toBe(`Basic ${Buffer.from('user:pa:ss').toString('base64')}`);
  });

  it('serializes query params and omits undefined ones', async () => {
    let capturedUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/search`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      }),
    );
    await zephyrFetch(testConfig(), {
      method: 'GET',
      path: atm('/testcase/search'),
      query: { query: 'projectKey = "PROJ"', startAt: 0, maxResults: 50, fields: undefined },
    });
    const url = new URL(capturedUrl);
    expect(url.searchParams.get('query')).toBe('projectKey = "PROJ"');
    expect(url.searchParams.get('startAt')).toBe('0');
    expect(url.searchParams.has('fields')).toBe(false);
  });

  it('returns {} for 204 responses', async () => {
    mock.use(http.delete(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1`, () => new HttpResponse(null, { status: 204 })));
    const res = await zephyrFetch(testConfig(), { method: 'DELETE', path: atm('/testcase/PROJ-T1') });
    expect(res).toEqual({});
  });

  it('retries 429 for POST honoring Retry-After', async () => {
    let attempts = 0;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testcase`, () => {
        attempts += 1;
        if (attempts < 3) {
          return new HttpResponse('rate limited', { status: 429, headers: { 'Retry-After': '0' } });
        }
        return HttpResponse.json({ key: 'PROJ-T2' }, { status: 201 });
      }),
    );
    const res = await zephyrFetch(testConfig({ maxRetries: 2 }), { method: 'POST', path: atm('/testcase'), body: {} });
    expect(res).toEqual({ key: 'PROJ-T2' });
    expect(attempts).toBe(3);
  });

  it('retries 5xx for GET but not for POST', async () => {
    let getAttempts = 0;
    let postAttempts = 0;
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1`, () => {
        getAttempts += 1;
        return getAttempts < 2 ? new HttpResponse('boom', { status: 500 }) : HttpResponse.json({ key: 'PROJ-T1' });
      }),
      http.post(`${BASE_URL}/rest/atm/1.0/testcase`, () => {
        postAttempts += 1;
        return new HttpResponse('boom', { status: 500 });
      }),
    );
    const cfg = testConfig({ maxRetries: 2 });
    await expect(zephyrFetch(cfg, { method: 'GET', path: atm('/testcase/PROJ-T1') })).resolves.toEqual({ key: 'PROJ-T1' });
    await expect(zephyrFetch(cfg, { method: 'POST', path: atm('/testcase'), body: {} })).rejects.toThrow(ZephyrApiError);
    expect(postAttempts).toBe(1);
  });

  it('gives up after maxRetries', async () => {
    let attempts = 0;
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1`, () => {
        attempts += 1;
        return new HttpResponse('boom', { status: 500 });
      }),
    );
    await expect(
      zephyrFetch(testConfig({ maxRetries: 1 }), { method: 'GET', path: atm('/testcase/PROJ-T1') }),
    ).rejects.toThrow(/Zephyr API error 500 \(GET \/rest\/atm\/1\.0\/testcase\/PROJ-T1\)/);
    expect(attempts).toBe(2);
  });

  it('formats API errors with method, path and body', async () => {
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testcase`, () =>
        HttpResponse.json({ errorMessages: ['Folder /Nope does not exist'] }, { status: 400 }),
      ),
    );
    try {
      await zephyrFetch(testConfig(), { method: 'POST', path: atm('/testcase'), body: {} });
      expect.unreachable();
    } catch (err) {
      const e = err as ZephyrApiError;
      expect(e).toBeInstanceOf(ZephyrApiError);
      expect(e.status).toBe(400);
      expect(e.message).toContain('Zephyr API error 400 (POST /rest/atm/1.0/testcase)');
      expect(e.message).toContain('Folder /Nope does not exist');
      expect(e.message).toContain('create_folder');
    }
  });

  it('truncates huge error bodies to 2 KB', async () => {
    mock.use(http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1`, () => new HttpResponse('x'.repeat(10_000), { status: 400 })));
    try {
      await zephyrFetch(testConfig(), { method: 'GET', path: atm('/testcase/PROJ-T1') });
      expect.unreachable();
    } catch (err) {
      const e = err as ZephyrApiError;
      expect(e.responseBody.length).toBeLessThan(2100);
      expect(e.responseBody).toContain('[truncated]');
    }
  });

  it('hints about authentication on 401', async () => {
    mock.use(http.get(`${BASE_URL}/rest/api/2/myself`, () => new HttpResponse('', { status: 401 })));
    await expect(zephyrFetch(testConfig(), { method: 'GET', path: '/rest/api/2/myself' })).rejects.toThrow(/JIRA_PAT/);
  });

  it('detects HTML 404 as an unreachable Zephyr plugin', async () => {
    mock.use(
      http.get(
        `${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1`,
        () => new HttpResponse('<html><body>Not found</body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }),
      ),
    );
    await expect(zephyrFetch(testConfig(), { method: 'GET', path: atm('/testcase/PROJ-T1') })).rejects.toThrow(
      /plugin is probably not reachable/,
    );
  });

  it('does not leak query strings or secrets into error messages', async () => {
    mock.use(http.get(`${BASE_URL}/rest/atm/1.0/testcase/search`, () => new HttpResponse('bad tql', { status: 400 })));
    try {
      await zephyrFetch(testConfig(), { method: 'GET', path: atm('/testcase/search'), query: { query: 'oops' } });
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('oops');
      expect(message).not.toContain('test-secret-token');
    }
  });

  it('fails with NetworkError on timeout after retrying GET', async () => {
    let attempts = 0;
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1`, async () => {
        attempts += 1;
        await delay(500);
        return HttpResponse.json({});
      }),
    );
    await expect(
      zephyrFetch(testConfig({ timeoutMs: 50, maxRetries: 1 }), { method: 'GET', path: atm('/testcase/PROJ-T1') }),
    ).rejects.toThrow(NetworkError);
    expect(attempts).toBe(2);
  });
});
