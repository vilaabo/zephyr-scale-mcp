# zephyr-scale-mcp

**MCP server for Zephyr Scale on self-hosted Jira Server / Data Center** — gives AI agents (Claude Code, Claude Desktop, Cursor and any other [MCP](https://modelcontextprotocol.io) client) full control over your test management: test cases, folders, test cycles, executions, test plans, attachments and automation — through the Zephyr Scale REST API v1 (`/rest/atm/1.0`).

[Русская версия →](README.ru.md)

![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue) ![Tests](https://img.shields.io/badge/tests-178%20passing-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue) ![API](https://img.shields.io/badge/Zephyr%20Scale-Server%2FDC%20v1-orange)

> ⚠️ This server targets **Zephyr Scale Server / Data Center** (formerly TM4J). Zephyr Scale **Cloud** (API v2) and Zephyr **Squad** are different APIs and are out of scope.

## Why

Most Zephyr MCP servers target the Cloud API. If your Jira lives on-premise, you are stuck — and the Server/DC API v1 has real teeth: test cycles are immutable after creation, folders can't be listed, statuses are case-sensitive internal names, BDD scripts reject `Feature:` headers, and older plugin builds are missing whole endpoints. This server knows all of that:

- **43 tools** covering the complete test-management lifecycle, each with an LLM-friendly description that encodes the API's constraints and pitfalls;
- **Composite tools for the API's blind spots** — `add_test_steps` safely merges steps (read → merge by id → write), `recreate_test_run_with_items` works around cycle immutability (optionally carrying the last results over), `clone_test_case`, `get_issue_test_coverage`, `get_test_run_summary`;
- **Graceful degradation on older plugin builds** — automatic fallback when the paginated results endpoint is missing, verified against a real 2018-era TM4J instance;
- **Production-grade plumbing** — retries with `Retry-After`, exponential backoff for GET, strict zod validation, typed error messages with actionable hints, secrets never reach logs or tool output, read-only mode;
- **178 unit & contract tests** (vitest + msw) plus a gated end-to-end smoke scenario.

## Quick start

Requirements: Node.js ≥ 20, Jira Server/DC with the Zephyr Scale plugin, a [Personal Access Token](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html) (Jira 8.14+) or username/password.

```bash
git clone https://github.com/vilaabo/zephyr-scale-mcp.git
cd zephyr-scale-mcp
npm install
npm run build        # → dist/index.js
```

Wire it into **Claude Code**:

```bash
claude mcp add zephyr-scale \
  --env JIRA_BASE_URL=https://jira.example.com \
  --env JIRA_PAT=<personal access token> \
  --env ZEPHYR_DEFAULT_PROJECT_KEY=PROJ \
  -- node /path/to/zephyr-scale-mcp/dist/index.js
```

or **Claude Desktop / any MCP client** (`claude_desktop_config.json` / `.mcp.json`):

```json
{
  "mcpServers": {
    "zephyr-scale": {
      "command": "node",
      "args": ["/path/to/zephyr-scale-mcp/dist/index.js"],
      "env": {
        "JIRA_BASE_URL": "https://jira.example.com",
        "JIRA_PAT": "<personal access token>",
        "ZEPHYR_DEFAULT_PROJECT_KEY": "PROJ"
      }
    }
  }
}
```

Then ask your agent to run `health_check` — it verifies connectivity, credentials and that the Zephyr plugin answers.

### Things you can ask your agent to do

- *"Create a folder `/Regression/Payments` and add step-by-step test cases for the checkout flow described in this document"*
- *"Find all Draft cases in `/Regression`, review them and mark the ready ones Approved"*
- *"Create a test cycle for sprint 42 with all smoke cases, then record the results from this report"*
- *"Which test cases cover issue PROJ-123 and when did they last pass?"*
- *"Add two steps to PROJ-T55 after step 3"* — existing steps survive, guaranteed
- *"Recreate cycle PROJ-R7 with three more cases, keep the results, delete the old one"*

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `JIRA_BASE_URL` | yes | — | Jira base URL without a trailing `/`, e.g. `https://jira.example.com` |
| `JIRA_AUTH` | no | `pat` | `pat` \| `basic` |
| `JIRA_PAT` | with `pat` | — | Jira DC Personal Access Token |
| `JIRA_USERNAME`, `JIRA_PASSWORD` | with `basic` | — | Basic-auth credentials |
| `JIRA_TIMEOUT_MS` | no | `30000` | Per-request timeout |
| `JIRA_MAX_RETRIES` | no | `2` | Retries for GET and for 429/503 responses |
| `JIRA_TLS_REJECT_UNAUTHORIZED` | no | `true` | `false` allows self-signed certificates (disables TLS verification process-wide; a warning is printed) |
| `ZEPHYR_DEFAULT_PROJECT_KEY` | no | — | Used when a tool is called without `projectKey` |
| `ZEPHYR_READONLY` | no | `false` | When `true`, write tools return an error |
| `ZEPHYR_ALLOW_INTERNAL_API` | no | `false` | Registers UNOFFICIAL tools backed by the internal `/rest/tests/1.0` API (unsupported by the vendor — use at your own risk) |
| `ZEPHYR_LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` (all logging goes to stderr) |

Secrets (`JIRA_PAT`, `JIRA_PASSWORD`) never appear in logs, tool output or error messages.

## Tools

<details>
<summary><b>Test cases</b> — 12 tools</summary>

| Tool | Description |
|---|---|
| `create_test_case` | Create a case with a STEP_BY_STEP / PLAIN_TEXT / BDD script, parameters, custom fields, Call-to-Test steps |
| `get_test_case` | Read a case (optionally restricted by `fields`) |
| `search_test_cases` | TQL search with pagination; auto-switches to POST for huge `IN` lists |
| `update_test_case` | Partial update; documents the step-id sync semantics |
| `add_test_steps` | Safely append/prepend/insert steps — read → merge by id → write, nothing gets lost |
| `set_test_script` | Replace the whole script / change its format |
| `clone_test_case` | Copy a case with its script (fresh step ids), fields and parameters |
| `delete_test_case` | Permanent delete |
| `create_test_cases_bulk` | Create many cases in one call |
| `link_issues_to_test_cases` | Bulk-link cases to Jira issues |
| `get_test_cases_linked_to_issue` | Reverse lookup: issue → cases |
| `get_issue_test_coverage` | Traceability report: issue → cases → their latest results |

</details>

<details>
<summary><b>Test cycles & results</b> — 11 tools</summary>

| Tool | Description |
|---|---|
| `create_test_run` | Create a cycle with its full item list — and optionally results in the same call |
| `get_test_run` / `search_test_runs` / `delete_test_run` | Read / TQL search / delete |
| `get_test_run_results` | Paginated results, with automatic fallback for older plugin builds |
| `get_test_run_summary` | Aggregated status counts, progress %, pass rate |
| `recreate_test_run_with_items` | The workaround for cycle immutability: rebuild with added/removed cases, carry the last results over, optionally delete the original |
| `create_test_result` | New execution, incl. per-step `scriptResults` |
| `update_last_test_result` | Partial update of the latest execution |
| `create_test_results_bulk` | Many results in one call |
| `get_latest_result_for_test_case` | Latest execution across all cycles |

</details>

<details>
<summary><b>Test plans, folders, attachments, automation</b> — 14 tools</summary>

| Tool | Description |
|---|---|
| `create_test_plan` / `get_test_plan` / `update_test_plan` / `delete_test_plan` / `search_test_plans` | Full test-plan CRUD + TQL search |
| `create_folder` | Create case/plan/cycle folders; missing parents are created automatically |
| `rename_folder` | Rename by numeric id |
| `upload_attachment` | Attach a local file to a case, case step, cycle, result or result step (multipart) |
| `list_attachments` / `download_attachment` / `delete_attachment` | Manage and fetch attachments |
| `upload_automation_results` | Publish a ZIP of Zephyr-format automation results (creates a cycle) |
| `upload_cucumber_results` | Publish a ZIP of Cucumber JSON reports |
| `download_feature_files` | Export BDD cases as a ZIP of `.feature` files |

</details>

<details>
<summary><b>Service tools</b> — 4 tools</summary>

| Tool | Description |
|---|---|
| `health_check` | Verifies Jira availability, credentials and the Zephyr plugin |
| `list_environments` / `create_environment` | Project environments |
| `find_jira_user` | Resolve the Jira **user key** (`JIRAUSER…`) required by owner/executedBy/assignedTo fields |

</details>

<details>
<summary><b>UNOFFICIAL (internal API, opt-in)</b> — 2 tools</summary>

Registered only with `ZEPHYR_ALLOW_INTERNAL_API=true`. Backed by the internal `/rest/tests/1.0` API, which the vendor does not support — endpoints may differ or be absent on any version.

| Tool | Description |
|---|---|
| `get_folder_tree` | The complete folder tree with numeric ids (the public API cannot list folders at all) |
| `get_status_options` | The exact internal names of the project's case/execution statuses and priorities — the values the API silently expects |

</details>

## Server/DC API v1 — what this server protects you from

1. **Cycles are immutable.** No `PUT /testrun` exists: you cannot rename a cycle or change its cases. The item list is set only at creation — `recreate_test_run_with_items` is the escape hatch.
2. **Folders are never auto-created** and cannot be listed publicly; renaming needs a numeric id (returned by `create_folder`, or use `get_folder_tree`).
3. **`owner` / `executedBy` / `assignedTo` take a Jira user key** (`JIRAUSER10000`) — not a username, not an e-mail. `find_jira_user` resolves it.
4. **TQL is strict**: mandatory spaces around operators, double-quoted strings, `AND` only. Cycles are searchable only by `projectKey` and `folder`.
5. **Statuses/priorities are case-sensitive internal names.** The UI shows localized labels for the built-ins (`Draft` may render as something else in your language) while custom statuses use their literal names — `get_status_options` shows the truth.
6. **BDD scripts are the scenario body only** — bare `Given/When/Then/And/But` lines. Texts wrapped in `Feature:`/`Scenario:` headers are rejected with `400 Invalid BDD Script`; the wrapper is generated on export.
7. **Step editing is id-based sync**: on `PUT`, steps without an id are created, steps with an id updated, and existing steps missing from the list are **deleted**. `add_test_steps` handles the read-merge-write for you.
8. Deprecated API fields (`issueKey`, `executionDate`, `userKey`) are intentionally not accepted.

### Older plugin builds (tested against a real legacy instance)

- Cycle keys may use the `-C` prefix (`PROJ-C34`) instead of `-R` — handled transparently.
- `GET /testrun/{key}/testresults/page` may not exist — the server automatically falls back to the flat endpoint and paginates client-side (the response carries a `note`).
- A result's overall `status` may be ignored when sent together with `scriptResults` — send the step results first, then set the overall status via `update_last_test_result`.
- `POST /testcase/link-issues` may answer 500 — link through `update_test_case` with `issueLinks` instead.
- The custom automation-results format may be strictly validated: `{"version": 1, "executions": [{"source", "result", "testCase": {"key"}}]}` works, while extra per-execution fields (e.g. `executionTime`) are rejected with `Invalid Custom Format JSON file`. Cucumber JSON reports (scenario tagged `@TestCaseKey=PROJ-T1`) work as-is.

## Development

```bash
npm run typecheck    # tsc --noEmit (strict)
npm test             # 178 unit + contract tests (vitest + msw), no network
npm run smoke        # end-to-end scenario against a real instance (ZEPHYR_E2E=1)
```

```
src/
├── index.ts        # bootstrap: config, tool registration, stdio transport
├── config.ts       # env validation
├── http.ts         # fetch wrapper: auth, timeouts, retries, error normalization
├── schemas.ts      # shared zod schemas (steps, scripts, result fields, TQL help)
├── toolkit.ts      # defineTool(): strict input, read-only guard, response shaping
├── runResults.ts   # results pagination with legacy fallback
└── tools/          # testCases, folders, testRuns, testResults, testPlans,
                    # attachments, automation, runMaintenance, misc
```

Stdout is reserved for the MCP protocol; all logging goes to stderr.

## License

[MIT](LICENSE)
