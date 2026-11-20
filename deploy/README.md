# Colgate App Foundry — deployment

Turns OpenArtifact into a campus discovery gallery at `https://<FOUNDRY_HOST>`, behind dual
institutional SSO (Google Workspace **and** Microsoft Entra ID), with a publisher MCP that Claude
for Enterprise calls to deploy generated apps onto Google's and Microsoft's runtimes.

```
                        ┌──────────────────── container host ────────────────────┐
 Browser (@colgate.edu) ┼─► caddy :443                                            │
                        │     ├─ /dex*     ─► dex ──► Google Workspace (hd lock)  │
                        │     │                  └──► Microsoft Entra (tenant lock)│
                        │     ├─ /mcp*     ─► publisher-mcp ──► Apps Script API    │
                        │     ├─ /link/*   ─► publisher-mcp (Google consent)       │
 Claude for Enterprise ─┼─────┘                                                    │
                        │     └─ /*        ─► oauth2-proxy ──► openartifact :4747  │
                        └────────────────────────────────────────────────────────┘
```

Only Caddy publishes ports. The gallery has no host port at all and cannot be reached without a
valid `@colgate.edu` session.

---

## 1. Register the two IdP clients

**Google Cloud Console** (Colgate org) → APIs & Services → Credentials → *Create OAuth client ID*

- Application type **Web application**, user type **Internal**
- Authorized redirect URIs:
  - `https://<FOUNDRY_HOST>/dex/callback` — sign-in
  - `https://<FOUNDRY_HOST>/link/google/callback` — Apps Script account linking
- Enable the **Apps Script API** on the project (Library → Apps Script API)

**Microsoft Entra admin center** → App registrations → *New registration*

- Supported account types: **Single tenant**
- Redirect URI (Web): `https://<FOUNDRY_HOST>/dex/callback`
- API permissions: Microsoft Graph → **User.Read** (delegated), granted admin consent
- Token configuration → Add optional claim → ID → check **`email`** and **`upn`**

  Entra only emits `email` when the user object actually has a `mail` attribute. Dex reads
  Graph `/me` and falls back to `userPrincipalName`, but oauth2-proxy's
  `OAUTH2_PROXY_EMAIL_DOMAINS=colgate.edu` check needs *something* ending in `@colgate.edu`. If
  your directory leaves `mail` empty for some accounts, add the `upn` claim and confirm it is the
  `@colgate.edu` form rather than an `onmicrosoft.com` one.

## 2. Bring the stack up

```bash
cp .env.example .env
```

```bash
$EDITOR .env
```

```bash
docker compose up -d --build
```

Point DNS for `<FOUNDRY_HOST>` at the host first — Caddy requests a certificate on startup.

## 3. Verify

```bash
curl -s https://<FOUNDRY_HOST>/dex/.well-known/openid-configuration | head -20
```

Should return the OIDC discovery document with `"issuer": "https://<FOUNDRY_HOST>/dex"`. If this
404s, something stripped the `/dex` prefix — see the note in `Caddyfile`.

Then open `https://<FOUNDRY_HOST>` in a browser. Expect Dex's connector chooser with **both** a
*Colgate Google Workspace* and a *Colgate Microsoft Entra ID* button. Sign in with each; after the
redirect the gallery should show your address in the header chip.

Confirm the identity actually reaches the gallery:

```bash
docker compose exec openartifact wget -qO- --header='X-Forwarded-Email: you@colgate.edu' http://localhost:4747/api/me
```

And confirm a client **cannot** forge it — this must come back as your real address, not the
injected one:

```bash
curl -s https://<FOUNDRY_HOST>/api/me -H 'X-Forwarded-Email: president@colgate.edu' -b "$COOKIE"
```

## 4. Register the connector in Claude

Organization settings → Connectors → *Add custom connector*

- URL: `https://<FOUNDRY_HOST>/mcp`
- Authentication: **Sign in when needed**
- OAuth client: **Use your own OAuth client**
  - Client ID `claude-foundry`
  - Client secret: your `CLAUDE_MCP_CLIENT_SECRET`

Authentication settings cannot be changed after a connector is added — to correct them, remove the
connector and add it again.

Then package `plugin/colgate-app-builder` as an Organization Plugin and enable it for the pilot
group. Note that **Skills must be enabled** under Organization settings → Library → Policy, or
plugins stop working.

## 5. Per-user prerequisite for Apps Script

Each person publishing to Apps Script must, once, visit
<https://script.google.com/home/usersettings> and turn **Google Apps Script API** to **On**.

This is a personal setting with no Workspace-admin override, and the Apps Script API returns an
opaque error without it. Put it in the pilot onboarding note.

---

## Things that look wrong but aren't

**`handle /dex*`, not `handle_path`.** Dex derives its endpoint paths from the path component of
its `issuer`, so it really does serve at `/dex/...` and needs the prefix intact. Stripping it
breaks discovery.

**Caddy has a network alias of the public hostname.** oauth2-proxy must fetch
`https://<FOUNDRY_HOST>/dex/.well-known/openid-configuration` — the issuer URL has to match the
`iss` claim exactly, so it cannot use an internal name. Without the alias that lookup leaves the
host and must hairpin back through the edge firewall, which campus networks usually drop. The
alias resolves the name to Caddy on the internal bridge; the public certificate still validates.

**`env_file: .env` on the dex service.** Dex expands `$VAR` in its config file from *its own*
environment, not Compose's. Without this, every secret in `dex.yaml` becomes an empty string and
sign-in fails with a misleading "invalid client".

**The `request_header -X-Forwarded-Email` lines.** The gallery trusts those headers
(`TRUST_PROXY_AUTH=1`). Stripping client-supplied copies at the edge is the only thing standing
between that trust and trivial impersonation. Never expose port 4747 directly, and never remove
these lines.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `invalid client` on any sign-in | `env_file: .env` missing from the dex service, or a blank secret in `.env` |
| 404 on `/dex/.well-known/openid-configuration` | the `/dex` prefix is being stripped — use `handle`, not `handle_path` |
| oauth2-proxy exits with a discovery/timeout error | the caddy network alias is missing, or DNS for `FOUNDRY_HOST` does not resolve yet |
| Redirect loop at sign-in | `OAUTH2_PROXY_REVERSE_PROXY` not `true`, so redirect URLs are built as `http://` |
| Entra sign-in succeeds, then "unauthorized domain" | no `@colgate.edu` email claim — add the `email`/`upn` optional claims |
| Caddy cannot get a certificate | inbound :80 blocked; switch to DNS-01 or `tls internal` (see `Caddyfile`) |
| Apps Script publish fails with an opaque error | the user has not turned on the Apps Script API in their personal settings |
