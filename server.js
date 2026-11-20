#!/usr/bin/env node
/**
 * OpenArtifact — a personal vault for AI-generated HTML artifacts.
 * Zero-dependency Node server: node:http + node:sqlite.
 * Artifacts live as plain .html files on disk (folders = real subdirectories);
 * SQLite indexes metadata.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const dns = require('node:dns').promises;
const net = require('node:net');
const { recordRequest, renderMetrics } = require('./metrics.js');

const PORT = parseInt(process.env.PORT || '4747', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ARTIFACTS_DIR = path.join(DATA_DIR, 'artifacts');
const SEED_DIR = path.join(__dirname, 'seed');
const MAX_BODY = 20 * 1024 * 1024; // 20 MB

// --- Colgate App Foundry configuration -------------------------------------
// Every one of these is OFF by default: with no env set, OpenArtifact behaves
// exactly as the single-user localhost vault it has always been.

/** Trust X-Forwarded-Email / X-Forwarded-User from an authenticating proxy
 *  (oauth2-proxy). Turns the vault into a multi-user gallery. */
const TRUST_PROXY_AUTH = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY_AUTH || '');
/** Comma-separated emails allowed to touch global vault settings. */
const ADMINS = new Set((process.env.FOUNDRY_ADMINS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
/** Shared secret for service-to-service ingestion (publisher-mcp -> gallery). */
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || '';
/** Hosts a launch_url may point at. Deployed apps live on vendor runtimes. */
const LAUNCH_HOSTS = new Set((process.env.LAUNCH_URL_HOSTS
  || 'script.google.com,apps.powerapps.com,make.powerapps.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
/** Restore the old, unrestricted URL-import behaviour (localhost use only). */
const ALLOW_PRIVATE_IMPORT = /^(1|true|yes)$/i.test(process.env.ALLOW_PRIVATE_IMPORT || '');

const RUNTIMES = new Set(['static-preview', 'apps-script', 'power-apps']);
const DEPLOY_STATES = new Set(['none', 'pending', 'deployed', 'failed']);
const LOCAL_USER = { email: '', name: 'local', isAdmin: true, isService: false, anonymous: true };

fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

// ---------------------------------------------------------------- database
const db = new DatabaseSync(path.join(DATA_DIR, 'index.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS artifacts (
    id         TEXT PRIMARY KEY,
    filename   TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    tags       TEXT NOT NULL DEFAULT '[]',
    notes      TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT '',
    size       INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS folders (
    id         TEXT PRIMARY KEY,
    parent_id  TEXT REFERENCES folders(id),
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

/** Add a column to `artifacts` if it isn't there yet. Idempotent, so every
 *  startup safely migrates vaults created by any earlier version. */
function ensureColumn(name, ddl) {
  const cols = db.prepare('PRAGMA table_info(artifacts)').all();
  if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE artifacts ADD COLUMN ${ddl}`);
}

// migration for vaults created before folders existed
ensureColumn('folder_id', 'folder_id TEXT REFERENCES folders(id)');

// Foundry columns: where a published app actually runs, and who owns it.
ensureColumn('runtime', "runtime TEXT NOT NULL DEFAULT 'static-preview'");
ensureColumn('launch_url', 'launch_url TEXT NOT NULL DEFAULT \'\'');
ensureColumn('scopes', "scopes TEXT NOT NULL DEFAULT '[]'");
ensureColumn('owner_email', 'owner_email TEXT NOT NULL DEFAULT \'\'');
ensureColumn('deploy_status', "deploy_status TEXT NOT NULL DEFAULT 'none'");
ensureColumn('external_id', 'external_id TEXT NOT NULL DEFAULT \'\'');

// ----------------------------------------------------------------- helpers
const newId = () => crypto.randomBytes(5).toString('hex');
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function slugify(s) {
  return (s || 'untitled').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
}

function extractTitle(html) {
  let m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m && m[1].trim()) return decodeEntities(m[1].trim()).slice(0, 200);
  m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (m) {
    const t = decodeEntities(m[1].replace(/<[^>]+>/g, '').trim());
    if (t) return t.slice(0, 200);
  }
  return 'Untitled artifact';
}

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' }[e]));
}

function looksLikeHtml(s) {
  return /<\s*(!doctype|html|head|body|div|svg|script|style|h1|p|canvas|main|section)\b/i.test(s);
}

/** Heuristic: React/TSX component source (not a full HTML document). */
function looksLikeTsx(s) {
  return /\bimport\s[^;]*from\s*['"]react|\bexport\s+default\b|\buse(State|Effect|Ref|Memo|Callback)\s*\(/.test(s)
    && !/<\s*(!doctype|html|head|body)\b/i.test(s);
}

const artifactKind = (filename) => /\.(tsx|jsx)$/i.test(filename) ? 'tsx' : 'html';

function extractTsxTitle(src) {
  const m = src.match(/export\s+default\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/)
    || src.match(/export\s+default\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/m)
    || src.match(/(?:function|const|class)\s+([A-Z][A-Za-z0-9_]*)/);
  if (m) return m[1].replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return 'Untitled component';
}

const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Render shell for .tsx/.jsx artifacts: transpiles in the (sandboxed) browser
 * with Babel standalone, resolves bare imports via esm.sh pinned to one React,
 * and mounts the default export. Tailwind is included because most AI-generated
 * components assume its utility classes. Needs internet at view time.
 */
function tsxWrapperHtml(title, source) {
  const json = JSON.stringify(source).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script src="https://cdn.tailwindcss.com"><\/script>
<script src="https://unpkg.com/@babel/standalone@7/babel.min.js"><\/script>
<style>html,body{margin:0;min-height:100%}#root{min-height:100vh}.oa-err{font:13px/1.5 ui-monospace,monospace;color:#b91c1c;padding:16px;white-space:pre-wrap}</style>
</head><body><div id="root"></div>
<script id="src" type="application/json">${json}<\/script>
<script type="module">
const REACT_V = "18.3.1";
const cdn = (spec) => {
  if (spec === "react" || spec.startsWith("react/")) return "https://esm.sh/" + spec.replace(/^react/, "react@" + REACT_V);
  if (spec === "react-dom" || spec.startsWith("react-dom/")) return "https://esm.sh/" + spec.replace(/^react-dom/, "react-dom@" + REACT_V);
  return "https://esm.sh/" + spec + "?deps=react@" + REACT_V;
};
const fail = (e) => {
  const pre = document.createElement("pre");
  pre.className = "oa-err";
  pre.textContent = "Failed to render component:\\n" + ((e && e.message) || e);
  document.getElementById("root").replaceChildren(pre);
};
try {
  const src = JSON.parse(document.getElementById("src").textContent);
  const out = Babel.transform(src, { filename: "artifact.tsx", presets: [["react", { runtime: "automatic" }], "typescript"] }).code;
  const rewritten = out
    .replace(/(from\\s*["'])([^"'.\\/][^"']*)(["'])/g, (m, a, s, b) => a + cdn(s) + b)
    .replace(/(import\\s*["'])([^"'.\\/][^"']*)(["'])/g, (m, a, s, b) => a + cdn(s) + b)
    .replace(/(import\\s*\\(\\s*["'])([^"'.\\/][^"']*)(["'])/g, (m, a, s, b) => a + cdn(s) + b);
  const mod = await import(URL.createObjectURL(new Blob([rewritten], { type: "text/javascript" })));
  const Comp = mod.default || Object.values(mod).find((v) => typeof v === "function");
  if (!Comp) throw new Error("No exported React component found (add an 'export default').");
  const React = await import(cdn("react"));
  const { createRoot } = await import(cdn("react-dom/client"));
  createRoot(document.getElementById("root")).render(React.createElement(Comp));
} catch (e) { fail(e); }
addEventListener("unhandledrejection", (e) => fail(e.reason));
<\/script></body></html>`;
}

function normalizeTags(tags) {
  if (typeof tags === 'string') tags = tags.split(',');
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 32);
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// -------------------------------------------------------------------- auth
/**
 * Resolve the caller.
 *
 * Multi-user mode (TRUST_PROXY_AUTH=1) reads the identity oauth2-proxy stamped
 * on the request. That is only sound because the edge proxy strips any
 * client-supplied X-Forwarded-Email/-User before forwarding — see
 * deploy/Caddyfile. Never expose this port directly.
 *
 * A request bearing the INTERNAL_API_TOKEN is publisher-mcp acting on a user's
 * behalf; it must name that user itself, since there is no browser session.
 */
function currentUser(req) {
  if (INTERNAL_API_TOKEN) {
    const auth = String(req.headers['authorization'] || '');
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m && crypto.timingSafeEqual(
      crypto.createHash('sha256').update(m[1]).digest(),
      crypto.createHash('sha256').update(INTERNAL_API_TOKEN).digest(),
    )) {
      return { email: '', name: 'publisher-mcp', isAdmin: true, isService: true, anonymous: false };
    }
  }
  if (!TRUST_PROXY_AUTH) return LOCAL_USER;
  const email = String(req.headers['x-forwarded-email'] || '').trim().toLowerCase();
  if (!email) return null;
  return {
    email,
    name: String(req.headers['x-forwarded-preferred-username'] || req.headers['x-forwarded-user'] || email).trim(),
    isAdmin: ADMINS.has(email),
    isService: false,
    anonymous: false,
  };
}

/** The caller, or a 401 if multi-user mode is on and nobody is signed in. */
function requireUser(req) {
  const u = currentUser(req);
  if (!u) throw httpError(401, 'Not authenticated — this vault is behind institutional SSO');
  return u;
}

function requireAdmin(req) {
  const u = requireUser(req);
  if (!u.isAdmin) throw httpError(403, 'Administrators only');
  return u;
}

/** Owner or admin. Service calls act for a named owner and are checked there. */
function canModify(user, artifact) {
  if (user.isAdmin || user.anonymous) return true;
  return !!artifact.owner_email && artifact.owner_email === user.email;
}

function assertCanModify(user, artifact) {
  if (!canModify(user, artifact)) throw httpError(403, 'This app belongs to someone else');
}

/**
 * Who should own something the caller is creating. A browser request owns it
 * itself; publisher-mcp is acting for somebody and has to say who, since the
 * service token carries no identity of its own.
 */
function ownerFor(user, payload = {}) {
  if (user.isService) {
    const email = String(payload.owner_email || '').trim().toLowerCase();
    if (!email) throw httpError(400, 'owner_email is required on service-token imports');
    return email;
  }
  return user.email;
}

/** A launch link must point at a known vendor runtime, never anywhere else —
 *  otherwise a gallery card becomes an open redirect wearing a Colgate badge. */
function normalizeLaunchUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch { throw httpError(400, 'launch_url is not a valid URL'); }
  if (u.protocol !== 'https:') throw httpError(400, 'launch_url must be https://');
  if (!LAUNCH_HOSTS.has(u.hostname.toLowerCase())) {
    throw httpError(400, `launch_url host not allowed: ${u.hostname} (allowed: ${[...LAUNCH_HOSTS].join(', ')})`);
  }
  return u.toString();
}

function normalizeRuntime(value) {
  const r = String(value ?? '').trim().toLowerCase() || 'static-preview';
  if (!RUNTIMES.has(r)) throw httpError(400, `Unknown runtime: ${r} (expected ${[...RUNTIMES].join(', ')})`);
  return r;
}

function normalizeDeployStatus(value) {
  const d = String(value ?? '').trim().toLowerCase() || 'none';
  if (!DEPLOY_STATES.has(d)) throw httpError(400, `Unknown deploy_status: ${d}`);
  return d;
}

/** OAuth scope strings a deployed app requests, kept for the audit card. */
function normalizeScopes(scopes) {
  if (typeof scopes === 'string') scopes = scopes.split(/[\s,]+/);
  if (!Array.isArray(scopes)) return [];
  return [...new Set(scopes.map((t) => String(t).trim()).filter(Boolean))].slice(0, 64);
}

// ----------------------------------------------------------------- folders
function getFolder(id) {
  return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
}

/** Path segments (folder names) from root to this folder. */
function folderSegments(id) {
  const segs = [];
  let cur = id, guard = 0;
  while (cur) {
    const f = getFolder(cur);
    if (!f) throw httpError(404, 'Folder not found');
    segs.unshift(f.name);
    cur = f.parent_id;
    if (++guard > 100) throw httpError(500, 'Folder hierarchy too deep / cyclic');
  }
  return segs;
}

const folderDiskPath = (id) => id ? path.join(ARTIFACTS_DIR, ...folderSegments(id)) : ARTIFACTS_DIR;
const folderDisplayPath = (id) => id ? folderSegments(id).join(' / ') : '';
const artifactDiskPath = (a) => path.join(folderDiskPath(a.folder_id), a.filename);

function sanitizeFolderName(name) {
  const n = String(name ?? '').trim()
    .replace(/[\/\\:*?"<>|]|[\u0000-\u001f]/g, '-').replace(/^\.+/, '').slice(0, 80).trim();
  if (!n) throw httpError(400, 'Invalid folder name');
  return n;
}

function assertValidParent(parentId) {
  if (parentId == null) return null;
  if (!getFolder(parentId)) throw httpError(404, 'Parent folder not found');
  return parentId;
}

function assertSiblingNameFree(name, parentId, excludeId = null) {
  const rows = parentId == null
    ? db.prepare('SELECT id, name FROM folders WHERE parent_id IS NULL').all()
    : db.prepare('SELECT id, name FROM folders WHERE parent_id = ?').all(parentId);
  if (rows.some((r) => r.id !== excludeId && r.name.toLowerCase() === name.toLowerCase())) {
    throw httpError(409, `A folder named “${name}” already exists here`);
  }
}

function descendantFolderIds(id) {
  const out = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const r of db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(cur)) {
      out.push(r.id); stack.push(r.id);
    }
  }
  return out;
}

function createFolder({ name, parent_id = null }) {
  name = sanitizeFolderName(name);
  parent_id = assertValidParent(parent_id);
  assertSiblingNameFree(name, parent_id);
  const id = newId();
  db.prepare('INSERT INTO folders (id, parent_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run(id, parent_id, name, new Date().toISOString());
  fs.mkdirSync(folderDiskPath(id), { recursive: true });
  return { id, parent_id, name };
}

function updateFolder(id, { name, parent_id }) {
  const f = getFolder(id);
  if (!f) throw httpError(404, 'Folder not found');
  const oldDisk = folderDiskPath(id);
  const newName = name !== undefined ? sanitizeFolderName(name) : f.name;
  let newParent = f.parent_id;
  if (parent_id !== undefined) {
    newParent = parent_id === null || parent_id === '' ? null : parent_id;
    if (newParent === id || (newParent && descendantFolderIds(id).includes(newParent))) {
      throw httpError(400, 'Cannot move a folder into itself');
    }
    assertValidParent(newParent);
  }
  assertSiblingNameFree(newName, newParent, id);
  db.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?').run(newName, newParent, id);
  const newDisk = folderDiskPath(id);
  if (newDisk !== oldDisk) {
    try {
      fs.mkdirSync(path.dirname(newDisk), { recursive: true });
      fs.renameSync(oldDisk, newDisk);
    } catch (e) {
      db.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?').run(f.name, f.parent_id, id);
      throw httpError(500, `Could not move folder on disk: ${e.message}`);
    }
  }
  return getFolder(id);
}

/** Delete folder + subfolders; contained artifacts move to Unsorted (root). */
function deleteFolder(id) {
  const f = getFolder(id);
  if (!f) throw httpError(404, 'Folder not found');
  const ids = [id, ...descendantFolderIds(id)];
  const ph = ids.map(() => '?').join(',');
  const arts = db.prepare(`SELECT * FROM artifacts WHERE folder_id IN (${ph})`).all(...ids);
  for (const a of arts) {
    fs.renameSync(artifactDiskPath(a), path.join(ARTIFACTS_DIR, a.filename));
    db.prepare('UPDATE artifacts SET folder_id = NULL WHERE id = ?').run(a.id);
  }
  const disk = folderDiskPath(id);
  db.prepare(`DELETE FROM folders WHERE id IN (${ph})`).run(...ids);
  fs.rmSync(disk, { recursive: true, force: true });
  return { ok: true, moved_to_unsorted: arts.length };
}

function folderTree() {
  const folders = db.prepare('SELECT * FROM folders ORDER BY name COLLATE NOCASE').all();
  const counts = {};
  for (const r of db.prepare('SELECT folder_id, COUNT(*) AS n FROM artifacts GROUP BY folder_id').all()) {
    counts[r.folder_id ?? 'root'] = r.n;
  }
  const byParent = new Map();
  for (const f of folders) {
    const k = f.parent_id ?? 'root';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(f);
  }
  const build = (pid) => (byParent.get(pid) || []).map((f) => ({
    id: f.id, name: f.name, count: counts[f.id] || 0, children: build(f.id),
  }));
  return { unsorted: counts.root || 0, tree: build('root') };
}

/**
 * Resolve a folder from either an id or a human path like "Work/Dashboards".
 * Path segments are matched case-insensitively and created when missing.
 */
function resolveFolderSpec({ folder_id, folder } = {}) {
  if (folder_id) {
    if (!getFolder(folder_id)) throw httpError(404, 'Folder not found');
    return folder_id;
  }
  if (!folder) return null;
  let parent = null;
  for (const seg of String(folder).split('/').map((s) => s.trim()).filter(Boolean)) {
    const name = sanitizeFolderName(seg);
    const rows = parent == null
      ? db.prepare('SELECT * FROM folders WHERE parent_id IS NULL').all()
      : db.prepare('SELECT * FROM folders WHERE parent_id = ?').all(parent);
    const hit = rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
    parent = hit ? hit.id : createFolder({ name, parent_id: parent }).id;
  }
  return parent;
}

// --------------------------------------------------------------- artifacts
function rowToArtifact(r) {
  return r && {
    ...r,
    tags: JSON.parse(r.tags),
    scopes: JSON.parse(r.scopes || '[]'),
    folder_path: folderDisplayPath(r.folder_id),
    kind: artifactKind(r.filename),
  };
}

function getArtifact(id) {
  return rowToArtifact(db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id));
}

function createArtifact({
  html, title, tags = [], notes = '', source = '', folder_id = null, kind = null,
  runtime = null, launch_url = '', scopes = [], owner_email = '', deploy_status = null, external_id = '',
}) {
  if (typeof html !== 'string' || !html.trim()) throw httpError(400, 'Empty content');
  folder_id = folder_id || null;
  if (folder_id && !getFolder(folder_id)) throw httpError(404, 'Folder not found');
  if (kind !== 'html' && kind !== 'tsx') kind = null;
  kind = kind || (looksLikeTsx(html) ? 'tsx' : 'html');
  const id = newId();
  const finalTitle = (title && String(title).trim()) || (kind === 'tsx' ? extractTsxTitle(html) : extractTitle(html));
  const filename = `${slugify(finalTitle)}-${id}.${kind === 'tsx' ? 'tsx' : 'html'}`;
  fs.writeFileSync(path.join(folderDiskPath(folder_id), filename), html, 'utf8');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO artifacts (id, filename, title, tags, notes, source, size, folder_id,
                                     runtime, launch_url, scopes, owner_email, deploy_status, external_id,
                                     created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, filename, finalTitle, JSON.stringify(normalizeTags(tags)), String(notes), String(source),
         Buffer.byteLength(html), folder_id,
         normalizeRuntime(runtime), normalizeLaunchUrl(launch_url), JSON.stringify(normalizeScopes(scopes)),
         String(owner_email || '').trim().toLowerCase(), normalizeDeployStatus(deploy_status), String(external_id || ''),
         now, now);
  return getArtifact(id);
}

function moveArtifact(a, folderId) {
  folderId = folderId || null;
  if (folderId === a.folder_id) return;
  if (folderId && !getFolder(folderId)) throw httpError(404, 'Target folder not found');
  const from = artifactDiskPath(a);
  const to = path.join(folderDiskPath(folderId), a.filename);
  fs.renameSync(from, to);
  db.prepare('UPDATE artifacts SET folder_id = ? WHERE id = ?').run(folderId, a.id);
}

/**
 * List artifacts. `folder` = 'root' (unsorted) or a folder id.
 * `owner` filters to one email's apps (backs the MCP's list_my_foundry_apps);
 * `runtime` filters to one deployment target.
 * When `q` is given, search spans ALL folders (folder filter is ignored).
 */
function listArtifacts({ q, tag, folder, owner, runtime } = {}) {
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = db.prepare(`SELECT * FROM artifacts
                       WHERE title LIKE ? OR notes LIKE ? OR tags LIKE ? OR filename LIKE ?
                       ORDER BY created_at DESC`).all(like, like, like, like);
  } else if (folder === 'root') {
    rows = db.prepare('SELECT * FROM artifacts WHERE folder_id IS NULL ORDER BY created_at DESC').all();
  } else if (folder) {
    rows = db.prepare('SELECT * FROM artifacts WHERE folder_id = ? ORDER BY created_at DESC').all(folder);
  } else {
    rows = db.prepare('SELECT * FROM artifacts ORDER BY created_at DESC').all();
  }
  let list = rows.map(rowToArtifact);
  if (tag) list = list.filter((a) => a.tags.includes(String(tag).toLowerCase()));
  if (owner) list = list.filter((a) => a.owner_email === String(owner).trim().toLowerCase());
  if (runtime) list = list.filter((a) => a.runtime === String(runtime).trim().toLowerCase());
  return list;
}

// ---------------------------------------------------------------- SSRF guard
// URL import makes the *server* fetch whatever it is given. On a single-user
// laptop that is harmless. On a campus-facing deployment it is a hole straight
// into the internal Docker network (http://openartifact:4747,
// http://publisher-mcp:8080) and the cloud metadata endpoint. So: resolve the
// host ourselves, refuse non-public addresses, and re-check on every redirect
// hop — following redirects automatically would let a public host bounce us
// inward after the first check passed.

const PRIVATE_V4 = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
];

function v4IsPrivate(addr) {
  const o = addr.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const ip = ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
  return PRIVATE_V4.some(([base, bits]) => {
    const net = ((base[0] << 24) >>> 0) + (base[1] << 16) + (base[2] << 8) + base[3];
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) >>> 0 === (net & mask) >>> 0;
  });
}

function v6IsPrivate(addr) {
  const a = addr.toLowerCase().split('%')[0];
  if (a === '::' || a === '::1') return true;
  if (/^f[cd]/.test(a)) return true;          // fc00::/7 unique-local
  if (/^fe[89ab]/.test(a)) return true;       // fe80::/10 link-local
  if (/^ff/.test(a)) return true;             // multicast
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return v4IsPrivate(mapped[1]);
  return false;
}

/** Resolve `hostname` and throw unless every address it answers with is public. */
async function assertPublicHost(hostname) {
  if (ALLOW_PRIVATE_IMPORT) return;
  const host = hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) {
    addrs = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      addrs = await dns.lookup(host, { all: true });
    } catch (e) { throw httpError(400, `Cannot resolve host: ${host}`); }
  }
  if (!addrs.length) throw httpError(400, `Cannot resolve host: ${host}`);
  for (const { address, family } of addrs) {
    const priv = family === 6 ? v6IsPrivate(address) : v4IsPrivate(address);
    if (priv) {
      throw httpError(400,
        `Refusing to fetch ${host} — it resolves to the non-public address ${address}. ` +
        'Set ALLOW_PRIVATE_IMPORT=1 only on a trusted single-user vault.');
    }
  }
}

/** fetch() that validates the destination on every hop. */
async function safeFetch(target, { maxRedirects = 5 } = {}) {
  let url = new URL(target);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw httpError(400, `Unsupported protocol: ${url.protocol}`);
    }
    await assertPublicHost(url.hostname);
    const resp = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'OpenArtifact/1.0' },
    });
    if (resp.status < 300 || resp.status > 399 || !resp.headers.get('location')) return resp;
    url = new URL(resp.headers.get('location'), url);
  }
  throw httpError(502, 'Too many redirects');
}

/** Fetch a URL and import the returned HTML (or TSX source) as an artifact. */
async function importFromUrl(target, { title, tags, notes, folder_id, kind, owner_email = '' } = {}) {
  if (!target || !/^https?:\/\//i.test(String(target))) throw httpError(400, 'Invalid or missing URL (must be http(s)://…)');
  let resp;
  try {
    resp = await safeFetch(target);
  } catch (e) {
    if (e.status) throw e;
    throw httpError(502, `Fetch failed: ${e.message}`);
  }
  if (!resp.ok) throw httpError(502, `Fetch failed: HTTP ${resp.status}`);
  const html = await resp.text();
  if (html.length > MAX_BODY) throw httpError(413, 'Fetched page too large');
  if (!kind && /\.(tsx|jsx)(\?|$)/i.test(target)) kind = 'tsx';
  if (!looksLikeHtml(html) && !looksLikeTsx(html) && kind !== 'tsx') throw httpError(422, 'URL did not return HTML or TSX content');
  return createArtifact({ html, title, tags, notes, folder_id, kind, owner_email, source: target });
}

/** Minimal multipart/form-data parser (buffers only, no deps). */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw httpError(400, 'Missing multipart boundary');
  const bb = Buffer.from('--' + (m[1] || m[2]).trim());
  const CRLF2 = Buffer.from('\r\n\r\n');
  const parts = [];
  let pos = buf.indexOf(bb);
  while (pos !== -1) {
    const next = buf.indexOf(bb, pos + bb.length);
    if (next === -1) break;
    let part = buf.subarray(pos + bb.length, next);
    if (part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2);
    const headerEnd = part.indexOf(CRLF2);
    if (headerEnd !== -1) {
      const head = part.subarray(0, headerEnd).toString('utf8');
      let body = part.subarray(headerEnd + 4);
      if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
        body = body.subarray(0, body.length - 2);
      }
      const nameM = /\bname="([^"]*)"/i.exec(head);
      const fileM = /\bfilename="([^"]*)"/i.exec(head);
      parts.push({ name: nameM ? nameM[1] : '', filename: fileM ? fileM[1] : null, body });
    }
    pos = next;
  }
  return parts;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(httpError(413, 'Body too large (max 20 MB)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(buf);
}

// ------------------------------------------------------------------ seeding
function seedIfEmpty() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM artifacts').get();
  if (n > 0 || !fs.existsSync(SEED_DIR)) return;
  const read = (f) => fs.readFileSync(path.join(SEED_DIR, f), 'utf8');
  try {
    const samples = createFolder({ name: 'Samples' });
    const generative = createFolder({ name: 'Generative', parent_id: samples.id });
    createArtifact({ html: read('pomodoro-timer.html'), tags: ['sample'], source: 'seed', notes: 'Bundled sample. Drag me onto a folder!' });
    createArtifact({ html: read('color-palette-generator.html'), tags: ['sample'], source: 'seed', notes: 'Bundled sample artifact.', folder_id: samples.id });
    createArtifact({ html: read('particle-field.html'), tags: ['sample'], source: 'seed', notes: 'Bundled sample artifact.', folder_id: generative.id });
    createArtifact({ html: read('habit-tracker.tsx'), kind: 'tsx', tags: ['sample', 'react'], source: 'seed', notes: 'Bundled sample React/TSX artifact (rendering needs internet: esm.sh + Babel CDN).', folder_id: samples.id });
    console.log('Seeded sample artifacts and folders.');
  } catch (e) { console.error('Seeding failed:', e.message); }
}

// ----------------------------------------------------------------- settings
const getSetting = (k) => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value || null;
const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES(?,?)').run(k, String(v));

// ----------------------------------------------------------------- git sync
function git(args) {
  const r = spawnSync('git', args, { cwd: DATA_DIR, encoding: 'utf8', timeout: 30000 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function gitStatus() {
  const remote = getSetting('git_remote') || '';
  const branch = getSetting('git_branch') || 'main';
  const lastSync = getSetting('git_last_sync') || null;
  const initialized = git(['rev-parse', '--git-dir']).ok;
  let dirty = false, lastCommit = null;
  if (initialized) {
    dirty = git(['status', '--porcelain']).out.length > 0;
    const log = git(['log', '-1', '--format=%h %s']);
    if (log.ok && log.out) {
      const sp = log.out.indexOf(' ');
      lastCommit = { hash: log.out.slice(0, sp), message: log.out.slice(sp + 1) };
    }
  }
  return { initialized, remote, branch, lastSync, dirty, lastCommit };
}

function gitSync(push) {
  const remote = getSetting('git_remote') || '';
  const branch = getSetting('git_branch') || 'main';

  if (!git(['rev-parse', '--git-dir']).ok) {
    const r = git(['init']);
    if (!r.ok) throw httpError(500, 'git init failed: ' + r.err);
    git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    git(['config', 'user.email', 'openartifact@localhost']);
    git(['config', 'user.name', 'OpenArtifact']);
    fs.writeFileSync(path.join(DATA_DIR, '.gitignore'), '*.db-shm\n*.db-wal\n', 'utf8');
  } else {
    git(['config', 'user.email', 'openartifact@localhost']);
    git(['config', 'user.name', 'OpenArtifact']);
  }

  if (remote) {
    const remotes = git(['remote']).out.split('\n').filter(Boolean);
    if (remotes.includes('origin')) git(['remote', 'set-url', 'origin', remote]);
    else git(['remote', 'add', 'origin', remote]);
  }

  git(['add', '-A']);
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const commit = git(['commit', '-m', `backup: ${ts}`]);
  const noChanges = (commit.out + commit.err).toLowerCase().includes('nothing to commit');
  if (!commit.ok && !noChanges) throw httpError(500, 'git commit failed: ' + (commit.err || commit.out));

  let pushed = false, pushError = null;
  if (push) {
    if (!remote) {
      pushError = 'No remote URL configured';
    } else {
      const token = getSetting('git_oauth_token');
      let pushUrl = remote;
      if (token) {
        try {
          const u = new URL(remote);
          u.username = 'oauth2';
          u.password = token;
          pushUrl = u.toString();
        } catch { /* SSH or non-URL remote — use as-is */ }
      }
      const p = git(['push', pushUrl, `HEAD:${branch}`]);
      pushed = p.ok;
      if (!p.ok) {
        const raw = p.err || p.out;
        pushError = token ? raw.replaceAll(token, '[token]') : raw;
      }
    }
  }

  setSetting('git_last_sync', new Date().toISOString());
  return { ok: true, committed: !noChanges, pushed, pushError, lastSync: getSetting('git_last_sync') };
}

// ------------------------------------------------------ github oauth helpers
async function ghPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw httpError(502, `GitHub returned ${res.status}`);
  return res.json();
}

async function ghGet(url, token) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'OpenArtifact/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  return res.json();
}

// ------------------------------------------------------------------- routes
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method === 'HEAD' ? 'GET' : req.method; // Node omits the body for HEAD automatically

  // Everything below the edge proxy is authenticated; in single-user mode this
  // resolves to a synthetic local owner and nothing changes.
  const user = requireUser(req);
  ctx.user = user.email || user.name;

  // Who am I? Drives the frontend's identity chip and admin-only controls.
  if (method === 'GET' && p === '/api/me') {
    ctx.route = '/api/me';
    return send(res, 200, {
      email: user.email,
      name: user.name,
      is_admin: user.isAdmin,
      multi_user: TRUST_PROXY_AUTH,
      runtimes: [...RUNTIMES],
    });
  }

  // UI
  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    ctx.route = '/';
    return send(res, 200, fs.readFileSync(INDEX_HTML), { 'Content-Type': 'text/html; charset=utf-8' });
  }

  // List / search
  if (method === 'GET' && p === '/api/artifacts') {
    ctx.route = '/api/artifacts';
    const ownerParam = url.searchParams.get('owner');
    return send(res, 200, listArtifacts({
      q: url.searchParams.get('q'),
      tag: url.searchParams.get('tag'),
      folder: url.searchParams.get('folder'),
      owner: ownerParam === 'me' ? (user.email || null) : ownerParam,
      runtime: url.searchParams.get('runtime'),
    }));
  }

  // Tag counts
  if (method === 'GET' && p === '/api/tags') {
    ctx.route = '/api/tags';
    const counts = {};
    for (const a of listArtifacts()) for (const t of a.tags) counts[t] = (counts[t] || 0) + 1;
    return send(res, 200, counts);
  }

  // Metrics (scraped by Prometheus; unauthenticated like everything else here)
  if (method === 'GET' && p === '/metrics') {
    ctx.route = '/metrics';
    // Prometheus scrapes this over the internal network with the service token.
    if (TRUST_PROXY_AUTH && !user.isAdmin) throw httpError(403, 'Administrators only');
    return send(res, 200, renderMetrics(), { 'Content-Type': 'text/plain; version=0.0.4' });
  }

  // Folders
  if (p === '/api/folders' && method === 'GET') { ctx.route = '/api/folders'; return send(res, 200, folderTree()); }
  if (p === '/api/folders' && method === 'POST') {
    ctx.route = '/api/folders';
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    return send(res, 201, createFolder({ name: body.name, parent_id: body.parent_id ?? null }));
  }
  let m;
  if ((m = p.match(/^\/api\/folders\/([a-f0-9]{10})$/))) {
    ctx.route = '/api/folders/:id';
    // The folder tree is shared by the whole campus; renaming or deleting one
    // moves everybody's files, so it is an administrator action.
    if (method === 'PATCH' || method === 'PUT') {
      if (TRUST_PROXY_AUTH && !user.isAdmin) throw httpError(403, 'Administrators only');
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return send(res, 200, updateFolder(m[1], body));
    }
    if (method === 'DELETE') {
      if (TRUST_PROXY_AUTH && !user.isAdmin) throw httpError(403, 'Administrators only');
      return send(res, 200, deleteFolder(m[1]));
    }
  }

  // Import: JSON {html,...} or raw HTML body
  if (method === 'POST' && p === '/api/artifacts') {
    ctx.route = '/api/artifacts';
    const body = await readBody(req);
    const ct = (req.headers['content-type'] || '').split(';')[0].trim();
    let payload;
    if (ct === 'application/json') {
      try { payload = JSON.parse(body.toString('utf8')); }
      catch { throw httpError(400, 'Invalid JSON'); }
    } else {
      payload = { html: body.toString('utf8'), source: 'raw-post' };
    }
    return send(res, 201, createArtifact({ ...payload, owner_email: ownerFor(user, payload) }));
  }

  // Import from URL (kept for back-compat; /api/import is the universal endpoint)
  if (method === 'POST' && p === '/api/import-url') {
    ctx.route = '/api/import-url';
    let j = {};
    try { j = JSON.parse((await readBody(req)).toString('utf8')); } catch { /* noop */ }
    return send(res, 201, await importFromUrl(j.url, { folder_id: resolveFolderSpec(j), owner_email: ownerFor(user, j) }));
  }

  // Universal import: multipart file upload, JSON {url|html}, or raw HTML body.
  // Optional folder targeting via folder_id, or folder="Path/Like/This" (auto-created).
  if (method === 'POST' && p === '/api/import') {
    ctx.route = '/api/import';
    const body = await readBody(req);
    const ct = req.headers['content-type'] || '';
    const base = ct.split(';')[0].trim();
    const imported = [];
    const errors = [];

    if (base === 'multipart/form-data') {
      const parts = parseMultipart(body, ct);
      const fields = {};
      for (const pt of parts) if (!pt.filename) fields[pt.name] = pt.body.toString('utf8');
      const folderId = resolveFolderSpec(fields);
      const common = {
        tags: fields.tags, notes: fields.notes ?? '', folder_id: folderId,
        owner_email: ownerFor(user, fields),
        runtime: fields.runtime, launch_url: fields.launch_url ?? '',
        scopes: fields.scopes, deploy_status: fields.deploy_status, external_id: fields.external_id ?? '',
      };
      const files = parts.filter((pt) => pt.filename);
      for (const pt of files) {
        const html = pt.body.toString('utf8');
        const isTsxFile = /\.(tsx|jsx)$/i.test(pt.filename);
        if (!isTsxFile && !/\.html?$/i.test(pt.filename) && !looksLikeHtml(html) && !looksLikeTsx(html)) {
          errors.push(`${pt.filename}: does not look like HTML or TSX`); continue;
        }
        try {
          imported.push(createArtifact({
            html, ...common, source: 'file:' + pt.filename,
            kind: isTsxFile ? 'tsx' : undefined,
            title: files.length === 1 ? fields.title : undefined,
          }));
        } catch (e) { errors.push(`${pt.filename}: ${e.message}`); }
      }
      if (fields.url) imported.push(await importFromUrl(fields.url, { ...common, title: fields.title }));
      if (fields.html) imported.push(createArtifact({ html: fields.html, ...common, title: fields.title, source: 'api-import' }));
    } else if (base === 'application/json') {
      let j;
      try { j = JSON.parse(body.toString('utf8')); } catch { throw httpError(400, 'Invalid JSON'); }
      const folderId = resolveFolderSpec(j);
      const common = {
        title: j.title, tags: j.tags, notes: j.notes ?? '', folder_id: folderId, kind: j.kind,
        owner_email: ownerFor(user, j),
        runtime: j.runtime, launch_url: j.launch_url ?? '',
        scopes: j.scopes, deploy_status: j.deploy_status, external_id: j.external_id ?? '',
      };
      if (j.url) imported.push(await importFromUrl(j.url, common));
      else if (j.html) imported.push(createArtifact({ html: j.html, ...common, source: j.source || 'api-import' }));
    } else {
      imported.push(createArtifact({
        html: body.toString('utf8'), source: 'api-import', owner_email: ownerFor(user, {}),
      }));
    }

    if (!imported.length) {
      throw httpError(400, errors.length ? errors.join('; ')
        : 'Nothing to import — send a multipart file, JSON {"url": …} or {"html": …}, or a raw HTML body');
    }
    return send(res, 201, { imported, errors });
  }

  // Per-artifact routes
  if ((m = p.match(/^\/api\/artifacts\/([a-f0-9]{10})$/))) {
    ctx.route = '/api/artifacts/:id';
    const a = getArtifact(m[1]);
    if (!a) throw httpError(404, 'Artifact not found');

    if (method === 'GET') return send(res, 200, a);

    if (method === 'PATCH' || method === 'PUT') {
      assertCanModify(user, a);
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      // owner_email is set once, at creation, from the authenticated identity —
      // letting it be patched would let anyone reassign authorship.
      if ('owner_email' in body) throw httpError(400, 'owner_email cannot be changed after creation');
      if ('folder_id' in body) moveArtifact(a, body.folder_id);
      const title = 'title' in body ? String(body.title).trim() || a.title : a.title;
      const tags = 'tags' in body ? normalizeTags(body.tags) : a.tags;
      const notes = 'notes' in body ? String(body.notes) : a.notes;
      const runtime = 'runtime' in body ? normalizeRuntime(body.runtime) : a.runtime;
      const launchUrl = 'launch_url' in body ? normalizeLaunchUrl(body.launch_url) : a.launch_url;
      const scopes = 'scopes' in body ? normalizeScopes(body.scopes) : a.scopes;
      const deployStatus = 'deploy_status' in body ? normalizeDeployStatus(body.deploy_status) : a.deploy_status;
      const externalId = 'external_id' in body ? String(body.external_id) : a.external_id;
      db.prepare(`UPDATE artifacts SET title=?, tags=?, notes=?, runtime=?, launch_url=?,
                                       scopes=?, deploy_status=?, external_id=?, updated_at=? WHERE id=?`)
        .run(title, JSON.stringify(tags), notes, runtime, launchUrl,
             JSON.stringify(scopes), deployStatus, externalId, new Date().toISOString(), a.id);
      return send(res, 200, getArtifact(a.id));
    }

    if (method === 'DELETE') {
      assertCanModify(user, a);
      try { fs.unlinkSync(artifactDiskPath(a)); } catch { /* already gone */ }
      db.prepare('DELETE FROM artifacts WHERE id=?').run(a.id);
      return send(res, 200, { ok: true });
    }
  }

  // Raw render (sandboxed via CSP even when opened directly) & download
  if ((m = p.match(/^\/raw\/([a-f0-9]{10})$/)) && method === 'GET') {
    ctx.route = '/raw/:id';
    const a = getArtifact(m[1]);
    if (!a) throw httpError(404, 'Artifact not found');
    const file = artifactDiskPath(a);
    if (!fs.existsSync(file)) throw httpError(410, 'Artifact file missing on disk');
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock',
      'Cache-Control': 'no-store',
    };
    if (url.searchParams.get('download') === '1') {
      headers['Content-Disposition'] = `attachment; filename="${a.filename}"`;
      delete headers['Content-Security-Policy'];
      if (a.kind === 'tsx') headers['Content-Type'] = 'text/plain; charset=utf-8';
      return send(res, 200, fs.readFileSync(file), headers);
    }
    if (a.kind === 'tsx') {
      return send(res, 200, tsxWrapperHtml(a.title, fs.readFileSync(file, 'utf8')), headers);
    }
    return send(res, 200, fs.readFileSync(file), headers);
  }

  // GitHub OAuth — Device Flow
  if (p === '/api/git/oauth/start' && method === 'POST') {
    ctx.route = '/api/git/oauth/start';
    if (TRUST_PROXY_AUTH && !user.isAdmin) throw httpError(403, 'Administrators only');
    let j = {};
    try { j = JSON.parse((await readBody(req)).toString('utf8')); } catch { /* noop */ }
    if (!j.client_id) throw httpError(400, 'client_id required');
    setSetting('git_oauth_client_id', j.client_id.trim());
    const data = await ghPost('https://github.com/login/device/code', { client_id: j.client_id, scope: 'repo' });
    if (data.error) throw httpError(400, data.error_description || data.error);
    return send(res, 200, data); // { device_code, user_code, verification_uri, expires_in, interval }
  }

  if (p === '/api/git/oauth/poll' && method === 'POST') {
    ctx.route = '/api/git/oauth/poll';
    if (TRUST_PROXY_AUTH && !user.isAdmin) throw httpError(403, 'Administrators only');
    let j = {};
    try { j = JSON.parse((await readBody(req)).toString('utf8')); } catch { /* noop */ }
    const clientId = getSetting('git_oauth_client_id');
    if (!j.device_code || !clientId) throw httpError(400, 'device_code required');
    const data = await ghPost('https://github.com/login/oauth/access_token', {
      client_id: clientId,
      device_code: j.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (data.access_token) {
      setSetting('git_oauth_token', data.access_token);
      const user = await ghGet('https://api.github.com/user', data.access_token);
      if (user && user.login) setSetting('git_oauth_login', user.login);
      return send(res, 200, { status: 'complete', login: user?.login || null });
    }
    if (data.error === 'access_denied' || data.error === 'expired_token') {
      return send(res, 200, { status: 'error', error: data.error_description || data.error });
    }
    // authorization_pending | slow_down
    return send(res, 200, { status: 'pending', interval: data.interval || 5 });
  }

  if (p === '/api/git/oauth/status' && method === 'GET') {
    ctx.route = '/api/git/oauth/status';
    if (TRUST_PROXY_AUTH && !user.isAdmin) throw httpError(403, 'Administrators only');
    return send(res, 200, {
      connected: !!getSetting('git_oauth_token'),
      login: getSetting('git_oauth_login') || null,
      clientId: getSetting('git_oauth_client_id') || '',
    });
  }

  if (p === '/api/git/oauth/revoke' && method === 'POST') {
    ctx.route = '/api/git/oauth/revoke';
    if (TRUST_PROXY_AUTH && !user.isAdmin) throw httpError(403, 'Administrators only');
    db.prepare("DELETE FROM settings WHERE key IN ('git_oauth_token','git_oauth_login')").run();
    return send(res, 200, { ok: true });
  }

  // Google Drive config
  if (p === '/api/google/config' && method === 'GET') {
    ctx.route = '/api/google/config';
    // Non-admins get an empty config rather than a 403, so the UI simply hides
    // the Drive button instead of erroring. The API key is not theirs to read.
    if (TRUST_PROXY_AUTH && !user.isAdmin) return send(res, 200, { clientId: '', apiKey: '' });
    return send(res, 200, {
      clientId: getSetting('google_client_id') || '',
      apiKey: getSetting('google_api_key') || '',
    });
  }
  if (p === '/api/google/config' && method === 'POST') {
    ctx.route = '/api/google/config';
    if (TRUST_PROXY_AUTH && !user.isAdmin) throw httpError(403, 'Administrators only');
    let j = {};
    try { j = JSON.parse((await readBody(req)).toString('utf8')); } catch { /* noop */ }
    if (j.clientId !== undefined) setSetting('google_client_id', j.clientId.trim());
    if (j.apiKey !== undefined) setSetting('google_api_key', j.apiKey.trim());
    return send(res, 200, { ok: true });
  }

  // Shareable standalone view
  if ((m = p.match(/^\/share\/([a-f0-9]{10})$/)) && method === 'GET') {
    ctx.route = '/share/:id';
    const a = getArtifact(m[1]);
    if (!a) throw httpError(404, 'Artifact not found');
    const tagsHtml = a.tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('');
    const shareHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(a.title)} — OpenArtifact</title>
<style>
  :root { --bg:#0d0d0d; --panel:#141414; --border:#252525; --text:#d4d4d4; --muted:#5a5a5a; --accent:#fab283; --radius:3px; }
  * { box-sizing:border-box; margin:0; padding:0; }
  html,body { height:100%; background:var(--bg); color:var(--text); font:14px/1.6 ui-monospace,monospace; }
  header {
    display:flex; align-items:center; gap:12px; flex-wrap:wrap;
    padding:10px 18px; border-bottom:1px solid var(--border);
    background:rgba(13,13,13,.97); position:sticky; top:0; z-index:10;
  }
  .logo { display:flex; align-items:center; gap:7px; font-weight:700; font-size:14px; white-space:nowrap; }
  .mark { width:22px; height:22px; border-radius:2px; background:var(--accent); display:grid; place-items:center; color:#0d0d0d; font-size:11px; font-weight:800; }
  .title { font-weight:600; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tags { display:flex; gap:5px; flex-wrap:wrap; }
  .tag { background:rgba(250,178,131,.12); color:var(--accent); border:1px solid rgba(250,178,131,.25); border-radius:2px; padding:1px 7px; font-size:11px; }
  .actions { display:flex; gap:7px; margin-left:auto; }
  .btn { background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:var(--radius); padding:5px 11px; font:inherit; cursor:pointer; text-decoration:none; white-space:nowrap; font-size:13px; }
  .btn:hover { border-color:var(--accent); color:var(--accent); }
  iframe { display:block; width:100%; border:0; height:calc(100vh - 51px); }
</style>
</head>
<body>
<header>
  <div class="logo"><span class="mark">&#9654;</span> OpenArtifact</div>
  <div class="title">${escHtml(a.title)}</div>
  ${tagsHtml ? `<div class="tags">${tagsHtml}</div>` : ''}
  <div class="actions">
    <a class="btn" href="/raw/${a.id}?download=1">&#8659; Download</a>
    <a class="btn" href="/">&#8962; Vault</a>
  </div>
</header>
<iframe src="/raw/${a.id}" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock" title="${escHtml(a.title)}"></iframe>
</body>
</html>`;
    return send(res, 200, shareHtml, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  // Git sync
  if (p === '/api/git/status' && method === 'GET') {
    ctx.route = '/api/git/status';
    if (TRUST_PROXY_AUTH && !user.isAdmin) throw httpError(403, 'Administrators only');
    return send(res, 200, gitStatus());
  }
  if (p === '/api/git/config' && method === 'POST') {
    ctx.route = '/api/git/config';
    if (TRUST_PROXY_AUTH && !user.isAdmin) throw httpError(403, 'Administrators only');
    let j = {};
    try { j = JSON.parse((await readBody(req)).toString('utf8')); } catch { /* noop */ }
    if (j.remote !== undefined) setSetting('git_remote', j.remote.trim());
    if (j.branch !== undefined) setSetting('git_branch', j.branch.trim() || 'main');
    return send(res, 200, gitStatus());
  }
  if (p === '/api/git/sync' && method === 'POST') {
    ctx.route = '/api/git/sync';
    if (TRUST_PROXY_AUTH && !user.isAdmin) throw httpError(403, 'Administrators only');
    let j = {};
    try { j = JSON.parse((await readBody(req)).toString('utf8')); } catch { /* noop */ }
    return send(res, 200, gitSync(!!j.push));
  }

  throw httpError(404, 'Not found');
}

const server = http.createServer((req, res) => {
  const start = process.hrtime.bigint();
  const ctx = {};
  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    recordRequest(req.method, ctx.route || 'unmatched', res.statusCode, durationSeconds);
  });
  handle(req, res, ctx).catch((e) => {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    send(res, status, { error: e.message || 'Internal error' });
  });
});

seedIfEmpty();
server.listen(PORT, HOST, () => {
  console.log(`OpenArtifact running → http://localhost:${PORT}`);
  console.log(`Artifacts stored in   ${ARTIFACTS_DIR}`);
});
