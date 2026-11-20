# Demo mode

Explore the whole Foundry locally — no Google or Entra app registrations, no Docker, no config.

```bash
node demo/run.js
```

Then open <http://localhost:4747>. Ctrl-C stops it and deletes the data; `--keep` persists it in
`demo/.data`.

Requires Node ≥ 22.13 (the gallery uses the built-in `node:sqlite`). Nothing to install.

## What to try

1. **Sign in.** You get Dex's connector chooser — Google Workspace or Microsoft Entra ID. Each
   leads to a list of sample `@colgate.edu` people instead of the real IdP.
2. **As Ross Cobb** (the only one in `FOUNDRY_ADMINS`): Backup, Drive and the folder ＋ are there.
3. **Switch to Alex Wu** at `/demo/switch`: those controls are gone, and so is the ability to edit
   anyone else's app. *My apps* narrows to his one card.
4. **Look at the cards.** Apps Script and Power Apps cards have no local preview — their code runs
   on a vendor runtime — so they show a launch panel, the owner, and the requested-scope count.
   Only `static-preview` cards get the sandboxed iframe.
5. **Publish, the way Claude would:**

```bash
node demo/publish.js
```

   It prints the JSON-RPC on the wire. Also useful:

```bash
node demo/publish.js --unauthenticated
```

```bash
node demo/publish.js --as jhartman@colgate.edu --list
```

6. **Watch a guardrail fire.** Publish as `awu@colgate.edu` to `apps-script` — he hasn't linked a
   Google account, so the tool explains the one-time consent instead of failing obscurely. Link him
   at `/link/google` and try again.

## Real vs emulated

This matters, because the point of the demo is to judge the design — so it should be clear which
parts are the real thing.

**Real** — this is the code that ships:

- the gallery (`server.js`) in multi-user mode
- the publisher MCP (`publisher-mcp/`), including genuine RS256 JWT verification against a JWKS
- identity-header stripping, ownership rules, admin gating, the SSRF guard
- the Apps Script manifest guardrails (`executeAs`, `access`) and the file-layout mapping
- the gallery API, folder routing, and card rendering

**Emulated** — `demo/run.js` plus the `FOUNDRY_DEMO` branches:

- **Caddy + oauth2-proxy** → the reverse proxy in `run.js`. It strips exactly the header list in
  `deploy/Caddyfile` and injects the session's identity, so the trust boundary behaves as designed.
- **Dex** → a sign-in chooser and a local JWKS. The tokens are genuinely RS256-signed and genuinely
  verified; only the upstream IdPs are stood in for.
- **Google consent** → `/link/google` marks the account linked without calling Google.
- **Apps Script deployment** → `deploy.js` returns a plausible `scriptId` and launch URL. Nothing
  is deployed. The result says `SIMULATED` and the manifest guardrails still run for real.

So the security properties are exercised; the two external IdPs and Google's deployment API are not.

## Things worth poking at

The impersonation defence, signed in as a non-admin:

```bash
curl -s http://localhost:4747/api/me -H 'X-Forwarded-Email: rcobb@colgate.edu' -b "foundry_demo=$COOKIE"
```

Comes back as *you*, not Ross — the proxy strips client-supplied identity headers before anything
downstream sees them. Without that, `TRUST_PROXY_AUTH=1` would be trivially forgeable.

The SSRF guard:

```bash
curl -s -X POST http://localhost:4747/api/import -H 'Content-Type: application/json' -d '{"url":"http://169.254.169.254/"}' -b "foundry_demo=$COOKIE"
```

A manifest that would run as the publisher rather than the viewer:

```bash
node demo/publish.js --as mlopez@colgate.edu --title "Bad" --runtime apps-script
```

(then edit `appsscript.json` in `demo/publish.js` to `executeAs: "USER_DEPLOYING"`)

## Never in production

`FOUNDRY_DEMO=1` makes deployments simulated and lets accounts be linked without Google. The
publisher logs a warning at startup when it is set, a demo link is refused outside demo mode, and
`deploy/docker-compose.yml` never sets it.
