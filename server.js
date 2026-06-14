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

const PORT = parseInt(process.env.PORT || '4747', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ARTIFACTS_DIR = path.join(DATA_DIR, 'artifacts');
const SEED_DIR = path.join(__dirname, 'seed');
const MAX_BODY = 20 * 1024 * 1024; // 20 MB

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
// migration for vaults created before folders existed
if (!db.prepare('PRAGMA table_info(artifacts)').all().some((c) => c.name === 'folder_id')) {
  db.exec('ALTER TABLE artifacts ADD COLUMN folder_id TEXT REFERENCES folders(id)');
}

// ----------------------------------------------------------------- helpers
const newId = () => crypto.randomBytes(5).toString('hex');

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
  return r && { ...r, tags: JSON.parse(r.tags), folder_path: folderDisplayPath(r.folder_id), kind: artifactKind(r.filename) };
}

function getArtifact(id) {
  return rowToArtifact(db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id));
}

function createArtifact({ html, title, tags = [], notes = '', source = '', folder_id = null, kind = null }) {
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
  db.prepare(`INSERT INTO artifacts (id, filename, title, tags, notes, source, size, folder_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, filename, finalTitle, JSON.stringify(normalizeTags(tags)), String(notes), String(source),
         Buffer.byteLength(html), folder_id, now, now);
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
 * When `q` is given, search spans ALL folders (folder filter is ignored).
 */
function listArtifacts({ q, tag, folder } = {}) {
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
  return list;
}

/** Fetch a URL and import the returned HTML (or TSX source) as an artifact. */
async function importFromUrl(target, { title, tags, notes, folder_id, kind } = {}) {
  if (!target || !/^https?:\/\//i.test(String(target))) throw httpError(400, 'Invalid or missing URL (must be http(s)://…)');
  let resp;
  try {
    resp = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'OpenArtifact/1.0' } });
  } catch (e) { throw httpError(502, `Fetch failed: ${e.message}`); }
  if (!resp.ok) throw httpError(502, `Fetch failed: HTTP ${resp.status}`);
  const html = await resp.text();
  if (html.length > MAX_BODY) throw httpError(413, 'Fetched page too large');
  if (!kind && /\.(tsx|jsx)(\?|$)/i.test(target)) kind = 'tsx';
  if (!looksLikeHtml(html) && !looksLikeTsx(html) && kind !== 'tsx') throw httpError(422, 'URL did not return HTML or TSX content');
  return createArtifact({ html, title, tags, notes, folder_id, kind, source: target });
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

// ------------------------------------------------------------------- routes
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method === 'HEAD' ? 'GET' : req.method; // Node omits the body for HEAD automatically

  // UI
  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    return send(res, 200, fs.readFileSync(INDEX_HTML), { 'Content-Type': 'text/html; charset=utf-8' });
  }

  // List / search
  if (method === 'GET' && p === '/api/artifacts') {
    return send(res, 200, listArtifacts({
      q: url.searchParams.get('q'),
      tag: url.searchParams.get('tag'),
      folder: url.searchParams.get('folder'),
    }));
  }

  // Tag counts
  if (method === 'GET' && p === '/api/tags') {
    const counts = {};
    for (const a of listArtifacts()) for (const t of a.tags) counts[t] = (counts[t] || 0) + 1;
    return send(res, 200, counts);
  }

  // Folders
  if (p === '/api/folders' && method === 'GET') return send(res, 200, folderTree());
  if (p === '/api/folders' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    return send(res, 201, createFolder({ name: body.name, parent_id: body.parent_id ?? null }));
  }
  let m;
  if ((m = p.match(/^\/api\/folders\/([a-f0-9]{10})$/))) {
    if (method === 'PATCH' || method === 'PUT') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return send(res, 200, updateFolder(m[1], body));
    }
    if (method === 'DELETE') return send(res, 200, deleteFolder(m[1]));
  }

  // Import: JSON {html,...} or raw HTML body
  if (method === 'POST' && p === '/api/artifacts') {
    const body = await readBody(req);
    const ct = (req.headers['content-type'] || '').split(';')[0].trim();
    let payload;
    if (ct === 'application/json') {
      try { payload = JSON.parse(body.toString('utf8')); }
      catch { throw httpError(400, 'Invalid JSON'); }
    } else {
      payload = { html: body.toString('utf8'), source: 'raw-post' };
    }
    return send(res, 201, createArtifact(payload));
  }

  // Import from URL (kept for back-compat; /api/import is the universal endpoint)
  if (method === 'POST' && p === '/api/import-url') {
    let j = {};
    try { j = JSON.parse((await readBody(req)).toString('utf8')); } catch { /* noop */ }
    return send(res, 201, await importFromUrl(j.url, { folder_id: resolveFolderSpec(j) }));
  }

  // Universal import: multipart file upload, JSON {url|html}, or raw HTML body.
  // Optional folder targeting via folder_id, or folder="Path/Like/This" (auto-created).
  if (method === 'POST' && p === '/api/import') {
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
      const common = { tags: fields.tags, notes: fields.notes ?? '', folder_id: folderId };
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
      const common = { title: j.title, tags: j.tags, notes: j.notes ?? '', folder_id: folderId, kind: j.kind };
      if (j.url) imported.push(await importFromUrl(j.url, common));
      else if (j.html) imported.push(createArtifact({ html: j.html, ...common, source: j.source || 'api-import' }));
    } else {
      imported.push(createArtifact({ html: body.toString('utf8'), source: 'api-import' }));
    }

    if (!imported.length) {
      throw httpError(400, errors.length ? errors.join('; ')
        : 'Nothing to import — send a multipart file, JSON {"url": …} or {"html": …}, or a raw HTML body');
    }
    return send(res, 201, { imported, errors });
  }

  // Per-artifact routes
  if ((m = p.match(/^\/api\/artifacts\/([a-f0-9]{10})$/))) {
    const a = getArtifact(m[1]);
    if (!a) throw httpError(404, 'Artifact not found');

    if (method === 'GET') return send(res, 200, a);

    if (method === 'PATCH' || method === 'PUT') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if ('folder_id' in body) moveArtifact(a, body.folder_id);
      const title = 'title' in body ? String(body.title).trim() || a.title : a.title;
      const tags = 'tags' in body ? normalizeTags(body.tags) : a.tags;
      const notes = 'notes' in body ? String(body.notes) : a.notes;
      db.prepare('UPDATE artifacts SET title=?, tags=?, notes=?, updated_at=? WHERE id=?')
        .run(title, JSON.stringify(tags), notes, new Date().toISOString(), a.id);
      return send(res, 200, getArtifact(a.id));
    }

    if (method === 'DELETE') {
      try { fs.unlinkSync(artifactDiskPath(a)); } catch { /* already gone */ }
      db.prepare('DELETE FROM artifacts WHERE id=?').run(a.id);
      return send(res, 200, { ok: true });
    }
  }

  // Raw render (sandboxed via CSP even when opened directly) & download
  if ((m = p.match(/^\/raw\/([a-f0-9]{10})$/)) && method === 'GET') {
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

  throw httpError(404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
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
