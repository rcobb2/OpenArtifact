---
name: save-to-openartifact
description: Automatically archive every HTML or React/TSX artifact Claude generates into the user's self-hosted OpenArtifact vault via its HTTP API. Use this skill whenever you create, finish, or substantially revise any self-contained HTML or React component output — dashboards, widgets, games, visualizations, calculators, landing pages, reports rendered as HTML, .html files, or .tsx/.jsx components — even if the user doesn't mention the vault, saving, or archiving. The user wants ALL completed artifacts preserved in their vault without having to ask.
---

# Save to OpenArtifact

OpenArtifact is the user's personal, self-hosted vault for HTML artifacts (a gallery with folders, tags, and search, storing plain .html files on disk). This skill makes archiving automatic: when you finish an HTML artifact, send it to the vault so it's never lost in a chat scrollback.

## Configuration

```
VAULT_URL: http://localhost:4747
```

The user may override this URL in the conversation ("my vault is at https://vault.example.ts.net"). If you are running in an environment without access to the user's local network (e.g. claude.ai web chat executes server-side), `localhost` will not resolve to their machine — a public tunnel URL is required. If the configured URL is unreachable, follow "When the vault is unreachable" below.

## When to save

Save when an artifact is **complete**: you've finished generating it and presented it to the user, or the user signals the iteration is done ("looks good", "ship it", moves on to another topic). Two kinds of artifact qualify: a self-contained HTML document (inline CSS/JS, single file), and a self-contained React component (.tsx/.jsx with a default export — the vault transpiles and renders these itself, Tailwind classes and npm imports like recharts or lucide-react included).

Do not save: fragments or snippets shown for explanation, files that are part of the user's own codebase you're editing (their web app's index.html is their project, not an artifact), or every micro-revision during rapid iteration — wait for the version that sticks.

## How to save

POST the artifact to the vault's universal import endpoint. Use whatever HTTP mechanism the environment provides (bash + curl shown; fetch from JS or Python requests are equally fine):

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  --data @payload.json "$VAULT_URL/api/import"
```

with `payload.json`:

```json
{
  "html": "<the full artifact HTML>",
  "title": "Descriptive Title",
  "tags": "claude, <topic tags>",
  "notes": "<one line: what it is and what conversation/task produced it>",
  "folder": "Claude/<Topic or Project>"
}
```

Field conventions — these keep the vault organized without user effort:

- **title**: a clean human title (the artifact's `<title>` is used as fallback, but set it explicitly).
- **tags**: always include `claude`, plus 1–3 topic tags (`dashboard`, `game`, `finance`…). Comma-separated string is fine.
- **folder**: a path like `Claude/Dashboards` — the vault auto-creates missing folders. Use the project or topic name if the conversation has one (`Claude/<Project name>`), otherwise a sensible category. Prefer reusing folder names returned by `GET $VAULT_URL/api/folders` over inventing near-duplicates.
- **notes**: one sentence of provenance, e.g. "Pomodoro timer built in Claude chat, 2026-06-12, for Ross's focus-tracking experiment."

For React/TSX artifacts, send the component source in the same `html` field with `"kind": "tsx"` (the vault also auto-detects TSX, but being explicit is more reliable). For a file already on disk, a multipart upload avoids JSON-escaping — the extension sets the kind:

```bash
curl -sS -F "file=@artifact.html" -F "folder=Claude/Games" -F "tags=claude,game" "$VAULT_URL/api/import"
curl -sS -F "file=@component.tsx" -F "folder=Claude/Dashboards" -F "tags=claude,react" "$VAULT_URL/api/import"
```

A successful response is `201` with `{"imported": [{"id": "…", "title": "…", …}], "errors": []}`.

## Avoiding duplicates on revision

The vault has no content-update endpoint — re-importing creates a new entry. When you revise an artifact you already saved in this conversation, replace rather than accumulate: delete the old entry, then import the new version.

```bash
curl -sS -X DELETE "$VAULT_URL/api/artifacts/<previous-id>"
```

Keep track of the `id` from each import response for this purpose. If the user explicitly wants version history, skip the delete and add a `v2` tag instead.

## After saving

Confirm briefly in one line — title, folder, and the vault link — e.g. "Saved to your vault: *Pomodoro Timer* → Claude/Productivity (http://localhost:4747)". Don't narrate the mechanics.

## When the vault is unreachable

Never let archiving block or degrade the user's actual task — the artifact itself always comes first. If the import fails (connection refused, timeout):

1. Finish delivering the artifact normally.
2. Tell the user once, briefly: the vault at VAULT_URL wasn't reachable, and how to save manually (paste the HTML into the vault UI, or re-run the curl when it's up).
3. Don't retry repeatedly or attempt other ports/hosts, and don't ask again for the rest of the conversation unless the user says the vault is back up.
