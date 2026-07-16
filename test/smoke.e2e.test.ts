/**
 * Integration smoke scenario (spec §12). Runs ONLY when ZEPHYR_E2E=1, against a real
 * Jira DC instance with the Zephyr Scale plugin, using the regular env configuration
 * (JIRA_BASE_URL, JIRA_PAT/…, ZEPHYR_DEFAULT_PROJECT_KEY is required).
 *
 *   ZEPHYR_E2E=1 npm run smoke
 *
 * Note: the public API cannot delete folders, so the /mcp-smoke-* folders created by
 * this scenario remain on the instance and have to be removed via the UI if undesired.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createTestClient, type TestClient } from './helpers.js';

const enabled = process.env.ZEPHYR_E2E === '1';

describe.runIf(enabled)('smoke: full Zephyr Scale round-trip', () => {
  const cfg = enabled ? loadConfig() : undefined;
  const stamp = `mcp-smoke-${Date.now()}`;
  const folder = `/${stamp}`;

  let t: TestClient;
  let stepCaseKey: string;
  let plainCaseKey: string;
  let bddCaseKey: string;
  let runKey: string;

  const gherkin = 'Feature: Авторизация\n\nScenario: Успешный вход\n  Given открыта страница логина\n  When пользователь вводит валидные креды\n  Then открывается дашборд';

  beforeAll(async () => {
    if (!cfg?.defaultProjectKey) {
      throw new Error('ZEPHYR_DEFAULT_PROJECT_KEY must be set for the smoke scenario');
    }
    t = await createTestClient({ ...cfg, maxRetries: 2, retryBaseDelayMs: 500 });
  });

  it('health_check is green', async () => {
    const res = await t.call('health_check');
    expect(res.isError).toBe(false);
    expect(res.json.ok).toBe(true);
  });

  it('creates a test case folder', async () => {
    const res = await t.call('create_folder', { name: folder, type: 'TEST_CASE' });
    expect(res.isError).toBe(false);
    expect(res.json.id).toBeTypeOf('number');
  });

  it('creates test cases of all three script types', async () => {
    const step = await t.call('create_test_case', {
      name: `${stamp} step-by-step`,
      folder,
      testScript: {
        type: 'STEP_BY_STEP',
        steps: [
          { description: 'Открыть страницу логина', testData: 'URL: /login', expectedResult: 'Форма отображается' },
          { description: 'Ввести валидные креды', expectedResult: 'Открыт дашборд' },
        ],
      },
    });
    expect(step.isError).toBe(false);
    stepCaseKey = step.json.key;
    expect(stepCaseKey).toMatch(/-T\d+$/);

    const plain = await t.call('create_test_case', {
      name: `${stamp} plain-text`,
      folder,
      testScript: { type: 'PLAIN_TEXT', text: 'Открыть страницу логина и убедиться, что форма отображается.' },
    });
    expect(plain.isError).toBe(false);
    plainCaseKey = plain.json.key;

    const bdd = await t.call('create_test_case', {
      name: `${stamp} bdd`,
      folder,
      testScript: { type: 'BDD', text: gherkin },
    });
    expect(bdd.isError).toBe(false);
    bddCaseKey = bdd.json.key;
  });

  it('preserves Gherkin byte-for-byte', async () => {
    const res = await t.call('get_test_case', { testCaseKey: bddCaseKey });
    expect(res.json.testScript.text).toBe(gherkin);
  });

  it('finds all three cases by folder via TQL', async () => {
    const res = await t.call('search_test_cases', {
      query: `projectKey = "${cfg!.defaultProjectKey}" AND folder = "${folder}"`,
    });
    expect(res.isError).toBe(false);
    expect(res.json.count).toBe(3);
  });

  it('updates plain fields without touching the script', async () => {
    const res = await t.call('update_test_case', { testCaseKey: stepCaseKey, objective: 'Updated by smoke test' });
    expect(res.isError).toBe(false);
    const check = await t.call('get_test_case', { testCaseKey: stepCaseKey });
    expect(check.json.objective).toContain('Updated by smoke test');
    expect(check.json.testScript.steps).toHaveLength(2);
  });

  it('appends a step preserving the existing ones', async () => {
    const res = await t.call('add_test_steps', {
      testCaseKey: stepCaseKey,
      steps: [{ description: 'Выйти из системы', expectedResult: 'Открыта страница логина' }],
    });
    expect(res.isError).toBe(false);
    expect(res.json.totalSteps).toBe(3);
    const check = await t.call('get_test_case', { testCaseKey: stepCaseKey });
    expect(check.json.testScript.steps).toHaveLength(3);
    expect(check.json.testScript.steps[0].description).toContain('Открыть страницу логина');
  });

  it('changes the script type of the plain-text case', async () => {
    const res = await t.call('set_test_script', { testCaseKey: plainCaseKey, type: 'BDD', text: gherkin });
    expect(res.isError).toBe(false);
    const check = await t.call('get_test_case', { testCaseKey: plainCaseKey });
    expect(check.json.testScript.type).toBe('BDD');
  });

  it('creates a test run with items', async () => {
    await t.call('create_folder', { name: folder, type: 'TEST_RUN' });
    const res = await t.call('create_test_run', {
      name: `${stamp} run`,
      folder,
      items: [{ testCaseKey: stepCaseKey }, { testCaseKey: bddCaseKey }],
    });
    expect(res.isError).toBe(false);
    runKey = res.json.key;
    expect(runKey).toMatch(/-R\d+$/);
  });

  it('records a result with per-step statuses', async () => {
    const res = await t.call('create_test_result', {
      testRunKey: runKey,
      testCaseKey: stepCaseKey,
      status: 'Pass',
      executionTime: 60_000,
      scriptResults: [
        { index: 0, status: 'Pass' },
        { index: 1, status: 'Pass' },
        { index: 2, status: 'Pass' },
      ],
    });
    expect(res.isError).toBe(false);
  });

  it('updates the last result', async () => {
    const res = await t.call('update_last_test_result', {
      testRunKey: runKey,
      testCaseKey: stepCaseKey,
      comment: 'smoke: updated comment',
    });
    expect(res.isError).toBe(false);
  });

  it('reads paginated run results', async () => {
    const res = await t.call('get_test_run_results', { testRunKey: runKey });
    expect(res.isError).toBe(false);
    expect(res.json.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.json.values)).toBe(true);
  });

  it('cleans up: deletes the run and the test cases', async () => {
    expect((await t.call('delete_test_run', { testRunKey: runKey })).isError).toBe(false);
    for (const key of [stepCaseKey, plainCaseKey, bddCaseKey]) {
      expect((await t.call('delete_test_case', { testCaseKey: key })).isError).toBe(false);
    }
  });
});
