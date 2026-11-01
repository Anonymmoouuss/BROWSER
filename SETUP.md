# Scramjet Workspace — Setup & Run Guide

A single-user "browser-in-a-browser" workspace: a Next.js app that streams a
URL-rewriting web proxy (the [Scramjet](https://github.com/MercuryWorkshop/scramjet)
engine) into a locked-down browser UI, gated by SCRM-style access control
(password + face login, admin approval, $5/month payment windows, signed
session cookies, rate limits, audit trail).

Lineage: adapted from **scrm-jet** (scrm-jet.vercel.app) by **devperson8000**,
extended into a self-hosted multi-service workspace.

> Deep project knowledge — every architectural decision, bug hunt and fix —
> lives in **`worklog.md`** (start at the top). Read it before changing
> anything non-trivial.

## Current Deployment Status (2026-10-27)

The restored app runs locally at **http://localhost:8080**. Both local
production and Vercel-mode builds have been verified. A separate-origin
frontend/backend was checked in Chromium, including real proxied page
loading, an authenticated console connection, and mobile layout. The
production container passed 32 authentication checks, including administrator
face login and separate member/admin password throttling. Nine Chromium
browser checks and fourteen focused tests passed, including real bookmarklet
DOM changes and mobile code-editor layout.

The source was reverified on 2026-11-01 with a fresh production build,
full-project lint, TypeScript, and isolated browser/authentication data.
Bookmarklet synchronous and async errors are normalized inside the target
page before crossing the proxy, so their messages reach the workspace.

**Vercel frontend:** https://linewizesucks.vercel.app

**Protected backend:**
https://ancient-wand-qvvq56g9rgv2x9xp-8080.app.github.dev

Port 8080 is public, while ports 2019/3000/3030/3031/3032 remain private.
Anonymous checks confirm that the original workspace is initialized and
locked, administration/proxy access is denied, and private data paths return
404. Codespaces HTTPS requests use secure-cookie settings automatically.
The URL works only while the Codespace is running; idle timeouts, quotas,
and usage charges apply. No new paid hosting plan was provisioned.

Vercel is authenticated and the frontend has been deployed to the existing
linked project. Its production alias above was verified anonymously; the
older `browser-workspace-eight.vercel.app` alias no longer resolves. A
permanent always-on backend has not been provisioned. The Vercel frontend
still depends on the running Codespace for login, face inference, search,
and browsing. To move it later, change `BACKEND_ORIGIN` and redeploy.

To republish this gateway or make it private again from this Codespace:

```bash
gh codespace ports visibility 8080:public --codespace "$CODESPACE_NAME"
gh codespace ports visibility 8080:private --codespace "$CODESPACE_NAME"
```

Do not publish internal service ports. GitHub authentication already exists
in the Codespace; never paste GitHub tokens, passcodes, or keys into chat.

### YouTube Playback Limits

YouTube now stays on the full proxied website, including watch pages,
search, and the native Shorts feed. The previous automatic standalone-player
replacement was removed because it discarded Shorts scrolling and site
navigation. The new-tab Shorts tile opens `/shorts`; media permissions retain
fullscreen and picture-in-picture. Browser tests assert that Shorts stay on
the full-site route rather than becoming an embed.

YouTube still controls verification, IP reputation, age/region restrictions,
and playback. Earlier live datacenter testing returned **"Sign in to confirm
that you're not a bot"**. Restoring the full site does not remove that
requirement or promise anonymous playback. This workspace is not a native
Chromium engine; DRM, passkeys, and sites that reject proxies can remain
incompatible. No shared account cookies or verification bypasses are used.

The latest clean-browser full-site playback observation again returned the
bot-verification prompt with playback time zero. Use **Open original
website** in the browser menu for a normal provider tab; the link contains
the original URL, not a signed workspace grant. A different hosting network
may behave differently, but neither a bookmarklet nor a UI change can
guarantee that YouTube will remove its sign-in requirement.

### JavaScript Bookmarklets

Use the bookmark manager to create or edit a named **JavaScript** bookmark.
Raw source and existing `javascript:` links are supported. The compact
bookmarks bar runs a saved script on the current loaded page. In the manager,
select an existing page under **Run on**, then click the script's Run icon.
Each execution requires a trust confirmation. Websites and scripts are
visually distinct; bulk opening excludes scripts.

The executor uses the active proxied page's JavaScript context, as the Page
JS console does. It supports promises, reports cross-iframe errors, and
never treats a string result as replacement HTML. Internal workspace pages,
blank frames, and absent page targets are rejected. This restriction is not
a security sandbox: trusted code can still inspect or change page data.
Do not run copied code to access credentials or evade third-party checks.

Bookmarks and source code are stored locally in the browser. The editor
supports updating names, URLs, and code, with validation for empty scripts
and a 100,000-character source limit. Phone layouts were checked at 390px
and 320px, with visible edit/run controls and stable dialog margins.

### Administrator Sign-in and Recovery

Use the **Admin** tab with the administrator passcode and enrolled admin
face. Admin sessions open the Admin Panel; member sessions unlock browsing
under the existing approval/payment policy. Member retries no longer consume
the administrator password limit. Existing passcodes remain unchanged.

If the admin passcode is forgotten, the backend owner can run:

```bash
./stop-all.sh
bun run admin:reset
APP_MODE=production ./start-all.sh
```

For Docker, use `docker compose exec backend bun scripts/reset-admin-passcode.ts`
in a private interactive terminal, then restart the backend. Input is hidden
and arguments/piped passcodes are rejected. The command changes only the
admin passcode, revokes admin session/preauth/challenge tokens, and adds an
audit entry. Faces, member credentials, payments, recovery codes, and the
signing key are preserved. Do not delete `db/` for password recovery. A
password throttle window may take five minutes to expire.

When `/api/access` fails or returns invalid data, the login UI now displays a
retryable service-unavailable state, not the setup wizard. First-run setup is
shown only when the backend explicitly reports an uninitialized database.

---

## 1. Architecture (why it needs 5 processes)

| Port | Service | Runtime | Role |
|---|---|---|---|
| **:8080** | Caddy gateway | `caddy` | Single entry point. Only routes `XTransformPort=3030/3031`; other ports are rejected. |
| **:3000** | Next.js app | `bun run dev` | Login gate + first-run wizard, member enrollment, admin panel, the browser UI (tabs, omnibox, bookmarks), access-control API (`/api/access`), and rewrites for the engine's script assets. |
| **:3030** | browser-backend | `bun index.ts` | Legacy URL-rewriting proxy (`/api/proxy`, `/api/search`) + authenticated shell console WebSocket. |
| **:3031** | scramjet | `node supervisor.mjs` | The Scramjet proxy engine: service worker, controller, libcurl WASM transport, and the **wisp** WebSocket tunnel (`/wisp/`) through which proxied traffic actually leaves the machine. |
| **:3032** | face-auth | `node index.js` | Face recognition (128-dim descriptors, face-api + WASM models). `/verify` for login/enroll. |
| **:3034** | watchdog | `node index.js` | Optional development monitor. Disabled in production so it cannot wipe production build output. |

**Why the gateway is required:** the browser UI talks to the services with
same-origin URLs that carry `?XTransformPort=3030/3031` (e.g.
`/api/proxy?XTransformPort=3030&url=…`, `wss://host/wisp/?XTransformPort=3031`).
That query param is this project's port-routing convention — a plain Next.js
server has no idea what to do with it. Caddy (or any reverse proxy that
implements the same rule) makes it work; the included `Caddyfile` already
does. Next.js itself only reverse-proxies the engine's *static* script routes
(`/sw.js`, `/scram/*`, `/controller/*`, …) to :3031 internally (see
`next.config.ts` rewrites) — WebSockets cannot go through those, hence the
gateway.

On Vercel, API requests and engine assets are rewritten to `BACKEND_ORIGIN`
before local API routes run. The service worker stays on the frontend
origin, while Wisp and console WebSockets connect **directly** to the backend
origin. Vercel never needs the real database, engine key, or face service.

## 2. Prerequisites

- **Bun ≥ 1.1** — https://bun.sh (`curl -fsSL https://bun.sh/install | bash`)
- **Node.js 20.9+**, preferably Node 22 LTS (runs scramjet, face-auth, watchdog)
- **Caddy 2.11+** — https://caddyserver.com/docs/install (single binary)
- Linux with `curl` and `setsid`; 2 GB RAM and several GB free disk recommended
- Docker + Compose instead of the above runtimes for container hosting

## 3. Quick start

```bash
# Install dependencies and start the complete development stack.
./start-all.sh

# Open http://localhost:8080
```

`start-all.sh` installs root, scramjet, and face-auth dependencies, copies
`.env.example` to `.env`, generates Prisma, and applies the schema without
accepting data loss. It checks every requested service and exits nonzero
if anything fails readiness. Logs and managed process IDs live in `.runtime/`.

For a production app, stop the development stack first:

```bash
./stop-all.sh
bun run build
APP_MODE=production ./start-all.sh
```

The production launcher normalizes the SQLite URL and shares the original
`db/` directory with the standalone server. Rebuild after source changes.

Options: `START_APP=0`, `START_GATEWAY=0`, `START_WATCHDOG=0`, and
`GATEWAY_PORT=8085`. The default port is unprivileged; use port 81 only on a
host that permits binding it. A manually started gateway can use
`CADDY_ADDRESS=:8085 caddy run --config Caddyfile`.

### First run wizard

If the database is empty you'll get a first-run wizard: set the workspace
passcodes (user + admin) via a one-time setup secret, enroll the admin's face
from the webcam, then unlock. See `worklog.md` ("scrm-*" sections) for the
full SCRM semantics (member enroll → admin approve → $5 payment confirm →
camera login).

### This archive ships with existing workspace data

`db/custom.db` + `db/access-engine.key` are included so your passcodes, face
templates and payment history come with you. **Treat the archive as
sensitive** (password hashes, sealed face descriptors, HMAC secret). To start
pristine instead:

```bash
./stop-all.sh
mkdir -p .backups
cp -a db ".backups/db-$(date +%Y%m%d-%H%M%S)"
rm db/custom.db db/access-engine.key
./start-all.sh
```

This intentionally removes current access settings from the active database.
Use `bun run admin:reset` instead if only the administrator passcode was lost.
Keep the backup private. Complete first-run setup before sharing a new public
backend URL; a pristine workspace is not yet claimed by an administrator.

## 4. Database

SQLite via Prisma. `DATABASE_URL` lives in `.env`.

- Relative `file:` paths resolve **relative to `prisma/schema.prisma`**, so
  the default `file:../db/custom.db` = `<project>/db/custom.db`.
- If runtime ever complains it can't find the DB, use an **absolute** path:
  `DATABASE_URL=file:/abs/path/to/scramjet-workspace/db/custom.db`, then
  `bun run db:generate`.
- Schema changes: edit `prisma/schema.prisma` → `bun run db:push`.

## 5. Everyday commands

```bash
./start-all.sh          # (re)start any unhealthy service — safe to re-run
./stop-all.sh           # stop the processes managed by this checkout
STOP_APP=0 ./stop-all.sh # keep the Next.js app running
bun run lint            # eslint
bun run typecheck        # TypeScript
bun run test:deployment  # local/Vercel routing and WebSocket URL tests
bun run db:push         # apply prisma schema to sqlite
```

Service logs: `.runtime/<service>.log`. Shutdown targets recorded process
groups, not arbitrary services using matching ports. Development can use
the archived watchdog. Production containers exit if a service dies so
the hosting platform can restart the complete stack.

## 6. Vercel + Persistent Backend

Vercel can host the frontend, **not the complete stack**. The backend must
remain online for authentication, SQLite, face inference, and persistent
WebSockets. No paid resources have been created automatically.

### Option A: Render Backend

1. Publish only the source to a private Git repository. The uploaded archives,
   database, keys, biometric fixtures, logs, and backups must stay excluded.
2. In Render, create a Blueprint from `render.yaml`. Review current pricing
   before approving it: the blueprint selects a paid Standard service and a
   1 GB persistent disk. Free ephemeral services are unsuitable for SQLite.
3. Keep exactly one instance. Render mounts the disk at `/app/db`; the
   container initializes only an empty volume, never overwriting an existing
   database. The internal Caddy gateway listens on the supplied `PORT`.
4. Note the backend's public HTTPS origin, for example
   `https://scramjet-backend.example.onrender.com`. Verify `/api/health`
   and `/api/access` respond with JSON. Complete first-run setup or privately
   restore your existing data before sharing the URL.

The container includes the app/API, both proxies, face-auth, and Caddy.
Services run as the unprivileged `node` user after volume permissions are
prepared. The development watchdog is deliberately not started.

### Option B: Your VPS / Docker Host

```bash
docker compose up --build -d
docker compose logs -f backend
```

The included Compose file binds only `127.0.0.1:8080` and mounts `./db` at
`/app/db`. Put a TLS reverse proxy in front; do not expose internal service
ports. For a host Caddy instance:

```caddyfile
backend.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

For this HTTPS deployment, start Compose with
`FORWARDED_PROTO=https docker compose up --build -d` so session cookies are
secure. Leave it as `http` only for local HTTP testing. The same setting is
already included in the Render blueprint.

### Vercel Frontend

1. Import the source repository into Vercel with Root Directory `.` and the
   Next.js preset. `vercel.json` supplies the Bun install and build commands.
2. Set these environment variables for Production and any Preview deployment
   that should use the backend:

   | Variable | Value |
   |---|---|
   | `BACKEND_ORIGIN` | The backend's HTTPS origin, without a path or query |
   | `DATABASE_URL` | `file:../db/custom.db` (schema-generation placeholder only) |

3. Deploy or redeploy. `BACKEND_ORIGIN` is a build-time setting; changing it
   requires a new build. The public WebSocket origin is derived automatically.
4. Test login, enrollment, browsing, and the console from the Vercel URL.

CLI alternative, after the backend exists:

```bash
npx vercel login
npx vercel link
npx vercel env add BACKEND_ORIGIN production
npx vercel env add DATABASE_URL production
npx vercel --prod
```

Enter account credentials only in the provider's browser or terminal, never
in chat. Do not set `BACKEND_ORIGIN` on the backend itself or point it at the
Vercel frontend: either would cause routing loops. Do not upload a real
database, engine key, or face models to Vercel. A 401 from the engine while
logged out is correct, not a failed deployment.

### Moving Existing Data

Stop both source and destination services before copying SQLite files.
Use private SSH/SFTP or the host's private migration tooling to restore
`db/custom.db` **and** `db/access-engine.key` together into `/app/db`. Do not
put them in Git, a Docker layer, a Vercel environment variable, or public
object storage. Start the backend and check `/api/access`; it should report
`initialized: true` and remain locked until you authenticate. Keep regular
private backups and run a single backend instance against this volume.

## 7. Verification and Security Notes

Verified during restoration:

- Local and Vercel-mode production builds with TypeScript checking enabled.
- Fourteen focused tests covering routing, HTTPS validation, WebSocket URLs,
  login failures, bookmarklet parsing/execution, and cross-realm error handling.
- All 32 authentication regressions in a disposable production
  container, including enrollment, admin approval, payment, admin/member
  face login, wrong-face rejection, and single-use challenges.
- Nine Chromium browser checks: real proxied pages, console connections,
  administrator sign-in, search/reload, tab recovery, Shorts routing,
  bookmarklet DOM injection/errors, and desktop/mobile layout.
- Gateway allowlisting, unauthenticated 401 responses, face-inference
  self-test, and exclusions of private files from image/build traces.

The authentication regression is opt-in and refuses an initialized target:

```bash
E2E_BASE_URL=http://127.0.0.1:3000 bun e2e-assets/api-e2e.ts
```

Run it only inside a disposable backend with an empty database. It creates
test passcodes, faces, and payments. The browser regression then targets a
frontend built with `BACKEND_ORIGIN` pointing at that isolated backend:

```bash
E2E_FRONTEND_ORIGIN=http://127.0.0.1:3001 \
E2E_BACKEND_ORIGIN=http://127.0.0.1:8081 bun run test:browser
```

Use `bun x playwright install --with-deps chromium` on a suitable test host,
or the matching Playwright container if system browser libraries are absent.
The biometric fixtures were restored locally but are intentionally not
committed; these integration tests require those private fixture files.

Next.js and React were updated within their existing majors to address the
archived framework's security advisories. `bun audit --production` still
reports inherited advisories in other template dependencies, including
`next-auth`, which this app's custom access gate does not use. This is not a
claim of a clean security audit; review/remove unused dependencies before a
broad public release. Webcam matching is not hardware-backed Face ID or a
guarantee against photo/video spoofing. Treat URL-carried grants and service
logs as sensitive, and run only on a host you trust with shell access.

## 8. Repository layout

```
├─ src/                     Next.js app (app router)
│  ├─ app/                  / route, /api/access, /api/admin, /api/health
│  ├─ components/browser/   browser UI (tabs, omnibox, new-tab page, search)
│  └─ lib/browser/          shared.ts (routing constants), scramjet.ts (engine boot)
├─ mini-services/
│  ├─ browser-backend/      proxy + search + console WS (:3030)
│  ├─ scramjet/             engine + wisp tunnel (:3031)
│  ├─ face-auth/            face recognition (:3032)
│  └─ watchdog/             app revival monitor (:3034)
├─ prisma/schema.prisma     AccessConfig/AccessUser/AccessToken/AccessPayment/…
├─ db/                      custom.db + access-engine.key (your data!)
├─ e2e-assets/              QA scripts (Playwright harness; media fixtures excluded)
├─ Caddyfile                gateway config (XTransformPort routing)
├─ Dockerfile compose.yaml  persistent production backend
├─ render.yaml vercel.json  split-host deployment configuration
├─ scripts/ tests/          build/runtime helpers and deployment checks
├─ start-all.sh stop-all.sh
└─ worklog.md               ⭐ the project's real documentation
```

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| Login says "invalid response" | Start `./start-all.sh`; check `.runtime/app.log`. On Vercel, check `BACKEND_ORIGIN` and backend availability. |
| Browser tab won't unlock / engine never connects | Check `.runtime/scramjet.log`, the Caddy gateway, and direct WebSocket reachability to the backend. |
| Camera login always fails | Check `.runtime/face-auth.log`, lighting/frame quality, and camera permission. Public camera access requires HTTPS. |
| 401 from `/api/proxy` without being logged in | That's correct behavior (SCRM enforcement). |
| Search returns junk/empty occasionally | Expected transient: Bing throttling + DDG burst limits; the backend auto-falls-back and caches — see worklog "nav404-1". |
| Some AU news sites show "This site blocked the request" | Akamai blocks datacenter IPs by design; the friendly firewall page is the intended UX. |
| Prisma "database not found" | Use an absolute `DATABASE_URL`, then `bun run db:generate`. |
| Caddy cannot bind :81 | Use default port 8080 or another unprivileged `GATEWAY_PORT`; no root access is needed. |
| Vercel build requests `BACKEND_ORIGIN` | Deploy a persistent backend first and configure its HTTPS origin; localhost cannot work from Vercel. |
| Deployment works but data disappears | The backend needs a persistent `/app/db` mount, not an ephemeral filesystem. |
| Engine 400 for `XTransformPort=3032/3034` | Intentional: face verification and the watchdog must not be public gateway targets. |
