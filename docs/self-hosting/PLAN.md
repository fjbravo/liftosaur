# Self-Hosted Containerized Deployment — Plan

This document is the working breakdown for converting Liftosaur into a fully
containerized deployment that can be self-hosted with Docker Compose. It is the
source of truth for this effort: every required change is listed here with its
target files, and the checklists track completion.

## Goals and decisions

| Decision | Choice |
|---|---|
| Database | **DynamoDB Local** container — the 25 DAOs keep working unchanged; only the client endpoint is configurable. |
| Object storage | **MinIO** (S3-compatible), with `forcePathStyle` and a separate public endpoint for presigned URLs. |
| Email | **SMTP** (nodemailer) when `SMTP_HOST` is set; mailpit in the default compose stack. |
| Secrets | Environment variables (no AWS Secrets Manager). |
| Cloud-tied features | Optional via env config: Apple/Google sign-in, IAP subscriptions, AI/LLM, web push, Rollbar. Missing config degrades gracefully; premium features are unlocked by default in self-hosted mode. |
| Orchestration | **docker-compose.yml** at the repo root (`selfhosted/` holds everything else). |
| AWS deployment | Untouched. All changes are env-gated; with no new env vars set, behavior is identical to today. |

## Target architecture

```
                        ┌────────────────────────────────────────────┐
 browser ──► :80/:443 ─►│ web (nginx)                                │
                        │  - serves webpack dist (static assets)     │
                        │  - CloudFront-function rewrites ported     │
                        │  - /api/*, /, /app, page routes ─► server  │
                        │  - /stream/* ─► server (streaming port)    │
                        │  - /userimages/* ─► minio                  │
                        └───────┬──────────────────┬─────────────────┘
                                │                  │
                  ┌─────────────▼──────┐   ┌───────▼────────┐
                  │ server (node)      │   │ minio          │
                  │  lambda/index.ts   │   │  10 buckets    │
                  │  streamingHandler  │   └───────▲────────┘
                  └───┬────────┬───────┘           │
                      │        │            bucket events (webhook)
              ┌───────▼──┐  ┌──▼────────┐          │
              │ dynamodb │  │ mailpit / │   image resizer endpoint
              │ local    │  │ real SMTP │   (server, in-process)
              └──────────┘  └───────────┘
                  ▲
        ┌─────────┴─────────┐
        │ bootstrap (once)  │  creates tables/GSIs/TTL + buckets
        │ cron (node)       │  stats job daily; reconcile optional
        └───────────────────┘
```

The server container runs the **same** `lambda/index.ts` and
`lambda/streamingHandler.ts` handlers used in AWS, wrapped in a plain Node HTTP
server modeled on `devserver.ts` (which already does the
HTTP↔APIGatewayProxyEvent translation and stubs `awslambda.streamifyResponse`).

## Inventory: what couples the app to AWS today

Full details from the code audit; file references are the anchor points for the
changes below.

1. **Service clients** — all constructed with `new XClient({})` (default AWS
   endpoint/credential chain), behind DI interfaces in `lambda/utils/di.ts`:
   `dynamo.ts`, `s3.ts`, `ses.ts`, `secrets.ts`, `lambda.ts`, `cloudwatch.ts`.
   Even `IS_LOCAL=true` dev mode hits real AWS today — there is no local-AWS
   code path anywhere.
2. **`ILambdaUtil.invoke` has zero production call sites** — vestigial; safe to
   no-op in self-hosted mode.
3. **DynamoDB**: 22 tables (+GSIs, 4 with TTL) defined in
   `liftosaur-cdk/liftosaur-cdk.ts`; DAO-side names match 1:1 (`lftPrograms` is
   unreferenced legacy). The bootstrap script must recreate this schema exactly
   (prod names — self-hosted runs with `IS_DEV` unset).
4. **S3**: 10 buckets (`lambda/dao/buckets.ts`). Presigned URLs at exactly two
   call sites: upload to `userimages` (`lambda/index.ts` `postImageUploadUrlHandler`)
   and download from `exceptions`. `assets`, `userimages`, `static` are
   public-read. `getUserImagesPrefix()` hardcodes `www.liftosaur.com/userimages/`.
5. **Secrets**: one JSON blob in Secrets Manager. Essential for core operation:
   `cookieSecret` (all session auth), `apiKey` (admin/dashboards). `cryptoKey`,
   `webpushrKey/AuthToken` have no production call sites. Everything else gates
   an optional feature (Apple/Google IAP, AI keys, OTA update signing).
6. **Email**: 3 transactional emails (signup verification, set-password link,
   forgot-password), all plain text from `info@liftosaur.com`, all through the
   single `ISesUtil.sendEmail`.
7. **Auth**: email/password is fully self-contained (scrypt + DynamoDB tokens +
   cookie JWT). Google/Apple sign-in verify tokens against the providers'
   *public* endpoints — no server-held secret needed; buttons simply don't work
   without client-side OAuth registration. Only IAP verification needs secrets.
8. **Subscription gating** — single choke points on both sides:
   client `src/utils/subscriptions.ts` `Subscriptions_hasSubscription()` (pure
   function, 30+ callers); server `lambda/utils/subscriptions.ts`
   `Subscriptions.hasSubscription()` (gates AI streaming + public API).
9. **Scheduled jobs** (EventBridge): stats report daily 23:40 UTC
   (`statsLambdaHandler`); Apple/Google payment reconciliation Sundays 06:00 UTC
   (optional without IAP).
10. **imageResizer** (`lambda/imageResizer.ts`): S3 `ObjectCreated`
    (prefix `user-uploads/`) → sharp resize to 600×900, overwrite in place.
    Needs MinIO bucket webhook → server endpoint building a synthetic `S3Event`.
11. **CloudFront Functions** (inline JS in the CDK, no repo source files):
    URL rewrites (`/`→`/main`, `/app`→`/app/`, `/record`→`/api/record`,
    `/profileimage/:id`→query form, `/docs`→`/doc`), charset headers, static
    prefix stripping, and synthetic `X-Auth-State`/`X-Device-Type` cache-key
    headers. Must be ported to nginx (headers can be computed in the Node server
    itself, as `devserver.ts` already does).
12. **Frontend host resolution** is baked at build time via webpack
    `DefinePlugin` (`__HOST__`, `__API_HOST__`, `__STREAMING_API_HOST__`),
    selected by `process.env.STAGE` / `localdomain.js`. The server already
    honors a runtime `HOST` env var (`process.env.HOST`).
13. **Rollbar**: hardcoded access tokens in `lambda/index.ts` and
    `lambda/streamingHandler.ts` — a self-hosted fork would report errors to the
    upstream account unless env-gated.
14. **Dead/skippable infra**: Cloudflare Worker (`wrangler.toml` — its
    `webpack.server.config.js` was never committed; route superseded by
    `api3.liftosaur.com`), `_redirects`/`_headers` (Netlify-era), CodePipeline,
    sourcemap upload, watch-bundle publishing.

## Work packages

### WP1 — Backend service adapters ✅ done

Every self-hosted implementation lives in `selfhosted/` and is assembled by
`buildSelfHostedDi()` (`selfhosted/di.ts`), which the self-hosted entrypoints
(`selfhosted/server.ts`, `selfhosted/cron.ts`) use in place of `buildDi()`.
`lambda/utils/di.ts` and `buildDi()` stay on the pure-AWS path — `lambda/run.ts`
and `devserver.ts` are unaffected.

- [x] `selfhosted/envSecrets.ts` — `EnvSecretsUtil`, always used on the
      self-hosted DI path (it *is* the self-hosted path, so there is no
      `SECRETS_SOURCE` switch): `LIFTOSAUR_COOKIE_SECRET`,
      `LIFTOSAUR_CRYPTO_KEY`, `LIFTOSAUR_API_KEY` required (clear error naming
      the variable); `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
      Apple/Google/webpushr/updates vars optional (empty when unset).
- [x] `selfhosted/smtpSes.ts` — `SmtpSesUtil` (nodemailer), chosen by
      `buildSelfHostedDi` when `SMTP_HOST` is set (`SMTP_PORT`, `SMTP_USER`,
      `SMTP_PASS`, `SMTP_FROM`; auth omitted unless both user and pass are set,
      so mailpit works); plain `SesUtil` otherwise.
- [x] `selfhosted/di.ts` — reads `DYNAMODB_ENDPOINT`, `S3_ENDPOINT` (+
      `forcePathStyle`) and `S3_PUBLIC_ENDPOINT` (presigned URLs are signed
      against the browser-reachable host) and passes them as client configs;
      `SelfHostedLambdaUtil` / `SelfHostedCloudwatchUtil` log-and-no-op instead
      of calling AWS Lambda / CloudWatch.
- [x] `lambda/utils/dynamo.ts` / `lambda/utils/s3.ts` — the only upstream
      residue: an optional `clientConfig` (and `presignerClientConfig` for S3)
      constructor parameter defaulting to `{}`, i.e. generic dependency
      injection with no self-hosting knowledge in the file.
- [x] `test/selfhosted.test.ts` — pins all of the above plus the in-place gates
      below, so a bad upstream-merge resolution fails CI instead of silently
      reverting self-hosted behavior.

### WP2 — Containerized server ✅ done

- [x] `selfhosted/server.ts` — plain-HTTP entrypoint based on `devserver.ts`:
      main API on `PORT` (3000), streaming handler on `STREAMING_PORT` (3001);
      computes `x-auth-state`/`x-device-type` headers; no TLS (nginx terminates),
      commit hash from `COMMIT_HASH`/`FULL_COMMIT_HASH` env, binds `0.0.0.0`,
      `GET /healthz`, graceful shutdown on SIGTERM/SIGINT.
- [x] MinIO bucket-notification endpoint on the server (`POST
      /selfhosted/minio-events`, also accepted at `/api/minio-resize-webhook`):
      MinIO webhook payload → `S3Event` → `lambda/imageResizer.ts` handler.
      Optional `Authorization: Bearer $LIFTOSAUR_WEBHOOK_TOKEN`.
- [x] Server-side self-hosted subscription unlock: short-circuit
      `Subscriptions.hasSubscription` when `LIFTOSAUR_SELF_HOSTED=true` (the one
      choke point behind the streaming AI, public API and MCP gates).
- [x] Env-gate Rollbar (`ROLLBAR_SERVER_TOKEN`; no client and no wrapper at all
      in self-hosted mode without it) in `lambda/index.ts` and
      `lambda/streamingHandler.ts`.
- [x] `getUserImagesPrefix()` — honor `HOST` env in self-hosted mode.
- [x] `selfhosted/webpack.server.config.js` — reuses the lambda webpack config
      with `selfhosted/server.ts` as the entry, emitting `dist-selfhosted/`
      with the same layout as `dist-lambda/`. `npm run build:selfhosted`.
- [x] `selfhosted/docker/Dockerfile.server` — multi-stage build (full deps +
      generators + webpack bundle → slim runtime with sharp/resvg only),
      `IMGPREFIX=lambda/` for the image generators.

### WP3 — Bootstrap and scheduled jobs ✅ done

- [x] `selfhosted/bootstrap/createTables.ts` — create all 23 tables + GSIs +
      TTL specs (prod names) against `DYNAMODB_ENDPOINT`; idempotent.
- [x] `selfhosted/bootstrap/createBuckets.ts` — create the 10 buckets in MinIO;
      set `assets`/`userimages`/`static` to public-read (bucket policy);
      register the `userimages` webhook notification for `user-uploads/`
      (gated on `MINIO_NOTIFY_WEBHOOK_ENABLE_RESIZER=true`).
- [x] `selfhosted/bootstrap/index.ts` — runs both, retrying while DynamoDB/MinIO
      are still booting and failing fast on everything else.
- [x] `selfhosted/cron.ts` — long-running scheduler: stats job daily 23:40 UTC;
      payment reconciliation Sundays 06:00 UTC only when Apple/Google IAP env
      is configured.

### WP4 — Frontend build + web container ✅ done

- [x] `webpack.config.js` — allow env overrides (`LIFTOSAUR_HOST`,
      `LIFTOSAUR_API_HOST`, `LIFTOSAUR_STREAMING_API_HOST`) for the
      `DefinePlugin` globals, and a `__SELF_HOSTED__` define.
- [x] Client-side unlock: `Subscriptions_hasSubscription()` returns `true` when
      built with `__SELF_HOSTED__`.
- [x] `selfhosted/docker/Dockerfile.web` — build the web bundle with the env
      overrides, serve `dist/` with nginx.
- [x] `selfhosted/docker/nginx.conf` — port the CloudFront-function routing:
      static assets with long cache; `/`→`/main`, `/app`→`/app/`, `/docs`→`/doc`,
      `/record`→`/api/record`, `/profileimage/:id` rewrites; proxy API + page
      routes to server, `/stream/*` to the streaming port, `/userimages/*` to
      MinIO; charset headers.
- [x] Same-origin presigned URLs: `/liftosauruserimages/` and
      `/liftosaurexceptions2/` proxy to MinIO path-style with the path and the
      public `Host` header untouched, since SigV4 covers both.

### WP5 — Compose stack + operator docs ✅ done

- [x] `selfhosted/webpack.server.config.js` — multi-entry (`server`,
      `bootstrap`, `cron`), so one image ships all three commands.
- [x] `docker-compose.yml` — services: `web`, `server`, `cron`, `dynamodb`
      (amazon/dynamodb-local, persistent volume), `minio` (+persistent volume),
      `mailpit`, one-shot `bootstrap`.
- [x] `env.example` — full env contract with generated-secret instructions.
      (At the repo root, dot-less: `.env.example` is unwritable under the repo's
      `Read(.env.*)` permission deny rule.)
- [x] `docs/self-hosting/README.md` — quickstart (clone → set env → 
      `docker compose up`), backup/restore notes, enabling optional features.

### WP6 — Validation

- [x] `tsc --noEmit` for lambda + selfhosted code; `npm run lint` on changed files.
- [x] `docker compose config` parses; nginx config passes `nginx -t`, and the two
      presigned-URL locations were exercised against a stub upstream (path, query
      and `Host` forwarded verbatim).
- [x] Unit tests (`npm test`): 1585 passing (1565 upstream + 20 in
      `test/selfhosted.test.ts`); the only 4 failures reproduce identically on
      untouched `master` (pre-existing `__dirname` ESM issue in
      `test/updates/signingCertificate.test.ts`).
- [x] Compose stack boots end-to-end: bootstrap created all 23 tables and 10
      buckets and registered the resizer webhook; every service healthy;
      verified through nginx: server-rendered pages (`/`, `/about`,
      `/programs`), the app shell, static assets, `/docs` and `/app`
      redirects, email signup (verification mail landed in mailpit),
      sign-in with a host-only session cookie, authenticated API calls,
      presigned upload URL → PUT to MinIO through nginx (SigV4 intact) →
      bucket-notification webhook → in-process sharp resize to 600×900 →
      image served back via `/userimages/*`. Fixes that testing surfaced:
      `.npmrc` missing from the server build, `build-licenses` crashing
      without native projects, IPv6 listen fatal on IPv6-less hosts,
      DynamoDB Local rejecting non-AWS-shaped access keys,
      `LIFTOSAUR_INTERNAL_HOST` for server-side fetches of static content,
      the hardcoded `.liftosaur.com` session-cookie domain, and absolute
      nginx redirects dropping the public port.

### WP7 — CI image publishing

- [x] `.github/workflows/selfhosted-images.yml` — on every push to the default
      branch (and manually via `workflow_dispatch`), builds both images and
      publishes them to GHCR as `<owner>/liftosaur-server` / `-web`, tagged
      `latest` + branch + SHA. The public URL comes from the `LIFTOSAUR_HOST`
      repository variable (default `http://localhost`).
- [x] `docker-compose.ghcr.yml` — overlay switching the stack from local builds
      to pulled images (`LIFTOSAUR_IMAGE_REPO`/`LIFTOSAUR_IMAGE_TAG`).

## Environment variable contract

| Variable | Required | Purpose |
|---|---|---|
| `LIFTOSAUR_SELF_HOSTED` | yes (`true`) | Master switch: env secrets, premium unlock, Rollbar/cloud no-ops. |
| `HOST` | yes | Public base URL of the deployment (e.g. `https://lift.example.com`). Already honored server-side. |
| `LIFTOSAUR_COOKIE_SECRET` | yes | JWT signing for session cookies. |
| `LIFTOSAUR_API_KEY` | yes | Admin/dashboard endpoint key. |
| `LIFTOSAUR_CRYPTO_KEY` | yes | Generated random string (part of the secrets contract; currently unused by any code path but validated at startup). |
| `DYNAMODB_ENDPOINT` | yes | e.g. `http://dynamodb:8000`. |
| `LIFTOSAUR_INTERNAL_HOST` | set by compose | Internal origin (`http://web`) for server-side fetches of static content (program data, exercise images) when the public `HOST` is not reachable from inside the network. |
| `S3_ENDPOINT` / `S3_PUBLIC_ENDPOINT` | yes / recommended | MinIO internal endpoint / host-reachable endpoint for presigned URLs. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | yes | MinIO credentials; any values for DynamoDB Local. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | recommended | Transactional email; without it, email verification/password reset are disabled (signup/login still work). |
| `ANTHROPIC_API_KEY` | no | Enables the AI Liftoscript generator. |
| `OPENAI_API_KEY` | no | Alternate LLM provider. |
| `ROLLBAR_SERVER_TOKEN` | no | Error reporting (off by default). |
| `PORT` / `STREAMING_PORT` | no | Server listen ports, default 3000 / 3001. |
| `LIFTOSAUR_WEBHOOK_TOKEN` | no | When set, the MinIO bucket-notification endpoint requires `Authorization: Bearer <token>`. |
| `COMMIT_HASH` / `FULL_COMMIT_HASH` | no | Build identifier, defaults to `selfhosted`. |
| `HTTP_PORT` | no | Host port the `web` container publishes, default `80`. Compose-only; keep `HOST` in sync with it. |
| `MAILPIT_UI_PORT` | no | Host port for mailpit's web UI, default `8025`. Compose-only. |
| `MINIO_NOTIFY_WEBHOOK_ENABLE_RESIZER` | no | Set to `true` on the `bootstrap` job to bind the `liftosauruserimages` bucket to MinIO's `RESIZER` webhook target (compose sets it). |
| Apple/Google IAP vars | no | Only for App Store / Play Store IAP verification — not meaningful for typical self-hosting. |

## Upstream conflict map

This fork merges upstream `astashov/liftosaur` regularly. Everything that can
live in `selfhosted/` does (`di.ts`, `envSecrets.ts`, `smtpSes.ts`, `server.ts`,
`cron.ts`, `bootstrap/`, `docker/`, `webpack.server.config.js`) plus
`docker-compose*.yml`, `env.example` and `docs/self-hosting/` — new files never
conflict. What follows is the complete list of *upstream-owned* files the fork
still modifies (derive it mechanically with
`git diff --diff-filter=M --stat <last-merged-upstream-sha>..HEAD`), and how to
resolve a conflict in each. `test/selfhosted.test.ts` pins the behavior of every
in-place gate, so a wrong resolution fails CI rather than silently reverting.

| File | What the fork changes | How to resolve a conflict |
|---|---|---|
| `lambda/utils.ts` | Adds `Utils_isSelfHosted()` (reads `LIFTOSAUR_SELF_HOSTED`). | Keep both: upstream's file + the added function. |
| `lambda/utils/dynamo.ts` | `DynamoUtil` takes an optional `clientConfig: DynamoDBClientConfig = {}` used by the lazy client getter. | Keep both: re-apply the constructor parameter and `new DynamoDBClient(this.clientConfig)` onto upstream's class. |
| `lambda/utils/s3.ts` | `S3Util` takes optional `clientConfig` / `presignerClientConfig`; presigned URLs are signed with `this.presignerS3`. | Keep both: re-apply the constructor parameters, the `presignerS3` getter, and the two `getSignedUrl(this.presignerS3, ...)` call sites. |
| `lambda/utils/response.ts` | Adds `ResponseUtils_sessionCookieDomain()` and uses it in `ResponseUtils_clearSessionCookie`. | Keep both: upstream's code + the helper; every `domain: ".liftosaur.com"` upstream adds must become the helper call. |
| `lambda/utils/subscriptions.ts` | `Subscriptions.hasSubscription` returns `true` early in self-hosted mode. | Keep both: upstream's verification logic with the 3-line short-circuit re-inserted at the top of the method. |
| `lambda/dao/buckets.ts` | `getUserImagesPrefix()` returns `${HOST}/userimages/` in self-hosted mode. | Keep both: upstream's env branches + the self-hosted branch first. |
| `lambda/dao/programDao.ts` | `getCdnHost()` prefers `LIFTOSAUR_INTERNAL_HOST`. | Keep both: prepend `process.env.LIFTOSAUR_INTERNAL_HOST ||` to upstream's expression. |
| `lambda/utils/programImageGenerator.ts` | Same `LIFTOSAUR_INTERNAL_HOST` precedence for `cdnHost`. | Keep both: prepend `process.env.LIFTOSAUR_INTERNAL_HOST ||`. |
| `lambda/index.ts` | Rollbar is optional (`ROLLBAR_SERVER_TOKEN`, no client at all in self-hosted mode) via `withRollbar()` + `rollbar?.`; session cookies use `ResponseUtils_sessionCookieDomain()`. | Keep both. New upstream `rollbar.` call sites become `rollbar?.`; new `rollbar.lambdaHandler(...)` wrappers become `withRollbar(...)`; new session cookies use the domain helper. |
| `lambda/streamingHandler.ts` | Same optional-Rollbar treatment. | Same as `lambda/index.ts`. |
| `lambda/imageResizer.ts` | Resize body extracted into `resizeImages(di, event)`; adds `getImageResizerHandler(diBuilder)` so the self-hosted server can inject its DI; `handler` keeps its external shape. | Take upstream's resize body verbatim and re-wrap it: body → `resizeImages`, then re-add the two exports at the bottom. |
| `src/utils/subscriptions.ts` | `Subscriptions_hasSubscription()` returns `true` when built with the `__SELF_HOSTED__` define. | Keep both: upstream's checks + the `declare const`/`isSelfHosted` preamble and the early return. |
| `webpack.config.js` | `LIFTOSAUR_HOST` / `LIFTOSAUR_API_HOST` / `LIFTOSAUR_STREAMING_API_HOST` overrides for the `DefinePlugin` host globals, plus a `__SELF_HOSTED__` define in each config. | Keep both: re-wrap upstream's host expressions in `hostDefine()`/`apiHostDefine()`/`streamingApiHostDefine()` and keep `__SELF_HOSTED__` in every `DefinePlugin` block. |
| `webpack.lambda.config.js` | Same overrides + `__SELF_HOSTED__`. | Same as `webpack.config.js`. |
| `scripts/build-licenses.ts` | `existsSync` guard around `android/app/build.gradle` (absent in the server image build). | Keep both: re-apply the guard to upstream's file list. |
| `tsconfig.json` | Adds `selfhosted/**/*` to `include`. | Keep both: re-add the entry. |
| `tsconfig.lambda.json` | Adds `selfhosted/**/*` to `include`. | Keep both: re-add the entry. |
| `package.json` | Adds `start:selfhosted` / `build:selfhosted` scripts; moves `nodemailer` to `dependencies` (the server bundle needs it at runtime). | Keep both: re-add the two scripts and keep `nodemailer` in `dependencies`. |
| `package-lock.json` | Follows `package.json`. | Regenerate: take upstream's lock, then `npm install`. |
| `.gitignore` | Un-ignores `/docs/self-hosting/`, ignores `/dist-selfhosted`. | Keep both: re-add the two lines. |
| `README.md` | Self-hosting callout block near the top. | Keep both: re-add the block. |

## Known gaps / follow-ups (out of scope for the first pass)

- **SEO/content literals**: dozens of `https://www.liftosaur.com/...` canonical
  URLs, OG tags, and doc links across `src/pages/**` are content, not infra —
  functionality is unaffected; a white-labeling pass can template them later.
- **Native mobile apps**: iOS/Android builds bake `__API_HOST__` at build time;
  pointing the apps at a self-hosted server requires a custom app build.
- **`lftPrograms` table**: unreferenced legacy; created for parity only.
- **Watch bundle / OTA updates**: `updatesDao` paths exist under the `static`
  bucket, but OTA signing (`LIFTOSAUR_UPDATES_PRIVATE_KEY`) is optional and off
  by default.
- **Repo hygiene**: `wrangler.toml` (dead Cloudflare Worker) and
  `_redirects`/`_headers` (Netlify-era) are candidates for removal.
