# Colgate Publisher MCP

Remote MCP server that Claude for Enterprise calls to deploy a generated app onto a campus
runtime — **as the requesting user** — and register it in the App Foundry gallery.

```bash
node test.js
```

33 end-to-end checks against a fake Dex, a real gallery and the real server. No network needed.

## Two credentials, two jobs

This is the part worth understanding before changing anything.

**Identity — a Dex-issued JWT.** Claude presents a bearer token from the `claude-foundry` static
client (`deploy/dex.yaml`); `identity.js` verifies it against the Dex JWKS and extracts a verified
`@colgate.edu` address.

Claude also supports a static request-header credential, which would be far less code. It is not
usable here: a shared token authenticates the *connector*, not the person, and this server has to
know the person — it stamps `owner_email` on every published app and `list_my_foundry_apps`
answers "mine" per user. A shared token would make every app in the gallery appear to belong to
the same principal.

**Capability — a Google refresh token.** Obtained through a *separate* consent at `/link/google`
and stored encrypted (`tokens.js`). Two reasons it cannot be folded into the first:

1. Dex cannot mint Apps Script scopes — it brokers identity, not Workspace capability.
2. The Apps Script API does not work with service accounts at all, so deployment *must* use
   delegated user credentials. There is no app-only path to fall back to.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `POST /mcp` | Dex JWT | the MCP endpoint Claude calls |
| `GET /.well-known/oauth-protected-resource` | none | RFC 9728 metadata; points Claude at Dex |
| `GET /link/google` | SSO (Caddy `forward_auth`) | starts the Apps Script consent |
| `GET /link/google/callback` | SSO | stores the refresh token |
| `GET /healthz` | none | liveness |

A 401 from `/mcp` carries `WWW-Authenticate` with `resource_metadata`, which is how Claude
discovers where to authenticate.

## Tools

**`publish_to_colgate_foundry`** — takes `title`, `description`, `runtime`, `scopes`, `files`, and
an optional `replaces` (a previous gallery id, so revisions don't accumulate duplicate cards).
Returns the gallery id and link, the deploy status, and a `launch_url` where one exists.

**`list_my_foundry_apps`** — the caller's own published apps, with ids for `replaces`.

## Deployment status

| Runtime | State |
|---|---|
| `static-preview` | **working** — gallery card only, no deployment |
| `apps-script` | **scaffolded** — full call sequence written, guarded by `APPS_SCRIPT_LIVE` |
| `power-apps` | **handoff by design** — returns the bundle and CLI commands |

### Apps Script

`deploy.js` implements the whole sequence:

```
POST /v1/projects                      { title }        -> scriptId
PUT  /v1/projects/{id}/content         { files[] }
POST /v1/projects/{id}/versions        { description }  -> versionNumber
POST /v1/projects/{id}/deployments     { versionNumber, manifestFileName: "appsscript" }
```

It is behind `APPS_SCRIPT_LIVE=1` because it has never been run against a real Colgate Google
client. Everything around it — identity, token refresh, manifest validation, gallery
registration — is live and tested. To enable: configure `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`,
run the sequence by hand once, then set the flag.

Two guardrails run *before* any network call and are covered by tests: the manifest must set
`webapp.executeAs = "USER_ACCESSING"` (otherwise every viewer would run with the publisher's
access to campus data) and `webapp.access = "DOMAIN"`.

### Power Apps

Not a stub to be filled in later — a deliberate handoff. Code Apps have no deployment REST API;
publishing runs through a CLI, `pac code push` is preview and slated for replacement, the
service-principal path returns 500s, and a service principal cannot create a new code app at all.
So the tool returns the built bundle plus the exact `pac auth create --deviceCode` /
`pac code init` / `pa app push` commands, and files the card as `pending`. Revisit when the npm
CLI gains non-interactive auth.

## Environment

| Variable | Purpose |
|---|---|
| `PORT` | listen port (default 8080) |
| `FOUNDRY_HOST` | public hostname, used to build redirect and launch URLs |
| `GALLERY_INTERNAL_URL` | the gallery on the internal network |
| `INTERNAL_API_TOKEN` | shared with the gallery for service imports |
| `DEX_ISSUER` | the Dex issuer URL |
| `MCP_CLIENT_ID` | expected JWT audience (`claude-foundry`) |
| `ALLOWED_EMAIL_DOMAIN` | `colgate.edu` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | the Apps Script link flow |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes hex; encrypts refresh tokens at rest |
| `APPS_SCRIPT_LIVE` | `1` to enable real Apps Script deployment |

## Per-user prerequisite

Each person publishing to Apps Script must once turn on **Google Apps Script API** at
<https://script.google.com/home/usersettings>. It is a personal setting with no Workspace-admin
override, and the API fails opaquely without it — `deploy.js` detects the characteristic error
and says so rather than surfacing the raw message.
