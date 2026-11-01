# BROWSER

Scramjet browser workspace with password and face authentication, an admin
panel, a browser proxy engine, and a shell console.

Lineage: adapted from **scrm-jet** (scrm-jet.vercel.app) by **devperson8000**,
extended into a self-hosted multi-service workspace.

## Source Versions

The linked Z.ai preview is a separate deployment. Its reported WebAuthn
fingerprint/passkey flow, payment removal, and revised member registration
are not present in this repository's current source. The preview is reachable,
but its archive endpoints require authorization; a preview URL alone does
not provide the server implementation or database schema.

This version retains its existing password/face and approval/payment rules.
Import the updated source archive or accessible source repository before
claiming the newer authentication flow is included. Do not send account
passwords, WebAuthn recovery material, or API tokens through chat.

## Public Access

Open the browser at **https://linewizesucks.vercel.app**.
Vercel is connected and the frontend is deployed. Your existing workspace
password and face verification still apply; connecting Vercel does not
replace or reset your accounts.

The older `browser-workspace-eight.vercel.app` address returned
`DEPLOYMENT_NOT_FOUND`; use the verified production address above.

The frontend currently uses the protected backend at
https://ancient-wand-qvvq56g9rgv2x9xp-8080.app.github.dev. This Codespace must
remain running with `APP_MODE=production ./start-all.sh` for login, search,
face verification, and proxied browsing to work. A ready Vercel deployment
does not mean its backend is online. Codespaces idle timeouts and usage
charges apply; use a persistent Docker host for always-on availability.

Only gateway port 8080 is public. Internal service ports, the database,
signing key, and face templates must stay private. Vercel authentication is
already configured; do not paste device codes or account tokens into chat.

## Administrator Access

Choose **Admin** on the login screen, enter the separate administrator
passcode, then verify the enrolled administrator face. The member passcode
cannot grant admin access. Member and administrator password attempts now
have separate rate limits, with passcode visibility and Caps Lock controls.

Your stored passcodes were not changed. If the administrator passcode is
forgotten or still does not match, recover it from a private terminal on
the backend host:

```bash
./stop-all.sh
bun run admin:reset
APP_MODE=production ./start-all.sh
```

The command takes hidden input. It preserves member access, face enrollments,
payments, recovery codes, and the signing key, and revokes existing admin
login tokens. Do not delete the database or paste a passcode into chat.

## Browser and YouTube

YouTube opens as the full website through the browser engine. Shorts retain
YouTube's own feed, scrolling, links, and navigation; video pages are no
longer replaced by isolated embedded players. A new-tab shortcut opens the
Shorts feed. Media frames allow fullscreen and picture-in-picture.

Search/address suggestions distinguish **Open website** from **Search Bing**.
Search reloads, back/forward navigation, bookmarks, downloads, the console,
and reopening closed tabs remain available. Closed tabs can be reopened
from the browser menu or with `Ctrl+Shift+T`.

This is a proxy-based browser workspace, not a native Chromium browser.
YouTube can still require "Sign in to confirm that you're not a bot";
age/region restrictions, DRM, passkeys, and sites that reject proxies cannot
be guaranteed. No account cookies, verification bypasses, or shared Google
credentials are used. Login-service outages show a retry screen rather than
incorrectly offering the first-run wizard.

The latest live YouTube check still required bot verification and did not
start playback. **This is not fixed or bypassed.** The browser menu's
**Open original website** command opens the actual site in a separate tab
without workspace tokens, where normal provider verification can take place.

## Bookmarks and JavaScript

The bookmark manager now supports adding and editing both website bookmarks
and JavaScript bookmarklets. Open **Bookmarks → New bookmark → JavaScript**,
enter a name and code, and save. Existing `javascript:` links are accepted.

Open a web page, then click the saved script in the compact bookmarks bar.
Alternatively, choose an open page under **Run on** in the bookmark manager
and use that script's Run button. Each run asks for confirmation. Scripts
never run automatically, and **Open all** opens websites only.

Example for a visible page change:

```javascript
document.body.style.outline = "3px solid #45c6b0";
```

Code runs in the selected page, not on the server. Asynchronous scripts are
supported and runtime errors are displayed. Script return values do not
replace the document. Names and source code remain editable and are saved
in this browser's local storage. Run only trusted code: bookmarklets can read
and modify page data and are not a security sandbox. Workspace/internal
pages and missing target pages are rejected.

The UI now has a compact bookmarks bar, a responsive code editor, visible
edit/run controls, and dark notifications below the navigation controls.

## Verification

The source was reverified on 2026-11-01 with a fresh production build,
32 isolated authentication checks, nine real-browser checks, fourteen focused
tests, TypeScript, and full-project lint. Coverage includes
admin face login, member/admin rate-limit isolation, recovery data
preservation, page loading, search/reload, closed tabs, Shorts routing, and
mobile layout. Bookmarklet tests verify actual DOM changes, editing, reload
persistence, async execution, confirmation cancellation, target selection,
error reporting for synchronous throws and async rejections, and 320px editor
sizing. Errors are converted inside the target page before crossing the
proxy boundary, while successful script results remain unchanged.
YouTube verification remains an
explicitly observed upstream limitation, not a passing playback claim.

## Run Locally

Requires [Bun](https://bun.sh), [Node.js](https://nodejs.org) 20.9+ (22 LTS
recommended), [Caddy](https://caddyserver.com/docs/install), and Linux.

```bash
./start-all.sh
```

Open http://localhost:8080. The command installs dependencies, prepares the
database, and starts the app, services, and gateway. Stop with `./stop-all.sh`.

For a production build:

```bash
bun run build
APP_MODE=production ./start-all.sh
```

Docker is also supported: `docker compose up --build -d`. Stop the local
stack first if it already uses port 8080.

## Deploy

The frontend is deployed on **Vercel**, but the stateful backend cannot run
there. For permanent hosting, deploy the included Docker backend to a
persistent host, update Vercel's `BACKEND_ORIGIN` to that backend's HTTPS
origin, and redeploy. An optional [render.yaml](render.yaml) blueprint uses
a paid backend and persistent disk; no new paid backend has been provisioned.

After changing the frontend, deploy the linked project with `vercel --prod`.
Keep the real database and signing key on the backend, never in the Vercel
upload. If the Vercel homepage loads but login/search fails, check the
backend's `/api/health` endpoint first.

See [SETUP.md](SETUP.md) for the architecture, exact Vercel settings,
Render/VPS instructions, private data migration, verification, and troubleshooting.
The original design history is preserved in [worklog.md](worklog.md).

## Private Data

The uploaded archives, restored database/key, biometric fixtures, environment
files, logs, and test reports are excluded from Git and deployment uploads.
Keep the database and signing key together. Do not upload the original
archives to Vercel or a public repository.