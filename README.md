# Reminder

[简体中文](README.zh-CN.md) · [Product requirements](docs/PRD.en.md) · [Roadmap](docs/ROADMAP.en.md)

Reminder is a personal task list, recurring-work planner and time report. Its Node.js web service and CLI share one JSON store. The browser provides six views, flags and time reports. Create and edit entries, record recurring work, and complete or restore tasks through the CLI or an authorized integration.

## Start

Use Node.js 22 or later. The independent repository is `https://github.com/55aaseclab/reminder.git`. Initialize an empty checklist only when there is no existing one.

```sh
git clone https://github.com/55aaseclab/reminder.git
cd reminder
node src/cli.js import data/checklist.example.json
npm start
```

Open [Reminder on localhost](http://localhost:4322/). The interface starts in English and offers Simplified Chinese. The app needs no runtime dependencies or frontend build. To bind only to loopback and choose a data file, run `npm start -- --host 127.0.0.1 --port 4322 --data /absolute/path/checklist.json`. Point the CLI at the same absolute path with `--data` or `REMINDER_DATA`.

## Command line

```sh
node src/cli.js help
node src/cli.js add "Prepare team review" --date "2027-01-16 19:00" --tag Team
node src/cli.js ls --json
node src/cli.js done ITEM_ID --actual-hours 1.5
node src/cli.js undo ITEM_ID
node src/cli.js edit ITEM_ID --text "Prepare next review" --tag Planning
node src/cli.js flag ITEM_ID
node src/cli.js rm ITEM_ID
node src/cli.js tags
node src/cli.js record TEMPLATE_ID --actual-hours 1.5 --completed-at "2026-11-11 17:23:45"
node src/cli.js stats --period week --anchor 2026-11-11
node src/cli.js stats --period month --anchor 2026-11-11 --json
```

Replace `ITEM_ID` and `TEMPLATE_ID` with current IDs from the list. `ls --json` returns `{revision,items}`. Ambiguous legacy IDs are rejected with exact zero-based references such as `history:0`. Submit `--revision` from that snapshot when using an index. New IDs cannot use the reserved collection/index format. Use `edit --actual-hours unknown` for missing actual time and `0` for known zero. Optionally install a local command alias with `npm link`.

## Data and recovery

The default `data/checklist.json` is private, ignored by Git and separate from the empty example and synthetic test fixture. Import schema v2 JSON to preserve the four collections and their order, duplicate legacy IDs, optional fields and existing timestamp precision. The imported file becomes the local source of truth. A separate disposable import looks like this:

```sh
node src/cli.js --data /tmp/reminder-example.json import data/checklist.example.json
```

Explicit `--replace` overwrites the target and retains the preceding copy as `.bak`. Arrange independent long-term backups. New `addedAt` and `completedAt` values use local time to the second. Server and browser should use the same time zone to interpret Today consistently. Planned dates can specify year, month, day or minute. History defaults to complete. Explicit `done:false` restores the record in place. Recording a recurring task creates a history entry with copied text, tags and estimate, the template reference, actual hours and completion time.

The store locks the file, rereads current data, validates changes, and writes by temporary file and atomic rename. Web mutations require `If-Match`. A stale revision returns HTTP 409. External editors do not participate in this locking protocol. After an interrupted writer, stop all service and CLI writers, verify that the lock is stale, back up the JSON, and remove its sibling `.lock` file before restarting. Uncommitted `.tmp` files are ignored.

## Views and time reporting

- Routines, Today, Scheduled, All, Flagged and Completed support keyboard navigation. All keeps the file order across plans, pool and history. Scheduled groups unfinished dated tasks by date. Completed sorts newest completion first, with missing timestamps last.
- The weekly routine chart packs templates in file order across six nine-hour days at 1.2 rem per hour. Blocks may cross days. Frequency tags are descriptive. Overflow above 54 hours is reported and every template stays in the list.
- The standalone UI reloads after focus and checks for changes every three seconds. The browser stores its view and language preference. Authorized flags use PATCH. A conflict refreshes current data and asks the user to review it before retrying.
- Time reports count completed non-template entries with recorded actual hours and valid completion times. Missing time is unknown. Weeks start on Monday and months use calendar boundaries. Group by `completedAt`.
- Allocate both estimated and actual hours equally across tags; use `Untagged` for an empty list. Group executions by source template. Keep unrelated duplicate IDs separate using their references. Include known actuals with missing estimates and describe the zero-estimate basis of the difference.
- Show eight weekly or six monthly buckets for recurring execution trends. Missing periods indicate unavailable observations. Reports use text and tables.

## Managed business integration

An optional gateway adapter isolates spaces, validates signed calls and preserves the same store semantics. In managed mode the original raw API and file-based CLI are disabled. Keep signing keys and space mappings in private regular files outside Git, owned by the service user, mode 0600. Supply at least 32 random bytes as a key, read verbatim.

```sh
REMINDER_MANAGED=1 \
REMINDER_BUSINESS_KEY_FILE=/absolute/private/reminder.key \
REMINDER_BUSINESS_SPACES_FILE=/absolute/private/reminder-spaces.json \
npm start
```

A space map uses absolute paths such as `{"spaces":{"personal":"/absolute/private/checklist.json","family":"/absolute/private/family/checklist.json"}}`. Spaces cannot share a real file. An absent file for a configured space reads as empty; the first authorized creation initializes it atomically. Unknown modes, unsafe mappings and missing or short keys fail startup. `GET /health` exposes only service and mode status.

`REMINDER_BUSINESS_UI_URL` optionally redirects managed root GET/HEAD requests with HTTP 303. The configured target may have a path, uses HTTPS or HTTP loopback, and excludes user information, query parameters, fragments and control characters. Incoming query parameters are discarded. Standalone mode ignores this option.

Send JSON to `POST /api/business` with `x-praxis-assertion`. The gateway selects the app, space, action and resource scope. Inputs cannot specify filesystem paths or replace the entire file.

| Operation | Required permission | Request and response |
| --- | --- | --- |
| list | read | Optional collection. Return space, snapshot revision, cursor and scoped items with stable resource IDs. |
| add | create | A new item and optional collection and preauthorized resource ID. The service generates the internal task ID. |
| update | update | A resource ID, expected item revision and allowed field changes. Completion state has a separate operation. |
| complete | complete | A resource ID and expected revision. Accepts done, actual time and completion time. Restore ordinary tasks with `done:false`. |
| record | create + proof of source read | Source resource and expected template revision, actual hours and optional completion time. Create history and leave the template revision unchanged. |
| delete | delete | Resource and expected revision. Return a deletion receipt without the removed text. |
| stats | read | Optional period and anchor. Reuse the standalone calculations over scoped records. |
| events | read | Optional cursor. Return events, scanned cursor, minimum available cursor and reset status. |

All mutations use an idempotency key scoped to user, client and space. Replaying identical input returns the original receipt with `replayed:true`; different input with the same key yields 409. Expected revisions apply to individual resources, including source templates, separately from the opaque snapshot revision. An absent file reports revision `uninitialized`.

An assertion is `base64url(JSON claims) + "." + base64url(HMAC-SHA256(encodedClaims,key))`. Claims bind `v:1`, app ID `reminder`, user, client, grant, space, action, resources, expiry in epoch milliseconds, request ID, method POST, path `/api/business` and hex SHA-256 of the raw body. It expires within 30 seconds. The app rejects query parameters and checks expiry after waiting for the lock and before commit. The gateway rechecks grants before dispatch. Immediate revocation of in-flight calls needs gateway coordination.

Managed recording needs space-wide creation and the trusted `sourceReadGranted:true` claim; only the gateway establishes this proof after checking current source read access. Preauthorized single-resource creation accepts a target `r_<UUID>` covered by the assertion. It cannot replace an existing resource or reuse a previously committed creation ID. Idempotent replays return the same ID.

The separate trusted `integrity` check accepts only `{operation:"integrity",spaceId}` under space-wide read. It returns revision, cursor, collection counts and resource count, without task text, internal IDs, files or source hashes. It is restricted to verification infrastructure.

Optional `_business` metadata is committed atomically with changes. Stable opaque resource IDs are independent of duplicate legacy task IDs. Read-only requests do not initialize metadata. Private receipts stay out of general logs. The most recent 2,048 events contain identity and revision metadata, not content. Outdated cursors return `resetRequired:true`; resume from a fresh scoped list. A scanned cursor can advance even when no authorized changes matched.

## Tests

`npm test` covers schema preservation, migration, ambiguous IDs, validation, locking, revision conflicts, UTF-8 parsing, CLI, API, statistics and calendar packing in temporary synthetic stores.

## Praxis integration

The app-owned [provider contract](docs/PRAXIS-PROVIDER.md) supplies authorized source-backed cards and data-source metadata without exposing a new HTTP endpoint. Run `npm run test:provider` for the isolated provider checks.

## Praxis registration

App release: `1.0.8`. The app owns [`praxis-app.json`](praxis-app.json), its English and Simplified Chinese presentation, the icon at `public/praxis-icon.svg`, the declared PRD locations and any legacy icon aliases. `schemaVersion: 1` identifies the registration format; it is separate from this app release and from data, protocol and document revisions. Package and lockfile release metadata, where present, agree with the declaration.

[`apps.example.json`](apps.example.json) registers a local alias by referencing `./praxis-app.json` and `http://127.0.0.1:4322/`. Start the standalone service described above before using the example; registration does not start a backend or grant account, administrator or business-data access. Installation origins, data locations and access policy remain separately configured.

## App-owned container build

`Dockerfile.praxis` builds this application from its own repository, without a Praxis checkout or an external build context:

```sh
docker build -f Dockerfile.praxis -t praxis-reminder:local .
```

Use the application configuration and persistent data locations documented above when running the image. The Praxis installation consumes the same app-owned build and deployment declaration.

## 应用自有容器构建

`Dockerfile.praxis` 可直接从本应用仓库构建，无需 Praxis 源码或额外构建上下文：

```sh
docker build -f Dockerfile.praxis -t praxis-reminder:local .
```

运行镜像时沿用上文的应用配置与持久数据位置。Praxis 安装流程使用同一份应用自有构建文件与部署声明。
