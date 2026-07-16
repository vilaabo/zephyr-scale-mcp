import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, createTestClient } from './helpers.js';

const mock = setupServer();

beforeAll(() => mock.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

const FOLDER_URL = `${BASE_URL}/rest/atm/1.0/folder`;

describe('create_folder', () => {
  it('POSTs projectKey/name/type (no recursive field) and propagates the returned id', async () => {
    let capturedBody: unknown;
    mock.use(
      http.post(FOLDER_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: 123 }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_folder', { projectKey: 'PROJ', name: '/Regression/Payments', type: 'TEST_CASE' });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ id: 123, name: '/Regression/Payments', type: 'TEST_CASE' });
    expect(capturedBody).toEqual({ projectKey: 'PROJ', name: '/Regression/Payments', type: 'TEST_CASE' });
    await t.close();
  });

  it('falls back to the default project key', async () => {
    let capturedBody: any;
    mock.use(
      http.post(FOLDER_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: 9 }, { status: 201 });
      }),
    );
    const t = await createTestClient({ defaultProjectKey: 'DEF' });
    const res = await t.call('create_folder', { name: '/Smoke', type: 'TEST_RUN' });
    expect(res.isError).toBe(false);
    expect(capturedBody.projectKey).toBe('DEF');
    await t.close();
  });

  it('errors without any HTTP call when projectKey is missing everywhere', async () => {
    let calls = 0;
    mock.use(
      http.post(FOLDER_URL, () => {
        calls++;
        return HttpResponse.json({ id: 1 }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_folder', { name: '/Smoke', type: 'TEST_CASE' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/projectKey is required/);
    expect(calls).toBe(0);
    await t.close();
  });

  it('rejects a name without a leading "/" before any HTTP call', async () => {
    let calls = 0;
    mock.use(
      http.post(FOLDER_URL, () => {
        calls++;
        return HttpResponse.json({ id: 1 }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_folder', { projectKey: 'PROJ', name: 'Regression', type: 'TEST_CASE' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/must be a full folder path starting with/);
    expect(calls).toBe(0);
    await t.close();
  });

  it('creates missing parents on 400 and retries the full path (exact POST sequence)', async () => {
    const postedNames: string[] = [];
    let fullPathAttempts = 0;
    mock.use(
      http.post(FOLDER_URL, async ({ request }) => {
        const body = (await request.json()) as { name: string };
        postedNames.push(body.name);
        switch (body.name) {
          case '/a/b/c':
            fullPathAttempts++;
            if (fullPathAttempts === 1) {
              return HttpResponse.json({ errorMessages: ['Folder /a/b does not exist'] }, { status: 400 });
            }
            return HttpResponse.json({ id: 7 }, { status: 201 });
          case '/a':
            return HttpResponse.json({ errorMessages: ['Folder /a already exists'] }, { status: 400 });
          case '/a/b':
            return HttpResponse.json({ id: 5 }, { status: 201 });
          default:
            return HttpResponse.json({ errorMessages: [`unexpected folder ${body.name}`] }, { status: 500 });
        }
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_folder', { projectKey: 'PROJ', name: '/a/b/c', type: 'TEST_CASE' });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ id: 7, name: '/a/b/c', type: 'TEST_CASE' });
    expect(postedNames).toEqual(['/a/b/c', '/a', '/a/b', '/a/b/c']);
    await t.close();
  });

  it('recursive:false propagates the 400 after exactly one request', async () => {
    let calls = 0;
    mock.use(
      http.post(FOLDER_URL, () => {
        calls++;
        return HttpResponse.json({ errorMessages: ['Folder /a does not exist'] }, { status: 400 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_folder', { projectKey: 'PROJ', name: '/a/b', type: 'TEST_CASE', recursive: false });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Zephyr API error 400 \(POST \/rest\/atm\/1\.0\/folder\)/);
    expect(calls).toBe(1);
    await t.close();
  });

  it('returns isError when the recursive retry of the full path still fails', async () => {
    const postedNames: string[] = [];
    mock.use(
      http.post(FOLDER_URL, async ({ request }) => {
        const body = (await request.json()) as { name: string };
        postedNames.push(body.name);
        return HttpResponse.json({ errorMessages: ['nope'] }, { status: 400 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('create_folder', { projectKey: 'PROJ', name: '/x/y', type: 'TEST_PLAN' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Zephyr API error 400/);
    // initial full path, parent prefix "/x" (400 ignored), retried full path
    expect(postedNames).toEqual(['/x/y', '/x', '/x/y']);
    await t.close();
  });
});

describe('rename_folder', () => {
  it('PUTs the new name to /folder/{folderId} and returns { id, name }', async () => {
    let capturedBody: unknown;
    mock.use(
      http.put(`${FOLDER_URL}/123`, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('rename_folder', { folderId: 123, name: 'Payments' });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ id: 123, name: 'Payments' });
    expect(capturedBody).toEqual({ name: 'Payments' });
    await t.close();
  });

  it('includes customFields in the body only when provided', async () => {
    let capturedBody: unknown;
    mock.use(
      http.put(`${FOLDER_URL}/77`, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('rename_folder', { folderId: 77, name: 'Smoke', customFields: { Team: 'QA' } });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ id: 77, name: 'Smoke' });
    expect(capturedBody).toEqual({ name: 'Smoke', customFields: { Team: 'QA' } });
    await t.close();
  });

  it('rejects a name containing "/" before any HTTP call', async () => {
    let calls = 0;
    mock.use(
      http.put(`${FOLDER_URL}/1`, () => {
        calls++;
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('rename_folder', { folderId: 1, name: '/Regression/Payments' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not a path/);
    expect(calls).toBe(0);
    await t.close();
  });
});
