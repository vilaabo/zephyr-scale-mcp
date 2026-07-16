# zephyr-scale-mcp

MCP-сервер (Model Context Protocol) для **Zephyr Scale** на self-hosted **Jira Server / Data Center** (бывш. TM4J / Kanoah). Даёт ИИ-агентам (Claude Code, Claude Desktop и другим MCP-клиентам) инструменты для управления тестовой моделью через REST API v1 (`{JIRA_BASE_URL}/rest/atm/1.0`).

> Zephyr Scale **Cloud** (API v2) и Zephyr **Squad** — другие API, этим сервером **не поддерживаются**.

## Возможности

| Группа | Инструменты |
|---|---|
| Тест-кейсы | `create_test_case`, `get_test_case`, `search_test_cases` (TQL, GET/POST), `update_test_case`, `add_test_steps`, `set_test_script`, `delete_test_case`, `create_test_cases_bulk`, `link_issues_to_test_cases`, `get_test_cases_linked_to_issue` |
| Папки | `create_folder` (с рекурсивным созданием цепочки), `rename_folder` |
| Тест-циклы | `create_test_run` (с items и результатами), `get_test_run`, `search_test_runs`, `delete_test_run`, `get_test_run_results` (постранично), `recreate_test_run_with_items` (обход неизменяемости циклов) |
| Результаты | `create_test_result`, `update_last_test_result`, `create_test_results_bulk`, `get_latest_result_for_test_case` |
| Тест-планы | `create_test_plan`, `get_test_plan`, `update_test_plan`, `delete_test_plan`, `search_test_plans` |
| Вложения | `upload_attachment`, `list_attachments`, `delete_attachment` (кейс / шаг кейса / цикл / результат / шаг результата, multipart) |
| Автоматизация | `upload_automation_results`, `upload_cucumber_results` (zip), `download_feature_files` (zip с .feature) |
| Сервисные | `list_environments`, `create_environment`, `find_jira_user`, `health_check` |
| UNOFFICIAL | `get_folder_tree` — листинг дерева папок через internal API; регистрируется только при `ZEPHYR_ALLOW_INTERNAL_API=true` |

Поддерживаются все три формата скриптов тест-кейсов: **STEP_BY_STEP**, **PLAIN_TEXT**, **BDD (Gherkin)**, включая шаги Call to Test (`steps[].testCaseKey`) и параметры (§`parameters`).

## Требования

- Node.js ≥ 20
- Jira Server / Data Center с установленным плагином Zephyr Scale
- Персональный токен Jira DC (PAT, Jira 8.14+) или логин/пароль

## Установка и сборка

```bash
git clone <repo-url> zephyr-scale-mcp
cd zephyr-scale-mcp
npm install
npm run build        # → dist/index.js
```

## Конфигурация (переменные окружения)

| Переменная | Обяз. | Default | Назначение |
|---|---|---|---|
| `JIRA_BASE_URL` | да | — | Базовый URL Jira без завершающего `/`, напр. `https://jira.example.com` |
| `JIRA_AUTH` | нет | `pat` | `pat` \| `basic` |
| `JIRA_PAT` | при `pat` | — | Персональный токен доступа Jira DC |
| `JIRA_USERNAME`, `JIRA_PASSWORD` | при `basic` | — | Логин/пароль |
| `JIRA_TIMEOUT_MS` | нет | `30000` | Таймаут одного HTTP-запроса |
| `JIRA_MAX_RETRIES` | нет | `2` | Повторы для GET и для ответов 429/503 |
| `JIRA_TLS_REJECT_UNAUTHORIZED` | нет | `true` | `false` разрешает самоподписанные сертификаты (отключает проверку TLS **для всех** запросов процесса; в stderr выводится предупреждение) |
| `ZEPHYR_DEFAULT_PROJECT_KEY` | нет | — | Подставляется, если инструмент вызван без `projectKey` |
| `ZEPHYR_READONLY` | нет | `false` | При `true` инструменты записи возвращают ошибку |
| `ZEPHYR_ALLOW_INTERNAL_API` | нет | `false` | При `true` регистрируются UNOFFICIAL-инструменты на базе internal API `/rest/tests/1.0` (вендором не поддерживается — риски на пользователе) |
| `ZEPHYR_LOG_LEVEL` | нет | `info` | `debug` \| `info` \| `warn` \| `error` (весь лог — в stderr) |

Секреты (`JIRA_PAT`, `JIRA_PASSWORD`) не пишутся в логи и не попадают в ответы инструментов и тексты ошибок.

## Подключение к MCP-клиенту

`claude_desktop_config.json` / `.mcp.json`:

```json
{
  "mcpServers": {
    "zephyr-scale": {
      "command": "node",
      "args": ["/path/to/zephyr-scale-mcp/dist/index.js"],
      "env": {
        "JIRA_BASE_URL": "https://jira.example.com",
        "JIRA_AUTH": "pat",
        "JIRA_PAT": "<personal access token>",
        "ZEPHYR_DEFAULT_PROJECT_KEY": "PROJ"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add zephyr-scale \
  --env JIRA_BASE_URL=https://jira.example.com \
  --env JIRA_PAT=<token> \
  --env ZEPHYR_DEFAULT_PROJECT_KEY=PROJ \
  -- node /path/to/zephyr-scale-mcp/dist/index.js
```

Проверка: попросите агента вызвать `health_check` — он должен вернуть `{ ok: true, jiraUser, baseUrl, zephyrPluginReachable }`.

## Примеры

Создание кейса с шагами:

```json
{
  "tool": "create_test_case",
  "arguments": {
    "projectKey": "PROJ",
    "name": "Успешный вход",
    "folder": "/Регресс/Авторизация",
    "testScript": {
      "type": "STEP_BY_STEP",
      "steps": [
        { "description": "Открыть страницу логина", "testData": "URL: /login", "expectedResult": "Форма логина отображается" },
        { "testCaseKey": "PROJ-T45" },
        { "description": "Ввести валидные креды", "expectedResult": "Открыт дашборд" }
      ]
    }
  }
}
```

Поиск по TQL: `projectKey = "PROJ" AND folder = "/Регресс" AND status = "Approved"` (синтаксис строгий: пробелы вокруг операторов, строки в двойных кавычках, только `AND`).

Цикл с результатами создаётся одним вызовом `create_test_run` — см. описание инструмента (поле `items`, в т.ч. `scriptResults` с пошаговыми статусами).

## Ограничения API v1 (важно)

1. **Тест-циклы неизменяемы после создания.** `PUT /testrun/{key}` не существует: нельзя переименовать цикл, сменить папку, добавить/убрать кейсы. Состав задаётся только в `create_test_run` (поле `items`). Инструменты результатов лишь находят **существующий** item по `testCaseKey`.
2. **Папки** не создаются автоматически при создании кейсов/циклов; публичного листинга папок нет; переименование — только по числовому `id` (его возвращает `create_folder`).
3. **`owner` / `executedBy` / `assignedTo`** — это Jira **user key** (`JIRAUSER10000`), не логин и не e-mail; для резолва используйте `find_jira_user`.
4. **TQL строгий** — только `AND`, пробелы вокруг операторов, строки в двойных кавычках; для циклов доступны только поля `projectKey` и `folder`.
5. Статусы / приоритеты / окружения **регистрозависимы** и передаются внутренними (нелокализованными) именами; на инстансе могут быть кастомные наборы.
6. В `labels` пробелы заменяются API на `_`.
7. Устаревшие поля API не поддерживаются намеренно: `issueKey` → `issueLinks`, `executionDate` → `actualEndDate`, `userKey` → `executedBy`.
8. Ключи сущностей: `PROJ-T1` — кейс, `PROJ-P1` — план, `PROJ-R1` — цикл.
9. Серверный default `maxResults` = 200; инструменты по умолчанию запрашивают 50.
10. Шаги STEP_BY_STEP при `PUT` синхронизируются по `id`: без `id` — создать, с `id` — обновить, отсутствует в списке — **удалить**. Поэтому `update_test_case` с `testScript.steps` требует полный итоговый список; безопасное частичное добавление шагов делает `add_test_steps` (читает кейс, сливает, записывает).

Если API вашего инстанса ведёт себя иначе (старая версия плагина и т.п.) — зафиксируйте расхождение здесь и сообщите разработчику.

### Известные расхождения конкретных инстансов

Обнаружены при живой проверке на Jira DC со старой версией плагина (2026-07-16, стенд `jira.digital-spirit.ru`, проект `NBUL`):

1. **BDD-текст — только строки шагов**, без заголовков: `POST /testcase` с `testScript.type = "BDD"` принимает исключительно строки `Given/When/Then/And/But` (кириллица в тексте шагов — ок, проверено вживую с round-trip байт-в-байт). Текст с обёрткой `Feature:` / `Scenario:` отклоняется с `400 {"errorMessages":["Invalid BDD Script"]}` — несмотря на то, что пример в §8.1 ТЗ включает эти заголовки. BDD-кейс в Zephyr Scale Server — это один сценарий; `Feature` генерируется при экспорте. Описания инструментов предупреждают об этом.
2. **Ключи циклов с префиксом `-C`**, а не `-R` (`NBUL-C34`) — старая нотация TM4J. На работу сервера не влияет: ключи передаются сквозняком.
3. **Нет эндпоинта `GET /testrun/{key}/testresults/page`** (404 для любого ключа). Сервер автоматически переключается на устаревший плоский `GET /testrun/{key}/testresults` и пагинирует на своей стороне; в ответе появляется поле `note`. `onlyLastExecutions` в этом режиме эмулируется по максимальному `id` на каждый `testCaseKey`.
4. **Неизвестные статусы результатов молча игнорируются**: `create_test_result` со `status: "Pass"` вернул `201 {id}`, но item цикла остался `Not Executed` — на инстансе настроены кастомные наборы статусов (например, у кейсов есть «Ручной»). Проверяйте точные имена статусов в UI (Project settings → Zephyr Scale → Statuses) — API ошибку не возвращает.

## Обработка ошибок

Ошибки API возвращаются в формате `Zephyr API error <status> (<METHOD> <path>): <тело до 2 КБ>` с подсказкой для типовых причин (несуществующая папка, регистрозависимые статусы, синтаксис TQL, недоступный плагин, права). 429/503 повторяются с учётом `Retry-After`; сетевые ошибки и 5xx повторяются только для GET (backoff `500ms * 2^n` + джиттер).

## Разработка

```bash
npm run typecheck    # tsc --noEmit
npm test             # unit + contract (vitest + msw), без сети
npm run smoke        # интеграционный сценарий против реального стенда (ZEPHYR_E2E=1)
```

Smoke-сценарий требует реальных `JIRA_BASE_URL`/`JIRA_PAT` и `ZEPHYR_DEFAULT_PROJECT_KEY` (выделенный тестовый проект!) и оставляет на стенде папки `/mcp-smoke-*` (API не умеет удалять папки).

### Структура

```
src/
├── index.ts        # bootstrap: конфиг, регистрация инструментов, stdio-транспорт
├── config.ts       # чтение и валидация env
├── http.ts         # zephyrFetch(): auth, таймаут, ретраи, нормализация ошибок
├── schemas.ts      # zod-схемы общих структур (Step, TestScript, поля результатов…)
├── toolkit.ts      # defineTool(): strict-валидация, read-only guard, формат ответов
└── tools/          # testCases, folders, testRuns, testResults, misc
test/               # unit + contract (msw) + smoke.e2e
```

## Фаза 3 (§7.6) — реализовано

- **Вложения**: `upload_attachment` / `list_attachments` / `delete_attachment`. Единая адресация: `target` = `test_case` | `test_run` | `test_result` (+ опциональный `stepIndex` для кейса и результата). Загрузка — multipart, файл читается с диска машины, где запущен MCP-сервер.
- **Тест-планы**: полный CRUD + `search_test_plans` (TQL).
- **Автоматизация**: `upload_automation_results` (zip с результатами в формате Zephyr), `upload_cucumber_results` (zip с Cucumber JSON), опционально `autoCreateTestCases`; `download_feature_files` выгружает zip с `.feature`-файлами BDD-кейсов в локальный файл.
- **`recreate_test_run_with_items`** — обход неизменяемости циклов: читает исходный цикл, создаёт новый с изменённым составом (`addItems` / `removeTestCaseKeys`), заголовочные поля наследуются от исходного; `copyResults: true` переносит последние результаты item'ов (включая пошаговые `scriptResults`); исходный цикл удаляется **только** при явном `deleteOriginal: true` и никогда — если создание нового не удалось. Новый цикл получает **новый ключ**.
- **Internal API** (за флагом `ZEPHYR_ALLOW_INTERNAL_API=true`): `get_folder_tree` — дерево папок проекта (`/rest/tests/1.0/project/{id}/foldertree/...`). Помечен `UNOFFICIAL`: вендор internal API не поддерживает, на другой версии плагина эндпоинт может отсутствовать или отличаться.
