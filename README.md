# opt2-tealbrick-inbox

Teal Brick opt2: **Operator Inbox** (product id `inbox`), the one queue from agents to the owner: questions and approval requests, decisions with full history, and the pending holds of all apps in one list.

**Status: opt2 build (clean-room v2 of Teal Brick), work in progress.** This repository is part of the opt2 build and lives under `Martin-Atrin` during the build; it moves to the Teal Brick organisation as one clean commit when opt2 is released. It is not the current production system.

Owner lane: Lead · Inbox.

## No secrets policy

This repository is public. It must never contain secrets or personal data:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables) and are copied between services without printing them.
- No personal names, private agent configurations or customer data.
- Every push runs a secret scan (Woodpecker `secret-scan` step, gitleaks). GitHub secret scanning with push protection is enabled. Optional local guard: `pre-commit install`.
- If a secret is committed anyway: rotate it first, then remove it from history.

## App

A Teal Brick opt2 miniapp (product id `inbox`), built on `@opt2-tealbrick/miniapp-sdk`.

`tealbrick.manifest.json` is the only description of the app. The SDK derives the routes, input and output
validation, OpenAPI, receipts, holds, idempotency, scopes, backups and status from it. You write handlers by
operation id (`src/app.ts`) and plain migrations (`migrations/`).

## What it does

- Agents (and companion apps) call `inbox_ask` (question or approval request; idempotency key required), poll `inbox_status`, and add facts with `inbox_reply`.
- The owner (the only person who can sign in, C84) lists, opens, answers (`approve`, `deny`, `answer`, `clarify`), snoozes, reprioritises and marks items seen.
- Fail closed: a second answer (`already_decided`), an answer on text the owner has not read (`stale_version`), an answer after expiry (`item_expired`), a response the item does not allow (`response_not_allowed`), answer/clarify without words (`message_required`).
- Holds overview: Inbox's own open items plus, with the owner's consent at deploy (wildcard companion `product: "*"` for `tb.holds_pending` only, spec 0.1.13), the pending holds of all apps (summaries only). Each row opens the owning app's decision page through Portal (`/w/<ws>/open`, launch ticket). Deciding stays in the owning app.
- Alerts: open, unsnoozed items count in the TBD badge (`pendingCount` + `statusChanged`, C86). Optional owner DM through Connect (Buzz or a channel account), off by default; Connect sends it from the workspace sender identity the owner picks (`no_sender_identity` until set). A held DM is repeated with the same input and key; a denied one stops.
- Deep links: `/items/<id>` opens one item, `/holds/<id>` one of Inbox's own holds.

## Layout

| Path | Content |
|---|---|
| `tealbrick.manifest.json` | identity, runtime (data + backup volumes), operations, scopes, skills, backups, UI paths |
| `src/app.ts` | `defineApp`: one typed handler per operation (op ids and I/O types from `#kit`) |
| `src/store.ts` | the decision loop: items, messages (the thread), decisions (who and when), snooze, priority, ack; every fail-closed rule |
| `src/alerts.ts` | optional owner alert DM through Connect (companion call; off by default; held sends repeated with the same input and key) |
| `src/holds.ts` | holds overview: Inbox items + all apps' pending holds (`tb.holds_pending` via `ctx.companionTargets()`, owner consent), Portal links |
| `src/main.ts` | `startApp(app, process.env)` |
| `src/ui/` | React UI (`<TbProvider>` + `<AppShell>` from `@opt2-tealbrick/ui`; `standard.tsx` + `pages.css` are the template copies, `app.css` is this app's layout), built to `dist/ui` |
| `migrations/0001_init.sql` | baseline; forward-only, never edit a released file |
| `skills/use-inbox/SKILL.md` | the agent skill (frontmatter `name`, `description`) |
| `scripts/build-ui.ts` | UI build without a bundler (tsc output + vendored modules + import map) |
| `gen/` (not committed) | `tb-gen` output; `node --run kit` generates the kit and compiles it to `dist/kit` (`#kit` import) |
| `Dockerfile` | `node:24-slim` pinned by digest, pnpm build to `dist/`, non-root, `CMD ["node", "dist/main.js"]` |
| `.woodpecker/ci.yaml` | the opt2 CI template, byte-identical copy (do not edit) |
| `tealbrick-ci.json` | CI settings: kind `miniapp`, one image |

## Develop

```sh
pnpm install          # commit pnpm-lock.yaml: CI installs with --frozen-lockfile
# typecheck, test, conformance, build and start first run `tb-gen kit` (op ids + I/O types from the manifest)
pnpm typecheck && pnpm lint && pnpm test
pnpm build            # server to dist/, UI to dist/ui
pnpm conformance      # SDK conformance suite against this app
TB_STANDALONE=1 TB_DATA_DIR=.data pnpm start   # app-alone mode: person UI only, no agent calls
```

## Environment

The SDK reads only `TB_*` variables (SDK-API §13). The deploy recipe sets them: `TB_INSTANCE_ID`,
`TB_ENROL_CODE`, `TB_BRIDGE_URL`, `TB_PORTAL_KEYS`, `TB_KEK`, `TB_DATA_DIR` (the `data` volume mount, `/data`)
and `TB_BACKUP_DIR` (`/data/backup`: one volume per service). Optional: `TB_LOG_LEVEL`, `TB_RESTORE_FROM`,
`TB_STANDALONE`. The listen port is the manifest `runtime.port`.

Before its first claim the SDK checks that `TB_DATA_DIR` is a mounted volume (SDK 0.1.12); on a container's own
disk it waits and does not use the enrolment code. Tests and CI that run `startApp` in bridge mode on Linux set
`TB_DATA_EPHEMERAL=1` (conformance does, see `conformance.start.ts`; the unit tests run app-alone and need none).
Never set it in a deploy recipe.

## Release

1. Set the same version in `package.json` and `tealbrick.manifest.json`.
2. Tag `v<semver>` (for example `v0.1.0`) and push the tag.
3. CI builds and publishes the image, then writes the signed release record from the manifest.

Before the first push, check `publisher` and `source.repo` in the manifest. The repository name must match the
image name in `tealbrick-ci.json` (`opt2-tealbrick-inbox`).

## Dependency pins and caching
- `pnpm-lock.yaml` carries the sha512 integrity of every GitHub-release tarball (CI rule ci-v8). After changing an `@opt2-tealbrick/*` dependency run `pnpm install`, then `node <opt2-tealbrick-platform>/ci/tb-ci.ts pin-tarballs .`, then `pnpm install --frozen-lockfile`, and commit the lockfile. Image builds run `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm build` writes the UI to `dist/ui/index.html` + `dist/ui/assets-<content hash>/`; the SDK serves index.html `no-cache` and the hashed directory immutable, so a deploy is visible at once (C61).

## Licence

Apache-2.0 (`LICENSE`, `NOTICE`). The built UI vendors React (MIT), the Tealbrick kit and Nunito (SIL OFL 1.1); the Tealbrick brand mark and app stills are Tealbrick artwork and are not covered by the Apache licence. See `THIRD_PARTY_NOTICES.md`.
