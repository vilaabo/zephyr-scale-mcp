import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, createTestClient } from './helpers.js';

const mock = setupServer();

let tmpDir: string;
let reportPath: string;
const REPORT_CONTENT = 'attachment payload: report body';

beforeAll(async () => {
  mock.listen({ onUnhandledRequest: 'error' });
  tmpDir = await mkdtemp(join(tmpdir(), 'zephyr-attachments-'));
  reportPath = join(tmpDir, 'report.txt');
  await writeFile(reportPath, REPORT_CONTENT, 'utf8');
});
afterEach(() => mock.resetHandlers());
afterAll(async () => {
  mock.close();
  await rm(tmpDir, { recursive: true, force: true });
});

/** Count every request that reaches msw, to prove input validation fires before any HTTP call. */
function countRequests(): { count: () => number } {
  let hits = 0;
  mock.use(
    http.all(`${BASE_URL}/*`, () => {
      hits++;
      return HttpResponse.json({});
    }),
  );
  return { count: () => hits };
}

describe('upload_attachment', () => {
  it('POSTs multipart/form-data with the file to the test case endpoint (default fileName = basename)', async () => {
    let captured: { name: string; content: string } | undefined;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1/attachments`, async ({ request }) => {
        const form = await request.formData();
        const file = form.get('file');
        if (!(file instanceof File)) throw new Error("expected a 'file' form entry");
        captured = { name: file.name, content: await file.text() };
        return HttpResponse.json({ id: 77, filename: file.name }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('upload_attachment', { target: 'test_case', testCaseKey: 'PROJ-T1', filePath: reportPath });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ id: 77, filename: 'report.txt' });
    expect(captured).toEqual({ name: 'report.txt', content: REPORT_CONTENT });
    await t.close();
  });

  it('addresses a test case step and honors an explicit fileName override', async () => {
    let captured: { name: string; content: string } | undefined;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1/step/2/attachments`, async ({ request }) => {
        const form = await request.formData();
        const file = form.get('file') as File;
        captured = { name: file.name, content: await file.text() };
        return HttpResponse.json({ id: 78 }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('upload_attachment', {
      target: 'test_case',
      testCaseKey: 'PROJ-T1',
      stepIndex: 2,
      filePath: reportPath,
      fileName: 'evidence.log',
    });
    expect(res.isError).toBe(false);
    expect(captured).toEqual({ name: 'evidence.log', content: REPORT_CONTENT });
    await t.close();
  });

  it('uploads to a test run and falls back to { uploaded, fileName, size } on an empty API response', async () => {
    let fileSeen = false;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testrun/PROJ-R5/attachments`, async ({ request }) => {
        const form = await request.formData();
        fileSeen = form.get('file') instanceof File;
        return new HttpResponse(null, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('upload_attachment', { target: 'test_run', testRunKey: 'PROJ-R5', filePath: reportPath });
    expect(res.isError).toBe(false);
    expect(fileSeen).toBe(true);
    expect(res.json).toEqual({ uploaded: true, fileName: 'report.txt', size: REPORT_CONTENT.length });
    await t.close();
  });

  it('uploads to a test result step by numeric id', async () => {
    let captured: { name: string; content: string } | undefined;
    mock.use(
      http.post(`${BASE_URL}/rest/atm/1.0/testresult/123/step/0/attachments`, async ({ request }) => {
        const form = await request.formData();
        const file = form.get('file') as File;
        captured = { name: file.name, content: await file.text() };
        return HttpResponse.json({ id: 900 }, { status: 201 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('upload_attachment', { target: 'test_result', testResultId: 123, stepIndex: 0, filePath: reportPath });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ id: 900 });
    expect(captured).toEqual({ name: 'report.txt', content: REPORT_CONTENT });
    await t.close();
  });

  it('rejects stepIndex for target test_run before any HTTP call', async () => {
    const requests = countRequests();
    const t = await createTestClient();
    const res = await t.call('upload_attachment', { target: 'test_run', testRunKey: 'PROJ-R5', stepIndex: 1, filePath: reportPath });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/stepIndex is not supported when target is 'test_run'/);
    expect(requests.count()).toBe(0);
    await t.close();
  });

  it('rejects target test_case without testCaseKey', async () => {
    const requests = countRequests();
    const t = await createTestClient();
    const res = await t.call('upload_attachment', { target: 'test_case', filePath: reportPath });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/testCaseKey is required when target is 'test_case'/);
    expect(requests.count()).toBe(0);
    await t.close();
  });

  it('reports a nonexistent filePath (with the path in the message) without any HTTP call', async () => {
    const requests = countRequests();
    const missing = join(tmpDir, 'no-such-file.bin');
    const t = await createTestClient();
    const res = await t.call('upload_attachment', { target: 'test_case', testCaseKey: 'PROJ-T1', filePath: missing });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(missing);
    expect(requests.count()).toBe(0);
    await t.close();
  });

  it('propagates an API 404 from the upload endpoint', async () => {
    mock.use(
      http.post(
        `${BASE_URL}/rest/atm/1.0/testcase/PROJ-T404/attachments`,
        () => HttpResponse.json({ errorMessages: ['Test case not found'] }, { status: 404 }),
      ),
    );
    const t = await createTestClient();
    const res = await t.call('upload_attachment', { target: 'test_case', testCaseKey: 'PROJ-T404', filePath: reportPath });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/404/);
    expect(res.text).toMatch(/Test case not found/);
    await t.close();
  });
});

describe('list_attachments', () => {
  it('passes the test case response through unchanged', async () => {
    const attachments = [{ id: 1, filename: 'a.png', fileSize: 10 }, { id: 2, filename: 'b.txt', fileSize: 20 }];
    mock.use(http.get(`${BASE_URL}/rest/atm/1.0/testcase/PROJ-T1/attachments`, () => HttpResponse.json(attachments)));
    const t = await createTestClient();
    const res = await t.call('list_attachments', { target: 'test_case', testCaseKey: 'PROJ-T1' });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual(attachments);
    await t.close();
  });

  it('lists attachments of a test result by numeric id', async () => {
    const attachments = [{ id: 9, filename: 'screenshot.png' }];
    mock.use(http.get(`${BASE_URL}/rest/atm/1.0/testresult/321/attachments`, () => HttpResponse.json(attachments)));
    const t = await createTestClient();
    const res = await t.call('list_attachments', { target: 'test_result', testResultId: 321 });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual(attachments);
    await t.close();
  });
});

describe('delete_attachment', () => {
  it('maps a 204 response to { deleted: true, id }', async () => {
    let deletedPath = '';
    mock.use(
      http.delete(`${BASE_URL}/rest/atm/1.0/attachments/55`, ({ request }) => {
        deletedPath = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = await createTestClient();
    const res = await t.call('delete_attachment', { attachmentId: 55 });
    expect(res.isError).toBe(false);
    expect(res.json).toEqual({ deleted: true, id: 55 });
    expect(deletedPath).toBe('/rest/atm/1.0/attachments/55');
    await t.close();
  });
});
