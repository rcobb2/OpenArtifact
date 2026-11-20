---
name: colgate-app-builder
description: Build and publish Colgate University line-of-business web apps. Use whenever a Colgate user asks for a tool, dashboard, form, tracker, or internal app that touches campus data — Google Sheets, Drive, Gmail, Calendar, SharePoint, Dataverse, Outlook, or Teams — or asks to deploy, publish, or share an app with colleagues. Produces a React/TypeScript single-page app targeted at Google Apps Script or Power Apps Code Apps, with institutional sign-in enforced, and registers it in the Colgate App Foundry gallery.
---

# Colgate App Builder

Builds internal Colgate apps that run on a campus-sanctioned runtime, under the requesting
user's own identity, with every permission they request written down.

The gallery at <https://foundry.colgate.edu> is the campus index of what has been built. The
`colgate-foundry` MCP connector deploys and registers apps there.

## 1. Pick the runtime first

Before writing code, decide where the app will run. This is the single decision that shapes
everything after it, so settle it explicitly — and if the request doesn't make it obvious, ask.

| Signal | Runtime |
|---|---|
| Google Sheets, Drive, Docs, Gmail, Google Calendar, Google Forms | **Google Apps Script** |
| SharePoint, Dataverse, Outlook/Exchange, Teams, Power Automate | **Power Apps Code Apps** |
| No campus data at all — a calculator, a visualiser, a reference tool | **static-preview** (gallery only, no deployment) |

If both could work, prefer the one holding the data the app actually reads. Moving data across
the Google/Microsoft boundary is the thing to avoid, not the thing to build.

## 2. Build

Both targets are React + TypeScript, built with Vite. Keep the UI in `src/`, keep every call to
campus data behind a thin, named service module, and keep the bundle self-contained.

### Google Apps Script

Bundle the whole UI into a single `index.html` with
[`vite-plugin-singlefile`](https://www.npmjs.com/package/vite-plugin-singlefile) — Apps Script
serves one HTML file, not an asset directory.

```
index.html        # the built single-file bundle (HtmlService template)
Code.gs           # server-side entry points; native Workspace services
appsscript.json   # manifest, including explicit oauthScopes
```

- `Code.gs` holds `doGet()` returning `HtmlService.createHtmlOutputFromFile('index')`, plus the
  functions the UI calls via `google.script.run`.
- Use the native services — `SpreadsheetApp`, `DriveApp`, `GmailApp`, `CalendarApp`. Do not
  hand-roll REST calls against Google APIs from inside Apps Script; the native services are
  already authorized as the user.
- `appsscript.json` must set:

  ```json
  {
    "timeZone": "America/New_York",
    "exceptionLogging": "STACKDRIVER",
    "runtimeVersion": "V8",
    "oauthScopes": ["https://www.googleapis.com/auth/spreadsheets"],
    "webapp": { "access": "DOMAIN", "executeAs": "USER_ACCESSING" }
  }
  ```

  `"access": "DOMAIN"` keeps the app inside colgate.edu. `"executeAs": "USER_ACCESSING"` means
  it runs with the viewer's own permissions, so it can never show someone data they aren't
  entitled to. **Never** use `executeAs: "USER_DEPLOYING"` for a campus app — it would run every
  viewer's request with the deployer's access.

Start from `templates/apps-script/`.

### Power Apps Code Apps

```
src/              # React app
power.config.json # app metadata
.power/           # connector bindings written by `pa app add-data-source`
```

- Scaffold with `pac code init`, wire typed connectors with `pa app add-data-source`, build with
  Vite.
- Declare each connector the app binds, by name, in the scopes manifest.

Start from `templates/power-apps/`.

**Deployment is not yet automated for this target.** Power Apps Code Apps publish only through a
CLI, and the service-principal path is unreliable in preview — so `publish_to_colgate_foundry`
returns the built bundle plus the exact `pac code init` / `pa app push` commands for the user to
run, and files the gallery card as `deploy_status: pending`. Say this plainly when you hand the
app over; do not imply it is live.

## 3. Security guardrails

These are not stylistic preferences. An app that breaks one of them should not be published.

- **No hardcoded secrets.** No API keys, tokens, connection strings, or passwords in source — not
  even placeholder-looking ones. Apps Script uses `PropertiesService`; Code Apps use connector
  bindings. If a design seems to need a secret in the client, the design is wrong.
- **No arbitrary third-party scripts.** External `<script>` and `<link>` may only load from
  `cdnjs.cloudflare.com`, `cdn.jsdelivr.net/npm/`, or `unpkg.com`, pinned to an exact version.
  Prefer bundling the dependency outright.
- **Least privilege.** Request the narrowest scope that works — `drive.file` over `drive`,
  `spreadsheets.readonly` over `spreadsheets`. If you find yourself requesting broad scopes to
  save effort, narrow them instead.
- **No PII to third parties.** Campus data stays within the tenant. No analytics, no error
  reporting to outside services, no fonts or assets fetched from a host that would see a user id.
- **Say what it touches.** Every scope goes in the manifest below — that is what the gallery card
  shows reviewers.

## 4. Produce a scopes manifest

Before publishing, list every Workspace or M365 permission the app requests, with a plain-English
reason for each. This is what a reviewer reads to decide whether the app is reasonable.

```
https://www.googleapis.com/auth/spreadsheets   — read and write the roster sheet
https://www.googleapis.com/auth/drive.file     — create the exported PDF in the user's Drive
```

If a scope has no one-line justification, remove the scope.

## 5. Publish

Once the bundle compiles cleanly and the guardrails are satisfied, call the MCP tool:

```
publish_to_colgate_foundry({
  title:       "Course Roster Sync",
  description: "Pulls the Banner roster into a Sheet and flags enrollment changes.",
  runtime:     "apps-script",
  scopes:      ["https://www.googleapis.com/auth/spreadsheets", "..."],
  files: {
    "index.html":      "<the built single-file bundle>",
    "Code.gs":         "...",
    "appsscript.json": "..."
  }
})
```

- `runtime` is `apps-script`, `power-apps`, or `static-preview`.
- `files` keys are the deployed filenames; for `power-apps`, send the built `dist/` contents.
- The tool returns a `launch_url` for Apps Script deployments and a gallery link for all of them.

To revise an app you already published in this conversation, call `list_my_foundry_apps` to find
its id and pass `replaces: "<id>"` — otherwise the gallery accumulates duplicates.

**First time publishing to Apps Script?** The user must turn on *Google Apps Script API* at
<https://script.google.com/home/usersettings> once, and link their Google account at
<https://foundry.colgate.edu/link/google>. If the tool reports either is missing, relay the link
and stop — don't retry.

## 6. Hand it over

One short paragraph: what it does, where it runs, what it can touch, and the launch link.

> **Course Roster Sync** is live on Apps Script, running as whoever opens it, restricted to
> colgate.edu. It reads and writes the roster Sheet and can create files in your Drive.
> Launch: `https://script.google.com/a/macros/colgate.edu/s/…/exec` ·
> Gallery: `https://foundry.colgate.edu`

If deployment failed or is pending, say so in that same paragraph. Never describe an app as
deployed when the tool reported `pending`.
