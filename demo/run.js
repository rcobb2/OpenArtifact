#!/usr/bin/env node
'use strict';
/**
 * Colgate App Foundry — local demo.
 *
 *   node demo/run.js        →  http://localhost:4747
 *
 * Stands up the whole Foundry on one port with no Google or Entra app
 * registrations, no Docker, and no configuration.
 *
 * What is REAL here (the code that ships):
 *   - the gallery (../server.js) in multi-user mode
 *   - the publisher MCP (../publisher-mcp/server.js), including genuine
 *     RS256 JWT verification against a JWKS
 *   - ownership rules, the SSRF guard, admin gating, the manifest guardrails
 *
 * What is EMULATED (this file, plus the FOUNDRY_DEMO branches):
 *   - Caddy + oauth2-proxy: the reverse proxy below strips client-supplied
 *     identity headers and injects the session's, exactly as deploy/Caddyfile
 *     and oauth2-proxy do
 *   - Dex: a sign-in chooser and a local JWKS that signs real tokens
 *   - Google: the consent screen and the Apps Script deployment are simulated
 *
 * So the trust boundaries behave as designed; only the two external IdPs and
 * Google's deployment API are stood in for.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PUBLIC_PORT = parseInt(process.env.DEMO_PORT || '4747', 10);
const GALLERY_PORT = PUBLIC_PORT + 4;
const MCP_PORT = PUBLIC_PORT + 5;
const ORIGIN = `http://localhost:${PUBLIC_PORT}`;
const ISSUER = `${ORIGIN}/dex`;
const AUDIENCE = 'claude-foundry';
const INTERNAL_TOKEN = crypto.randomBytes(32).toString('hex');
const COOKIE_KEY = crypto.randomBytes(32);
const REPO = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const DATA = KEEP
  ? path.join(REPO, 'demo', '.data')
  : fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-demo-'));

// --------------------------------------------------------------- personas
// Stand-ins for the people who would sign in through Google or Entra.
const PEOPLE = [
  { email: 'rcobb@colgate.edu',     name: 'Ross Cobb',      role: 'ITS — Foundry administrator', idp: 'microsoft', admin: true },
  { email: 'jhartman@colgate.edu',  name: 'Jo Hartman',     role: 'Faculty — Biology',           idp: 'google' },
  { email: 'mlopez@colgate.edu',    name: 'Marisol Lopez',  role: 'Staff — Registrar',           idp: 'microsoft' },
  { email: 'awu@colgate.edu',       name: 'Alex Wu',        role: 'Student — Library assistant', idp: 'google' },
];
const ADMINS = PEOPLE.filter((p) => p.admin).map((p) => p.email).join(',');
const personFor = (email) => PEOPLE.find((p) => p.email === email);

// ------------------------------------------------------------- fake Dex key
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'demo-key-1';
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Mint the kind of ID token Dex would hand Claude for this person. */
function mintToken(email) {
  const p = personFor(email);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
  const payload = b64url(JSON.stringify({
    iss: ISSUER, aud: AUDIENCE, sub: `demo|${email}`, iat: now, exp: now + 3600,
    email, email_verified: true, name: p ? p.name : email,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${b64url(sig)}`;
}

// ---------------------------------------------------------------- sessions
const sign = (v) => crypto.createHmac('sha256', COOKIE_KEY).update(v).digest('base64url');
const makeCookie = (email) => `${Buffer.from(email).toString('base64url')}.${sign(email)}`;
function readCookie(req) {
  const raw = /foundry_demo=([^;]+)/.exec(req.headers.cookie || '');
  if (!raw) return null;
  const [b, s] = decodeURIComponent(raw[1]).split('.');
  if (!b || !s) return null;
  const email = Buffer.from(b, 'base64url').toString('utf8');
  // Constant-time compare so the demo doesn't model a sloppy session check.
  const a = Buffer.from(s), e = Buffer.from(sign(email));
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null;
  return personFor(email) ? email : null;
}

// ------------------------------------------------------------------ pages
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
  :root{--bg:#0d0d0d;--panel:#141414;--panel2:#1a1a1a;--border:#252525;--text:#d4d4d4;--muted:#5a5a5a;--accent:#fab283}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
       min-height:100vh;display:grid;place-items:center;padding:40px 20px}
  .box{width:100%;max-width:520px;border:1px solid var(--border);border-radius:4px;background:var(--panel);overflow:hidden}
  .box-head{padding:20px 24px;border-bottom:1px solid var(--border)}
  .mark{width:24px;height:24px;border-radius:3px;background:var(--accent);color:#0d0d0d;display:inline-grid;
        place-items:center;font-weight:800;font-size:12px;vertical-align:-6px;margin-right:8px}
  h1{font-size:15px;font-weight:700;display:inline}
  .sub{color:var(--muted);font-size:12px;margin-top:6px}
  .box-body{padding:20px 24px}
  .idp{display:flex;align-items:center;gap:12px;width:100%;padding:13px 16px;margin-bottom:10px;
       border:1px solid var(--border);border-radius:3px;background:var(--panel2);color:var(--text);
       font:inherit;cursor:pointer;text-decoration:none;text-align:left}
  .idp:hover{border-color:var(--accent);color:var(--accent)}
  .idp .g{width:20px;height:20px;border-radius:3px;display:grid;place-items:center;font-size:11px;font-weight:800;flex:none}
  .idp .g.google{background:#68a97a;color:#0d0d0d}
  .idp .g.microsoft{background:#6e98d6;color:#0d0d0d}
  .person{display:flex;align-items:center;gap:12px;width:100%;padding:11px 14px;margin-bottom:8px;
          border:1px solid var(--border);border-radius:3px;background:var(--panel2);color:var(--text);
          font:inherit;cursor:pointer;text-decoration:none}
  .person:hover{border-color:var(--accent)}
  .person .av{width:30px;height:30px;border-radius:50%;background:var(--border);display:grid;place-items:center;
              font-size:11px;font-weight:700;color:var(--accent);flex:none}
  .person .who{flex:1;min-width:0}
  .person .nm{font-weight:600;font-size:13px}
  .person .rl{color:var(--muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .badge{font-size:9px;font-weight:700;letter-spacing:.5px;color:var(--accent);
         border:1px solid rgba(250,178,131,.3);border-radius:2px;padding:1px 5px;flex:none}
  .note{margin-top:18px;padding:12px 14px;border:1px dashed var(--border);border-radius:3px;
        color:var(--muted);font-size:11.5px;line-height:1.7}
  a{color:var(--accent)}
  code{background:var(--panel2);padding:1px 5px;border-radius:2px;font-size:12px}
`;

const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${CSS}</style></head><body>${body}</body></html>`;

const chooserPage = (rd) => shell('Sign in — Colgate App Foundry', `
<div class="box">
  <div class="box-head">
    <span class="mark">&#9654;</span><h1>Colgate App Foundry</h1>
    <div class="sub">Sign in to continue to the app gallery</div>
  </div>
  <div class="box-body">
    <a class="idp" href="/demo/idp?idp=google&rd=${encodeURIComponent(rd)}">
      <span class="g google">G</span><span>Colgate Google Workspace</span>
    </a>
    <a class="idp" href="/demo/idp?idp=microsoft&rd=${encodeURIComponent(rd)}">
      <span class="g microsoft">M</span><span>Colgate Microsoft Entra ID</span>
    </a>
    <div class="note">
      This is Dex's connector chooser. In a real deployment these buttons go to Google
      (locked to <code>hostedDomains: colgate.edu</code>) and to Entra (locked to Colgate's
      tenant id). Here they lead to a list of sample people instead, so you can explore
      without app registrations.
    </div>
  </div>
</div>`);

const peoplePage = (idp, rd) => {
  const list = PEOPLE.filter((p) => p.idp === idp);
  return shell('Choose an account', `
<div class="box">
  <div class="box-head">
    <span class="mark">&#9654;</span><h1>${idp === 'google' ? 'Colgate Google Workspace' : 'Colgate Microsoft Entra ID'}</h1>
    <div class="sub">Choose an account to continue</div>
  </div>
  <div class="box-body">
    ${list.map((p) => `
      <a class="person" href="/demo/signin?email=${encodeURIComponent(p.email)}&rd=${encodeURIComponent(rd)}">
        <span class="av">${esc(p.name.split(' ').map((w) => w[0]).join(''))}</span>
        <span class="who"><span class="nm">${esc(p.name)}</span><br><span class="rl">${esc(p.role)}</span></span>
        ${p.admin ? '<span class="badge">ADMIN</span>' : ''}
      </a>`).join('')}
    <div class="note">
      Every account here is <code>@colgate.edu</code>. A personal Gmail or an outside tenant
      never reaches this screen in the real stack — Dex rejects it during the handshake, before
      oauth2-proxy's domain check even runs.
      <br><br>Only <b>Ross Cobb</b> is in <code>FOUNDRY_ADMINS</code>; sign in as someone else to
      see the admin-only controls disappear.
    </div>
  </div>
</div>`);
};

// ------------------------------------------------------------ child servers
function start(name, file, env) {
  const p = spawn(process.execPath, [file], {
    cwd: path.dirname(file), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  const keep = (d) => { log.push(d.toString()); if (log.length > 200) log.shift(); };
  p.stdout.on('data', keep);
  p.stderr.on('data', keep);
  p._log = log;
  p._name = name;
  return p;
}

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ---------------------------------------------------------------- the proxy
/**
 * Stands in for Caddy + oauth2-proxy. The important behaviour it reproduces:
 * client-supplied identity headers are DELETED before anything downstream
 * sees them, and the session's identity is injected in their place.
 */
function proxyTo(port, req, res, extraHeaders = {}) {
  const headers = { ...req.headers };
  // Exactly the strip list in deploy/Caddyfile. Without this, anyone could
  // impersonate anyone by setting a request header.
  for (const h of ['x-forwarded-email', 'x-forwarded-user', 'x-forwarded-preferred-username',
                   'x-forwarded-groups', 'x-auth-request-email', 'x-auth-request-user']) {
    delete headers[h];
  }
  Object.assign(headers, extraHeaders);
  headers.host = `localhost:${port}`;

  const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`demo proxy: upstream ${port} unavailable — ${e.message}`);
  });
  req.pipe(up);
}

const redirect = (res, loc, cookie) => {
  const h = { Location: loc, 'Cache-Control': 'no-store' };
  if (cookie) h['Set-Cookie'] = cookie;
  res.writeHead(302, h);
  res.end();
};
const page = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};
const sendJson = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2));
};

const proxy = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;

  // --- fake Dex: real discovery + real JWKS, so MCP verification is genuine
  if (p === '/dex/.well-known/openid-configuration') {
    return sendJson(res, 200, {
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/keys`,
      authorization_endpoint: `${ISSUER}/auth`,
      token_endpoint: `${ISSUER}/token`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    });
  }
  if (p === '/dex/keys') return sendJson(res, 200, { keys: [JWK] });

  // --- demo control plane
  if (p === '/demo/signout') return redirect(res, '/', 'foundry_demo=; Max-Age=0; Path=/');
  if (p === '/demo/switch') return page(res, 200, chooserPage(url.searchParams.get('rd') || '/'));
  if (p === '/demo/idp') {
    return page(res, 200, peoplePage(url.searchParams.get('idp') === 'microsoft' ? 'microsoft' : 'google',
      url.searchParams.get('rd') || '/'));
  }
  if (p === '/demo/signin') {
    const email = url.searchParams.get('email') || '';
    if (!personFor(email)) return page(res, 400, shell('Unknown account', '<div class="box"><div class="box-body">Unknown demo account.</div></div>'));
    return redirect(res, url.searchParams.get('rd') || '/',
      `foundry_demo=${makeCookie(email)}; Path=/; HttpOnly; SameSite=Lax`);
  }
  // Hands the CLI the token Dex would have issued to Claude for this person.
  if (p === '/demo/token') {
    const email = url.searchParams.get('email') || '';
    if (!personFor(email)) return sendJson(res, 404, { error: 'Unknown demo account' });
    return sendJson(res, 200, { email, token: mintToken(email), audience: AUDIENCE, issuer: ISSUER });
  }
  if (p === '/demo/people') return sendJson(res, 200, PEOPLE);

  // --- MCP: no browser session; the MCP server validates the JWT itself
  if (p === '/mcp' || p.startsWith('/.well-known/oauth-protected-resource')) {
    return proxyTo(MCP_PORT, req, res);
  }

  // --- everything else needs a session (this is oauth2-proxy's job)
  const email = readCookie(req);
  if (!email) {
    if (p.startsWith('/api/') || p.startsWith('/raw/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Not authenticated' }));
    }
    return page(res, 200, chooserPage(req.url));
  }
  const person = personFor(email);
  const identity = {
    'x-forwarded-email': person.email,
    'x-forwarded-user': person.email.split('@')[0],
    'x-forwarded-preferred-username': person.name,
  };

  // The account-linking flow lives on the MCP server but is browser-driven,
  // so it gets the verified identity too (Caddy does this with forward_auth).
  if (p.startsWith('/link/')) return proxyTo(MCP_PORT, req, res, identity);

  return proxyTo(GALLERY_PORT, req, res, identity);
});

// ------------------------------------------------------------------- seeding
async function mcpCall(email, name, args) {
  const resp = await fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mintToken(email)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await resp.json();
  return body.result?.content?.[0]?.text || JSON.stringify(body);
}

const appsScriptFiles = (title, body) => ({
  'index.html': `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
  'Code.gs': 'function doGet(){ return HtmlService.createHtmlOutputFromFile("index"); }',
  'appsscript.json': JSON.stringify({
    timeZone: 'America/New_York', runtimeVersion: 'V8',
    webapp: { access: 'DOMAIN', executeAs: 'USER_ACCESSING' },
  }, null, 2),
});

const SEEDS = [
  { as: 'mlopez@colgate.edu', title: 'Course Roster Sync', runtime: 'apps-script',
    description: 'Pulls the Banner roster into a Sheet and flags enrollment changes each morning.',
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
    files: appsScriptFiles('Course Roster Sync', '<h1>Roster Sync</h1>') },
  { as: 'jhartman@colgate.edu', title: 'Lab Section Signup', runtime: 'apps-script',
    description: 'Lets students claim a weekly lab slot; writes straight to the section Sheet.',
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/calendar.readonly'],
    files: appsScriptFiles('Lab Section Signup', '<h1>Lab Signup</h1>') },
  { as: 'rcobb@colgate.edu', title: 'Facilities Ticket Triage', runtime: 'power-apps',
    description: 'Triages work orders from the SharePoint list and routes them by building.',
    scopes: ['SharePoint.Read', 'Office365Users.Read'],
    files: { 'index.html': '<!doctype html><html><head><title>Facilities Ticket Triage</title></head><body><h1>Triage</h1></body></html>' } },
  { as: 'awu@colgate.edu', title: 'Reserve Shelf Checker', runtime: 'static-preview',
    description: 'Looks up which course reserves are on the shelf. No campus data.',
    scopes: [],
    files: { 'index.html': '<!doctype html><html><head><title>Reserve Shelf Checker</title></head><body style="font:16px system-ui;padding:40px"><h1>Reserve Shelf Checker</h1><p>Type a course code.</p></body></html>' } },
];

async function seed() {
  // Link the two Apps Script publishers, as they would at /link/google.
  for (const email of ['mlopez@colgate.edu', 'jhartman@colgate.edu']) {
    await fetch(`${ORIGIN}/link/google?confirm=1`, {
      headers: { Cookie: `foundry_demo=${makeCookie(email)}` },
    });
  }
  for (const s of SEEDS) {
    const { as, ...args } = s;
    await mcpCall(as, 'publish_to_colgate_foundry', args);
  }
}

// --------------------------------------------------------------------- boot
const BOLD = '\x1b[1m', DIM = '\x1b[2m', ACC = '\x1b[38;5;215m', OFF = '\x1b[0m';

(async () => {
  fs.mkdirSync(DATA, { recursive: true });

  const gallery = start('gallery', path.join(REPO, 'server.js'), {
    PORT: String(GALLERY_PORT), HOST: '127.0.0.1',
    DATA_DIR: path.join(DATA, 'gallery'),
    TRUST_PROXY_AUTH: '1', FOUNDRY_ADMINS: ADMINS, INTERNAL_API_TOKEN: INTERNAL_TOKEN,
  });
  const mcp = start('mcp', path.join(REPO, 'publisher-mcp', 'server.js'), {
    PORT: String(MCP_PORT),
    FOUNDRY_HOST: `localhost:${PUBLIC_PORT}`,
    GALLERY_INTERNAL_URL: `http://127.0.0.1:${GALLERY_PORT}`,
    INTERNAL_API_TOKEN: INTERNAL_TOKEN,
    DEX_ISSUER: ISSUER, MCP_CLIENT_ID: AUDIENCE, ALLOWED_EMAIL_DOMAIN: 'colgate.edu',
    TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    TOKEN_DATA_DIR: path.join(DATA, 'mcp'),
    PUBLIC_SCHEME: 'http',
    FOUNDRY_DEMO: '1',
  });

  const bye = () => {
    gallery.kill(); mcp.kill();
    if (!KEEP) fs.rmSync(DATA, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);

  await new Promise((r) => proxy.listen(PUBLIC_PORT, r));

  if (!await waitFor(`http://127.0.0.1:${GALLERY_PORT}/api/me`)) {
    console.error('gallery failed to start:\n' + gallery._log.join(''));
    return bye();
  }
  if (!await waitFor(`http://127.0.0.1:${MCP_PORT}/healthz`)) {
    console.error('publisher-mcp failed to start:\n' + mcp._log.join(''));
    return bye();
  }

  const fresh = !fs.existsSync(path.join(DATA, 'gallery', 'index.db'));
  if (fresh || !KEEP) {
    process.stdout.write(`${DIM}Seeding sample apps through the real MCP…${OFF}`);
    try { await seed(); process.stdout.write(` done\n`); }
    catch (e) { process.stdout.write(` failed: ${e.message}\n`); }
  }

  console.log(`
${BOLD}Colgate App Foundry — demo${OFF}

  ${ACC}${ORIGIN}${OFF}

${BOLD}Try this${OFF}
  1. Open the link. You get Dex's connector chooser — pick Google or Microsoft.
  2. Sign in as ${BOLD}Ross Cobb${OFF} (admin): Backup, Drive and the folder ＋ are there.
  3. ${ORIGIN}/demo/switch — sign in as ${BOLD}Alex Wu${OFF}: those controls are gone,
     and so is the ability to edit anyone else's app.
  4. Click an Apps Script card's ${BOLD}Launch ↗${OFF} — it points at script.google.com.
  5. Publish as Claude would:  ${ACC}node demo/publish.js${OFF}

${BOLD}Real vs emulated${OFF}
  real      gallery, publisher MCP, RS256 JWT verification, ownership rules,
            SSRF guard, admin gating, Apps Script manifest guardrails
  emulated  Caddy + oauth2-proxy (this file), Dex sign-in, Google consent,
            and the Apps Script deployment itself ${DIM}(FOUNDRY_DEMO=1)${OFF}

  ${DIM}Data in ${DATA}${KEEP ? '' : ' (deleted on exit; pass --keep to persist)'}${OFF}
  ${DIM}Ctrl-C to stop.${OFF}
`);
})();
