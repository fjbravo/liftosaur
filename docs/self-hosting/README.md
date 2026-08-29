# Self-hosting Liftosaur

Run the whole app — web UI, API, database, object storage, background jobs — on your own
machine with Docker Compose. No AWS account, no cloud services.

For the engineering breakdown of how this works (what was AWS-specific and how each piece
was replaced), see [PLAN.md](./PLAN.md).

## Prerequisites

- Docker Engine 24+ with the Compose plugin (`docker compose version`)
- ~2 GB free RAM and ~4 GB disk for the images and volumes
- The first build compiles the web bundle and the server bundle from source and takes
  several minutes

## Quickstart

```bash
# from a clone of this repository, at its root
cp env.example .env

# generate the three required secrets and paste them into .env
openssl rand -hex 32   # LIFTOSAUR_COOKIE_SECRET
openssl rand -hex 32   # LIFTOSAUR_CRYPTO_KEY
openssl rand -hex 32   # LIFTOSAUR_API_KEY
# also replace AWS_SECRET_ACCESS_KEY (MinIO's root password) and LIFTOSAUR_WEBHOOK_TOKEN

docker compose up -d --build
```

Then open:

- the app: <http://localhost> (or whatever `HOST` you set)
- sent emails: <http://localhost:8025> (mailpit)
- health check: <http://localhost/healthz>

The `bootstrap` service runs once on every `up`, creates the DynamoDB tables and the MinIO
buckets, and exits 0. Watch it with `docker compose logs bootstrap`.

To use a port other than 80, set **both** `HTTP_PORT` and `HOST` — the public URL is
compiled into the images, so `HTTP_PORT=8080` needs `HOST=http://localhost:8080` and a
rebuild (`docker compose up -d --build`).

## Pulling prebuilt images (GitHub Actions)

Every push to the default branch runs `.github/workflows/selfhosted-images.yml`, which
builds both images and publishes them to GitHub Container Registry as
`ghcr.io/<owner>/liftosaur-server` and `ghcr.io/<owner>/liftosaur-web` (tagged `latest`,
plus the branch name and commit SHA). A deployment can then pull instead of building:

```bash
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

One-time setup:

1. **Set the build-time URL.** The public URL is baked into the images, so create a
   repository *variable* named `LIFTOSAUR_HOST` (GitHub → Settings → Secrets and
   variables → Actions → Variables) with the same value as `HOST` in your `.env`.
   Without it, images are built for the default `https://liftosaur.bylab.io`.
   Changing the variable requires a re-run of the workflow (it has a manual
   `workflow_dispatch` trigger).
2. **Make the images pullable.** Either make both GHCR packages public (GitHub →
   Packages → package → Package settings → Change visibility), or on the deployment
   host run `docker login ghcr.io` with a token that has `read:packages`.

To pin a specific build instead of `latest`, set `LIFTOSAUR_IMAGE_TAG` in `.env` to a
branch or `sha-…` tag from the workflow run. Updating the deployment is then:

```bash
git pull                        # for compose/env changes
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

## Keeping the fork up to date with upstream

`.github/workflows/upstream-sync.yml` runs weekly (Mondays 06:00 UTC, or manually via
`workflow_dispatch`) and, when upstream `astashov/liftosaur` has new commits, pushes them
to the `upstream-sync` branch and opens a PR into `master`. Merging that PR is the sync:
it keeps the self-hosting changes on top, and — because it is a push to `master` —
automatically publishes fresh images to GHCR.

Before opening the PR, the workflow also test-merges upstream into master locally (never
pushed) and, if that merge is clean, builds both Docker images from the merged tree
(without pushing them) as a smoke test. The PR body reports the result:

- **Conflicts** — listed in the PR body (and, if the PR was already open, as a comment
  too), so you resolve them the same way you'd resolve any merge conflict, right there
  when you merge the PR.
- **Clean merge, both images build** — the PR body says validation passed.
- **Clean merge, an image fails to build** — the PR body says which image failed and
  links the workflow run's logs, without blocking the PR from being opened.

This is needed because PRs and branches pushed with the default `GITHUB_TOKEN` don't
trigger other workflows (GitHub's recursion guard), so the sync PR itself gets no CI from
the image-build workflow below — without this validation step, a break in the Docker
builds would only surface after merging. The validation adds roughly 15 minutes to the
weekly run. The schedule only fires once the workflow file is on the default branch.

Separately, `.github/workflows/selfhosted-images.yml` also runs (build-only, no registry
push) on any pull request into `master` — including this sync PR if it's ever reopened
manually, and any other PR that touches the images — giving PRs a build check via normal
GitHub Actions status checks.

## What you get

| Works out of the box | Notes |
|---|---|
| Email/password signup and login | Verification and password-reset emails go through SMTP; with the bundled mailpit they land in the web UI at :8025. |
| All premium features | Self-hosted builds unlock the subscription gate on both the client and the server. |
| Programs, workouts, history, sync, sharing | Full parity with the hosted app. |
| User image uploads and profile images | Uploads go to MinIO; the resizer runs in-process on the server via a MinIO bucket notification. |
| Public API and admin endpoints | Guarded by `LIFTOSAUR_API_KEY`. |
| Daily stats job | The `cron` service; payment reconciliation stays off unless IAP env vars are set. |

| Needs extra setup | What to do |
|---|---|
| AI program generation | Set `ANTHROPIC_API_KEY` (and optionally `OPENAI_API_KEY`) in `.env` and restart. Or route through an OpenAI-compatible gateway you already run (9router, LiteLLM, …): set `LLM_BASE_URL` to its `/v1` base, `LLM_MODEL` to the model/alias it serves, and `LLM_API_KEY` (or reuse `ANTHROPIC_API_KEY`) to its key. |
| Real email delivery | Point `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` at your relay and remove the `mailpit` service. |
| "Sign in with Google/Apple" buttons | The server verifies tokens against Google's and Apple's public endpoints, but the buttons need OAuth client IDs registered for *your* domain and compiled into the web bundle. Email/password works without this. |
| Error reporting | Set `ROLLBAR_SERVER_TOKEN` to your own Rollbar project. Off by default — nothing is reported anywhere. |

Not applicable when self-hosting: in-app purchases, and the iOS/Android apps from the
stores (they are compiled against `liftosaur.com` and cannot be pointed elsewhere without
building the app yourself).

## Services

| Service | Image | Ports | Purpose |
|---|---|---|---|
| `web` | built from `selfhosted/docker/Dockerfile.web` | `${HTTP_PORT:-80}` → 80 | nginx: serves the static bundle, proxies API/page routes to `server`, `/stream/*` to the streaming port, and presigned S3 URLs to `minio`. |
| `server` | built from `selfhosted/docker/Dockerfile.server` | internal 3000 / 3001 | The same handlers that run as Lambdas in the hosted app: main API on 3000, AI streaming on 3001, plus `/healthz` and the MinIO webhook endpoint. |
| `cron` | same image, `node lambda/cron.js` | — | Daily stats job (23:40 UTC); weekly payment reconciliation only when IAP env vars are set. |
| `bootstrap` | same image, `node lambda/bootstrap.js` | — | One-shot, idempotent: 23 DynamoDB tables (+GSIs, TTL) and 10 MinIO buckets with their policies and the resizer notification. |
| `dynamodb` | `amazon/dynamodb-local` | internal 8000 | Database, persisted in the `dynamodb-data` volume. |
| `minio` | `minio/minio` | internal 9000 / 9001 | S3-compatible object storage, persisted in the `minio-data` volume. |
| `mailpit` | `axllent/mailpit` | `${MAILPIT_UI_PORT:-8025}` → 8025 | Development mail catcher: accepts every message and shows it in a web UI instead of delivering it. Replace it with a real SMTP relay for anything beyond a trial. |

MinIO's console (port 9001) and SMTP (port 1025) are not published to the host. Add a
`ports:` entry to those services in `docker-compose.yml` if you want them.

## Configuration

Every variable lives in `.env`; `env.example` documents all of them. The required ones are
`HOST`, `LIFTOSAUR_COOKIE_SECRET`, `LIFTOSAUR_CRYPTO_KEY`, `LIFTOSAUR_API_KEY`,
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (MinIO's root credentials — not real AWS
keys).

Two things are compiled into the images rather than read at runtime: `HOST` (as the app's
API/asset origin) and `LIFTOSAUR_SELF_HOSTED`. Changing `HOST` therefore requires
`docker compose up -d --build`, not just a restart.

Note that variables exported in your shell override `.env` in Compose. If you already have
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` exported for real AWS work, unset them (or run
Compose from a shell that does not have them) — otherwise they silently become MinIO's root
credentials.

## Data and backups

All state lives in two named volumes, `liftosaur_dynamodb-data` and `liftosaur_minio-data`
(the `liftosaur_` prefix is the Compose project name — the directory name).

Back them up with the containers stopped:

```bash
docker compose stop
docker run --rm -v liftosaur_dynamodb-data:/data -v "$PWD/backup":/backup alpine \
  tar czf /backup/dynamodb-data.tar.gz -C /data .
docker run --rm -v liftosaur_minio-data:/data -v "$PWD/backup":/backup alpine \
  tar czf /backup/minio-data.tar.gz -C /data .
docker compose start
```

Restore by untarring into the same volumes:

```bash
docker compose down
docker run --rm -v liftosaur_dynamodb-data:/data -v "$PWD/backup":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/dynamodb-data.tar.gz -C /data"
docker run --rm -v liftosaur_minio-data:/data -v "$PWD/backup":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/minio-data.tar.gz -C /data"
docker compose up -d
```

`docker compose down` keeps the volumes; `docker compose down -v` deletes them and all
your data with them.

## Running behind HTTPS

The `web` container speaks plain HTTP on port 80 by design. Put a TLS-terminating reverse
proxy (Caddy, Traefik, nginx, a cloud load balancer) in front of it:

1. Set `HOST=https://lift.example.com` in `.env`.
2. Set `HTTP_PORT` to a local-only port, e.g. `8080`, and point the proxy at it.
3. Rebuild: `docker compose up -d --build` (the public URL is baked into both images).
4. Have the proxy forward `Host` unchanged and set `X-Forwarded-Proto: https` — nginx
   passes both through, and presigned upload URLs are validated against the `Host` header.

Caddy example:

```
lift.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

WebSockets are not used, but AI generation streams over SSE on `/stream/*` — disable
response buffering for that path if your proxy buffers by default.

## Troubleshooting

**`docker compose logs bootstrap` shows "not reachable yet"** — normal on a cold start; it
retries for up to a minute while DynamoDB Local finishes booting. If it ends with
`Self-hosted bootstrap failed`, the message names the cause (a missing env var, or the
actual DynamoDB/MinIO error).

**"Missing required environment variable LIFTOSAUR_COOKIE_SECRET" in the server logs** —
`.env` is missing a required secret, or Compose was run from a different directory. `docker compose config` prints the
resolved environment for every service.

**Uploaded images 403 or never resize** — the presigned URL must be served by the same
origin as `HOST`. Check that `S3_PUBLIC_ENDPOINT` equals `HOST` (`docker compose config`),
and that `docker compose logs bootstrap` says "Registered resizer webhook notification".
MinIO logs a warning about an unreachable webhook endpoint if it starts before `server` —
it reconnects on its own.

**The app loads but every API call goes to `liftosaur.com`** — the web image was built with
a different `HOST`. Rebuild with `docker compose up -d --build`.

**Emails never arrive** — with the default config they are not supposed to leave the stack;
open mailpit at <http://localhost:8025>. For real delivery, set `SMTP_*` to your relay.

**Reset everything** — `docker compose down -v && docker compose up -d --build` gives you a
clean database and empty buckets.
