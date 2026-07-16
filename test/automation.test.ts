import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, createTestClient } from './helpers.js';

const mock = setupServer();

let tmpDir: string;

beforeAll(async () => {
  mock.listen({ onUnhandledRequest: 'error' });
  tmpDir = await mkdtemp(join(tmpdir(), 'zephyr-automation-test-'));
});
afterEach(() => mock.resetHandlers());
afterAll(async () => {
  mock.close();
  await rm(tmpDir, { recursive: true, force: true });
});

// Realistic-looking ZIP prefix (PK\x03\x04) followed by arbitrary payload bytes.
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);

describe('upload_automation_results', () => {
  it('posts the ZIP as multipart field "file" and passes the response through', async () => {
    const zipPath = join(tmpDir, 'results.zip');
    await writeFile(zipPath, ZIP_BYTES);
    let capturedUrl = '';
    let fileName = '';
    let fileBytes = Buffer.alloc(0);
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/automation/execution/PROJ`, async ({ request }) => {
        capturedUrl = request.url;
        const file = (await request.formData()).get('file') as File;
        fileName = file.name;
        fileBytes = Buffer.from(await file.arrayBuffer());
        return HttpResponse.json({ testCycle: { key: 'PROJ-C42', url: `${BASE_URL}/secure/Tests.jspa#/testrun/PROJ-C42` } });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('upload_automation_results', { projectKey: 'PROJ', filePath: zipPath, autoCreateTestCases: true });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ testCycle: { key: 'PROJ-C42', url: `${BASE_URL}/secure/Tests.jspa#/testrun/PROJ-C42` } });
    expect(fileName).toBe('results.zip');
    expect(fileBytes.equals(ZIP_BYTES)).toBe(true);
    const url = new URL(capturedUrl);
    expect(url.pathname).toBe('/rest/atm/1.0/automation/execution/PROJ');
    expect(url.searchParams.get('autoCreateTestCases')).toBe('true');
    await t.close();
  });

  it('omits autoCreateTestCases when not passed and reports { uploaded: true } for an empty response', async () => {
    const zipPath = join(tmpDir, 'plain.zip');
    await writeFile(zipPath, ZIP_BYTES);
    let capturedUrl = '';
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/automation/execution/PROJ`, ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse('', { status: 200 });
      }),
    );
    const t = await createTestClient({ defaultProjectKey: 'PROJ' });
    const res = await t.call('upload_automation_results', { filePath: zipPath });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ uploaded: true });
    expect(new URL(capturedUrl).searchParams.has('autoCreateTestCases')).toBe(false);
    await t.close();
  });

  it('fails with a clear error and makes no HTTP request when the ZIP does not exist', async () => {
    const missingPath = join(tmpDir, 'no-such-results.zip');
    let requests = 0;
    const onRequest = () => {
      requests += 1;
    };
    mock.events.on('request:start', onRequest);
    const t = await createTestClient();
    const res = await t.call('upload_automation_results', { projectKey: 'PROJ', filePath: missingPath });
    mock.events.removeListener('request:start', onRequest);
    expect(res.isError).toBe(true);
    expect(res.text).toContain(missingPath);
    expect(res.text).toMatch(/Cannot read the results ZIP/);
    expect(requests).toBe(0);
    await t.close();
  });

  it('propagates a 400 with the response body', async () => {
    const zipPath = join(tmpDir, 'bad.zip');
    await writeFile(zipPath, ZIP_BYTES);
    mock.use(
      http.post(
        `${BASE_URL}/rest/atm/1.0/automation/execution/PROJ`,
        () => new HttpResponse('Invalid ZIP archive: no result files found', { status: 400 }),
      ),
    );
    const t = await createTestClient();
    const res = await t.call('upload_automation_results', { projectKey: 'PROJ', filePath: zipPath });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/400/);
    expect(res.text).toMatch(/Invalid ZIP archive: no result files found/);
    await t.close();
  });
});

describe('upload_cucumber_results', () => {
  it('posts the ZIP to the /cucumber/ endpoint', async () => {
    const zipPath = join(tmpDir, 'cucumber.zip');
    await writeFile(zipPath, ZIP_BYTES);
    let capturedUrl = '';
    let fileName = '';
    let fileBytes = Buffer.alloc(0);
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/automation/execution/cucumber/PROJ`, async ({ request }) => {
        capturedUrl = request.url;
        const file = (await request.formData()).get('file') as File;
        fileName = file.name;
        fileBytes = Buffer.from(await file.arrayBuffer());
        return HttpResponse.json({ testCycle: { key: 'PROJ-C43' } });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('upload_cucumber_results', { projectKey: 'PROJ', filePath: zipPath, autoCreateTestCases: false });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ testCycle: { key: 'PROJ-C43' } });
    expect(fileName).toBe('cucumber.zip');
    expect(fileBytes.equals(ZIP_BYTES)).toBe(true);
    const url = new URL(capturedUrl);
    expect(url.pathname).toBe('/rest/atm/1.0/automation/execution/cucumber/PROJ');
    expect(url.searchParams.get('autoCreateTestCases')).toBe('false');
    await t.close();
  });
});

describe('download_feature_files', () => {
  it('writes the ZIP returned by the server and reports savedTo/bytes', async () => {
    const outputPath = join(tmpDir, 'features.zip');
    let capturedUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/automation/testcases`, ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(new Uint8Array(ZIP_BYTES), { headers: { 'Content-Type': 'application/zip' } });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('download_feature_files', { query: 'testCase.projectKey = "PROJ"', outputPath });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ savedTo: outputPath, bytes: ZIP_BYTES.length });
    expect((await readFile(outputPath)).equals(ZIP_BYTES)).toBe(true);
    expect(new URL(capturedUrl).searchParams.get('query')).toBe('testCase.projectKey = "PROJ"');
    await t.close();
  });

  it('propagates a 404 and writes no file (query omitted from the request)', async () => {
    const outputPath = join(tmpDir, 'never-written.zip');
    let capturedUrl = '';
    mock.use(
      http.get(`${BASE_URL}/rest/atm/1.0/automation/testcases`, ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse('Not Found', { status: 404 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('download_feature_files', { outputPath });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/404/);
    expect(new URL(capturedUrl).searchParams.has('query')).toBe(false);
    await expect(access(outputPath)).rejects.toThrow();
    await t.close();
  });
});
