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

### Full-site YouTube, No Embedded Player (2026-11-02)

A direct official-player trial was implemented, tested, and confirmed by the
user to play. The user then explicitly required no embedded player anywhere
and no home-network relay. The trial was removed; the current browser keeps
full YouTube/Shorts through Scramjet. General missing-frame reload handling
was retained as a browser fix. No account data or approval policy changed.

With the current shared Codespace connection, Google can still require bot
verification or account sign-in. No anonymous full-site playback guarantee
is made. Automatically creating accounts does not remove network reputation
or identity-verification requirements; the app does not create shared Google
accounts, collect passwords, or automate CAPTCHA/phone verification. A usable
normal connection, legitimate user verification, or a supported player requires
relaxing at least one of the currently rejected alternatives.

No-embed recheck: 24 focused tests, full lint/typecheck, fresh production build,
and five targeted full-site browser regressions. The full browser suite and
real WebAuthn/owner-approval fixture passed before the player was withdrawn.
The earlier direct-player tests were transport/control fixtures, not proof
that the Codespace streamed public YouTube media.

The Vercel project's read-only integration listing reported no attached
resources. The prepared Neon database and Postgres migration remain separate
from video routing; neither the live datasource nor account data was changed.

### Owner-approved Passkeys (2026-11-02)

The additional access gate is tied to approved member passkeys, not a
supposedly personal IP. New additive fields store approval and bounded
observed network/browser context; member session records are bound to the
verified passkey. Unapproved successful sign-ins receive only an expiring
private approval-status receipt, never a browsing session/grant. Members
check approval and sign in again after the owner approves.

Use Admin Panel -> Devices to approve/revoke. Only fully authenticated
administrators can mutate approval, from a configured trusted origin.
Owner administration remains available so the owner is not locked out.
Revocation deletes member sessions; engine assets and HTTP proxies check
current authorization, and established Wisp/console sockets are rechecked
every 15 seconds. API outages no longer fall back to signature-only approval.

Existing member passkeys default to unapproved. The activation process takes
a private database/key backup and compares preserved account, face, payment,
public credential, and secret content after the additive migration. Existing
passcodes, biometric data, passkeys, and signing key are not reset.

IP addresses and User-Agent strings are review context only, not hardware
attestation. Networks can share/change addresses and request metadata can be
spoofed. Synced passkeys can work on several computers; this is not an
IP-only lock or a guarantee of physical-device binding. The public access
portal stays visible while authorized browsing/private data are protected.

The connected Neon resource did not change this app's production datasource:
inspection found a file: DATABASE_URL and no attached Neon/Postgres variables.
SQLite remains active. Connecting the Marketplace resource is not a tested
schema/data migration; no private data has been transferred to Neon here.

Add-on importing now also accepts bounded `.user.js` scripts with explicit
HTTP(S) @match metadata, page context, @grant none and document-end/idle timing.
Privileged manager APIs and external dependencies are rejected. This does
not implement Helium/Chrome's native extension engine or bypass YouTube rules.

Verified: 24 focused tests, full lint/typecheck, fresh production build,
real WebAuthn/approval/replay/tampering tests, and sixteen browser cases.
Tests verify valid socket survival, denied unapproved sessions, revoked
HTTP grants and open-socket closure, trusted-origin admin writes, owner-panel
privacy/mobile sizing, and real imported userscript execution.

### Connection Recovery and Minimal Home (2026-11-02)

Explicit navigations now create fresh Scramjet frames and remove old routing
registrations and stale callbacks. Known plain-text engine failures show a
recoverable page screen, including connection error 7, DNS error 6, and
timeout error 28. Retry uses a fresh navigation; Compatibility mode uses the
existing curl-backed proxy. Its banner switches back to the full engine on
the current page, not an earlier URL. Offline/network-blocked destinations
can still fail, but later navigation remains usable.

The home page uses a centered search/address field, compact site shortcuts,
and an unframed utility row with the existing wallpaper controls. Verified:
full lint/typecheck, fresh production build, 23 focused tests, the real
virtual-authenticator suite, and fourteen Chromium browser tests. Added
coverage waits for actual frame URL commits before reading page content,
checks registration cleanup over repeated site changes, and exercises failed
destination -> retry -> compatibility -> working page -> full engine.
Wikipedia, GitHub, Hacker News, and MDN loaded in the committed-document
site matrix. This is not a guarantee of universal website access.

### Appearance and Compatible Extensions (2026-11-02)

The new-tab wallpaper is a local full-cover photo, with Summit/Ocean/Forest
presets, a Graphite option, private image uploads, dimming, clock/quick-link
toggles, and reset. Controls are available through the new-tab sliders icon
and Settings -> Appearance. Uploads are raster-only, resized, bounded, and
saved to this browser's local storage; no image upload API is involved.

`about:extensions`, the toolbar puzzle icon, and the browser menu open a local
Manifest V3 content-script installer. It accepts compatible ZIP packages,
shows requested site matches, requires explicit trust, and supports
enable/disable/remove. JavaScript and CSS apply once to matching loaded web
documents, never to the workspace interface; reload matching pages after a
change. Site patterns, archive paths, expanded sizes, and storage are bounded.

This is not a Chrome extension engine. There are no Chrome APIs, isolated
worlds, background/service workers, browser permissions, extension popups,
native messaging, CRX/Web Store installation, or automatic updates. Imports
requiring these are rejected rather than shown as working. Compatible code
runs in page context and must be trusted with page data. Use real
Chrome/Chromium when a native extension is required. A minimal package
example is in README.md.

Verified: 22 focused tests, full lint/typecheck, fresh production build, real
virtual-authenticator sign-in with replay/origin/signature rejection, and
twelve browser regressions. Real-page tests cover extension CSS/DOM changes,
consent, disable/remove, compatibility errors, wallpaper persistence/upload,
and 320/390px controls. Screenshots exposed and verified a fix for the old
grid background rule accidentally tiling photo wallpapers.

YouTube still controls its bot/sign-in, IP, age/region, and playback rules.
No wallpaper, extension importer, or browser styling change can guarantee
anonymous playback. Full-site YouTube/Shorts and the explicit original-site
fallback remain intact; no account cookies or verification bypasses are used.

### WebAuthn Update (2026-11-02)

The login chain is now **password -> face -> passkey**. SimpleWebAuthn handles
real credential creation and assertion-signature verification. Successful
face scans produce a five-minute stage token, not a session. Sessions and
proxy grants require a completed passkey ceremony; old two-factor grants do
not satisfy the new gate. Existing accounts and face data are preserved.

On first login, existing users enroll a passkey after verifying their face.
New face enrollments also complete passkey enrollment before their pending
approval screen. An enrolled account must use its existing passkey on the
same workspace hostname. Administrator recovery codes plus a new face scan
can replace a lost admin authenticator; the bootstrap web reset is disabled
once an administrator is enrolled. Never delete the database for recovery.

Open the workspace in its own HTTPS browser tab. Press **Continue with
passkey** to trigger Touch ID, Windows Hello, a passkey PIN, or a security-key
prompt. Cross-origin preview frames get a clear open-in-own-tab action.
Unsupported devices get an error with alternatives, not an indefinite wait
or an automatic authentication bypass. Passkeys may sync across devices;
"fingerprint-only", "unextractable", and "always device-locked" are not
guarantees this website can make. No fingerprint images leave the device.

Set `WEBAUTHN_ORIGINS` on the backend to a comma-separated list of exact
trusted frontend origins when changing deployment domains. Defaults include
the production Vercel URL, the current Codespace gateway, and local 3000/8080
development. RP IDs are browser-default hostnames; the server verifies the
stored exact origin/RP pair, not arbitrary supplied hints. Challenges are
single-use, expire after two minutes, and bind to the face-verified stage.
User verification is required; ES256/RS256/EdDSA are pinned. Counters are
updated and checked where supported; zero-counter/synced credentials mean
counters alone cannot guarantee clone detection.

Verified: 17 focused tests, full lint/typecheck, a production build, real
Chromium virtual-authenticator registration/assertion and negative checks,
and all ten existing browser regressions using a passkey-complete session.
Run the new authentication fixture on an empty disposable backend with:

```bash
E2E_FRONTEND_ORIGIN=http://localhost:9181 bun run test:webauthn
E2E_FRONTEND_ORIGIN=http://localhost:9181 E2E_BACKEND_ORIGIN=http://localhost:9181 \
   E2E_PASSKEY_SESSION_FILE=.runtime/passkey-test-session.json bun run test:browser
```

The backend must allow that exact test origin through `WEBAUTHN_ORIGINS`.
Virtual-authenticator coverage does not claim that physical biometric
hardware was exercised. The older two-factor-only API fixture is historical;
use the new browser-based WebAuthn fixture for current authentication checks.

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

### Free-only Hosting Status

The user requires free hosting. Vercel Hobby is already connected. A Neon
resource named `browser-workspace-free-db` is ready on the explicit
`free_v3` / Free Marketplace plan; built-in Neon auth was disabled to avoid
replacing this application's password/face/WebAuthn policy. Provisioning used
`--no-connect --no-env-pull`, so no environment variable was overwritten and
the current application/database was not switched. Connection secrets were
not printed or committed. No paid resource was created.

The app still uses SQLite, not that empty Neon database. Before activating
Postgres: create and validate a PostgreSQL Prisma schema/client; transfer
records with a private backup and maintenance window; preserve IDs, encrypted
face data, secrets, passkeys/counters and date values; advance generated ID
sequences; test login, recovery, payments and proxy grants against a disposable
copy; then configure the approved server-side connection and cut over. Keep
the public frontend hostname unchanged for existing passkey RP bindings. Do
not paste a Neon connection string into chat or public configuration.

Neon does not run Caddy, face inference, Bun proxy processes, or persistent
Wisp WebSockets. Those still need compute. This Codespace's free allowance
and idle shutdown are not an always-on hosting guarantee, and overage charges
can apply. Use an existing machine or an eligible free VM with enough memory
for a free-only deployment; availability/quotas/provider rules must be checked
before claiming a permanently free service. The paid Render example below
must not be deployed under the current free-only constraint.

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
| Internal Service Worker Error / connection error 7 | Use the new Retry page / Compatibility mode controls. Each explicit navigation gets a fresh engine frame. A destination that is offline or blocked by the hosting network may still be unreachable. |
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
