#!/usr/bin/env node
/**
 * Colgate App Foundry — publisher MCP.
 *
 * Claude for Enterprise calls this over Streamable HTTP at /mcp. It deploys a
 * generated app onto a campus runtime *as the requesting user* and registers a
 * card in the gallery.
 *
 * Two separate credentials are in play, for two different reasons:
 *
 *   1. IDENTITY — Claude's bearer token, issued by Dex and validated here
 *      against the Dex JWKS. Tells us which @colgate.edu person is asking.
 *      A shared static token could not do this, and owner attribution and
 *      list_my_foundry_apps both depend on it.
 *
 *   2. CAPABILITY — a Google refresh token, obtained through a separate
 *      consent at /link/google. Needed because Dex cannot mint Apps Script
 *      scopes, and because the Apps Script API does not work with service
 *      accounts at all: deployment must act with delegated user credentials.
 *
 * Zero dependencies, matching the gallery's house style.
 */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { tokenStore } = require('./tokens.js');
const { verifyDexToken } = require('./identity.js');
const { deployAppsScript, buildPowerAppsBundle } = require('./deploy.js');

const PORT = parseInt(process.env.PORT || '8080', 10);
const FOUNDRY_HOST = process.env.FOUNDRY_HOST || 'localhost';
const PUBLIC_BASE = `https://${FOUNDRY_HOST}`;
const GALLERY = (process.env.GALLERY_INTERNAL_URL || 'http://openartifact:4747').replace(/\/$/, '');
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || '';
const DEX_ISSUER = (process.env.DEX_ISSUER || `${PUBLIC_BASE}/dex`).replace(/\/$/, '');
const MCP_CLIENT_ID = process.env.MCP_CLIENT_ID || 'claude-foundry';
const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'colgate.edu').toLowerCase();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

/** Scopes the Apps Script deploy path needs. Narrow on purpose. */
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
  'openid', 'email',
];

const RUNTIMES = new Set(['apps-script', 'power-apps', 'static-preview']);

// ----------------------------------------------------------------- plumbing
const json = (res, status, body, headers = {}) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(buf);
};

const html = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ gallery
/** Create the gallery card for a published app, as its owner. */
async function galleryPublish({ ownerEmail, title, description, runtime, scopes, launchUrl, bundle, externalId, deployStatus }) {
  const resp = await fetch(`${GALLERY}/api/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INTERNAL_API_TOKEN}`,
    },
    body: JSON.stringify({
      html: bundle,
      title,
      notes: description || '',
      tags: ['claude', runtime],
      folder: `Foundry/${runtime === 'apps-script' ? 'Apps Script' : runtime === 'power-apps' ? 'Power Apps' : 'Previews'}`,
      owner_email: ownerEmail,
      runtime,
      scopes,
      launch_url: launchUrl || '',
      deploy_status: deployStatus,
      external_id: externalId || '',
      source: 'colgate-publisher-mcp',
    }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Gallery rejected the card: ${body.error || resp.status}`);
  return body.imported[0];
}

async function galleryListMine(ownerEmail) {
  const resp = await fetch(`${GALLERY}/api/artifacts?owner=${encodeURIComponent(ownerEmail)}`, {
    headers: { Authorization: `Bearer ${INTERNAL_API_TOKEN}` },
  });
  if (!resp.ok) throw new Error(`Gallery list failed: HTTP ${resp.status}`);
  return resp.json();
}

async function galleryDelete(id) {
  await fetch(`${GALLERY}/api/artifacts/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${INTERNAL_API_TOKEN}` },
  });
}

// -------------------------------------------------------------- MCP surface
const TOOLS = [
  {
    name: 'publish_to_colgate_foundry',
    description:
      'Deploy a generated app to a Colgate runtime (Google Apps Script or Power Apps Code Apps) '
      + 'as the signed-in user, and register it in the App Foundry gallery. Returns the launch URL '
      + 'and gallery link. For power-apps, returns a bundle plus the CLI commands to run, since '
      + 'that runtime has no deployment API yet.',
    inputSchema: {
      type: 'object',
      required: ['title', 'runtime', 'files'],
      properties: {
        title: { type: 'string', description: 'Human title, e.g. "Course Roster Sync".' },
        description: { type: 'string', description: 'One or two sentences on what it does.' },
        runtime: { type: 'string', enum: [...RUNTIMES], description: 'Target runtime.' },
        scopes: {
          type: 'array', items: { type: 'string' },
          description: 'Every Workspace/M365 permission the app requests.',
        },
        files: {
          type: 'object',
          description:
            'Deployed filenames to contents. Apps Script expects index.html, Code.gs and '
            + 'appsscript.json; power-apps expects the built dist/ contents.',
          additionalProperties: { type: 'string' },
        },
        replaces: {
          type: 'string',
          description: 'Gallery id of a previous version to replace, avoiding duplicate cards.',
        },
      },
    },
  },
  {
    name: 'list_my_foundry_apps',
    description:
      "List the apps the signed-in user has published to the Colgate App Foundry, with their "
      + 'gallery ids, runtimes, deploy status and launch URLs. Use this to find the id to pass '
      + 'as `replaces` when revising an app.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** The Apps Script link flow is per-user; tell them how to start it. */
function needsGoogleLink(email) {
  return {
    isError: true,
    content: [{
      type: 'text',
      text:
        `Google account not linked for ${email}.\n\n`
        + `Deploying to Apps Script needs a one-time consent, because the Apps Script API only `
        + `works with delegated user credentials — service accounts are not supported.\n\n`
        + `Two steps, once:\n`
        + `1. Turn on "Google Apps Script API" at https://script.google.com/home/usersettings\n`
        + `2. Link your account at ${PUBLIC_BASE}/link/google\n\n`
        + `Then run this tool again. Don't retry before the user confirms both are done.`,
    }],
  };
}

async function callTool(name, args, user) {
  if (name === 'list_my_foundry_apps') {
    const apps = await galleryListMine(user.email);
    if (!apps.length) {
      return { content: [{ type: 'text', text: 'No apps published to the Foundry yet.' }] };
    }
    const rows = apps.map((a) => ({
      id: a.id,
      title: a.title,
      runtime: a.runtime,
      deploy_status: a.deploy_status,
      launch_url: a.launch_url || null,
      updated_at: a.updated_at,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  }

  if (name !== 'publish_to_colgate_foundry') throw new Error(`Unknown tool: ${name}`);

  const { title, description = '', runtime, scopes = [], files = {}, replaces } = args || {};
  if (!title || !String(title).trim()) throw new Error('title is required');
  if (!RUNTIMES.has(runtime)) throw new Error(`runtime must be one of ${[...RUNTIMES].join(', ')}`);
  if (!files || !Object.keys(files).length) throw new Error('files is required and must not be empty');

  // The gallery stores one representative file per card; for both deployed
  // runtimes that is the UI bundle a reviewer would want to look at.
  const bundle = files['index.html'] || Object.values(files)[0];

  let launchUrl = '';
  let externalId = '';
  let deployStatus = 'none';
  let note = '';

  if (runtime === 'apps-script') {
    const token = await tokenStore.getGoogleAccessToken(user.email, {
      clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET,
    });
    if (!token) return needsGoogleLink(user.email);
    const result = await deployAppsScript({ accessToken: token, title, files });
    launchUrl = result.launchUrl;
    externalId = result.scriptId;
    deployStatus = 'deployed';
    note = `Deployed to Apps Script as ${user.email}, domain-restricted, executing as the viewer.`;
  } else if (runtime === 'power-apps') {
    const result = buildPowerAppsBundle({ title, files });
    deployStatus = 'pending';
    note = result.instructions;
  }

  if (replaces) await galleryDelete(replaces);

  const card = await galleryPublish({
    ownerEmail: user.email, title, description, runtime,
    scopes, launchUrl, bundle, externalId, deployStatus,
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        gallery_id: card.id,
        gallery_url: `${PUBLIC_BASE}/share/${card.id}`,
        runtime,
        deploy_status: deployStatus,
        launch_url: launchUrl || null,
        scopes,
        note,
      }, null, 2),
    }],
  };
}

// ------------------------------------------------------------- JSON-RPC/MCP
const PROTOCOL_VERSION = '2025-06-18';

async function handleRpc(msg, user) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'colgate-foundry-publisher', version: '0.1.0' },
      });
    case 'notifications/initialized':
      return null; // notification: no response
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      try {
        const result = await callTool(params?.name, params?.arguments, user);
        return ok(result);
      } catch (e) {
        // Tool errors belong in the result, not the protocol layer, so the
        // model can read and act on them.
        return ok({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] });
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// -------------------------------------------------------------------- routes
async function handle(req, res) {
  const url = new URL(req.url, PUBLIC_BASE);
  const p = url.pathname;

  // --- OAuth discovery (RFC 9728) -----------------------------------------
  // Tells Claude which authorization server protects this resource, so its
  // "Use your own OAuth client" flow knows where to send the user.
  if (p === '/.well-known/oauth-protected-resource'
   || p === '/.well-known/oauth-protected-resource/mcp') {
    return json(res, 200, {
      resource: `${PUBLIC_BASE}/mcp`,
      authorization_servers: [DEX_ISSUER],
      scopes_supported: ['openid', 'email', 'profile'],
      bearer_methods_supported: ['header'],
    });
  }

  if (p === '/healthz') return json(res, 200, { ok: true });

  // --- Google account linking ---------------------------------------------
  // Reached through Caddy's forward_auth, so X-Forwarded-Email is a verified
  // identity by the time it gets here (see deploy/Caddyfile).
  if (p === '/link/google' || p === '/link/google/callback') {
    return handleGoogleLink(req, res, url, p);
  }

  // --- MCP ----------------------------------------------------------------
  if (p === '/mcp' || p === '/mcp/') {
    if (req.method === 'GET') {
      // Streamable HTTP allows a GET for a server-initiated SSE stream. We
      // never initiate, so decline rather than hold a socket open.
      return json(res, 405, { error: 'This server does not offer a server-initiated stream' });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    const auth = String(req.headers['authorization'] || '');
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const unauthorized = (desc) => json(res, 401, {
      error: 'unauthorized', error_description: desc,
    }, {
      // Points Claude at the metadata document so it can start the OAuth flow.
      'WWW-Authenticate':
        `Bearer realm="colgate-foundry", `
        + `resource_metadata="${PUBLIC_BASE}/.well-known/oauth-protected-resource"`,
    });

    if (!m) return unauthorized('Missing bearer token');

    let user;
    try {
      user = await verifyDexToken(m[1], {
        issuer: DEX_ISSUER, audience: MCP_CLIENT_ID, allowedDomain: ALLOWED_DOMAIN,
      });
    } catch (e) {
      return unauthorized(e.message);
    }

    let payload;
    try { payload = JSON.parse((await readBody(req)).toString('utf8')); }
    catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }

    // A client may batch several calls in one array.
    if (Array.isArray(payload)) {
      const out = [];
      for (const msg of payload) {
        const r = await handleRpc(msg, user);
        if (r) out.push(r);
      }
      return out.length ? json(res, 200, out) : res.writeHead(202).end();
    }
    const r = await handleRpc(payload, user);
    if (!r) return res.writeHead(202).end();
    return json(res, 200, r);
  }

  return json(res, 404, { error: 'Not found' });
}

// --------------------------------------------------------- Google link flow
const linkStates = new Map(); // state -> { email, expires }

async function handleGoogleLink(req, res, url, p) {
  const email = String(req.headers['x-forwarded-email'] || '').trim().toLowerCase();
  if (!email || !email.endsWith('@' + ALLOWED_DOMAIN)) {
    return html(res, 401, page('Not signed in',
      `This page must be reached through ${esc(PUBLIC_BASE)} while signed in with a `
      + `@${esc(ALLOWED_DOMAIN)} account.`));
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return html(res, 503, page('Not configured',
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on publisher-mcp.'));
  }

  if (p === '/link/google') {
    const state = crypto.randomBytes(16).toString('hex');
    linkStates.set(state, { email, expires: Date.now() + 10 * 60_000 });
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    auth.searchParams.set('redirect_uri', `${PUBLIC_BASE}/link/google/callback`);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
    // offline + consent is what actually yields a refresh token; without
    // prompt=consent Google omits it on re-authorization.
    auth.searchParams.set('access_type', 'offline');
    auth.searchParams.set('prompt', 'consent');
    auth.searchParams.set('include_granted_scopes', 'true');
    auth.searchParams.set('login_hint', email);
    auth.searchParams.set('hd', ALLOWED_DOMAIN);
    auth.searchParams.set('state', state);
    res.writeHead(302, { Location: auth.toString(), 'Cache-Control': 'no-store' });
    return res.end();
  }

  // callback
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const entry = state && linkStates.get(state);
  linkStates.delete(state);
  if (!entry || entry.expires < Date.now()) {
    return html(res, 400, page('Link expired', 'Start again from /link/google.'));
  }
  // The session that started the flow must be the one finishing it.
  if (entry.email !== email) {
    return html(res, 400, page('Mismatch', 'This link was started by a different account.'));
  }
  if (!code) {
    return html(res, 400, page('Consent declined',
      esc(url.searchParams.get('error') || 'No authorization code was returned.')));
  }

  try {
    await tokenStore.exchangeAndStore(email, code, {
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri: `${PUBLIC_BASE}/link/google/callback`,
    });
  } catch (e) {
    return html(res, 502, page('Link failed', esc(e.message)));
  }

  return html(res, 200, page('Google account linked',
    `${esc(email)} can now publish to Apps Script from Claude.<br><br>`
    + `If you haven't already, turn on <b>Google Apps Script API</b> at `
    + `<a href="https://script.google.com/home/usersettings">script.google.com/home/usersettings</a> — `
    + `the API returns an opaque error without it.`));
}

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Colgate App Foundry</title>
<style>body{background:#0d0d0d;color:#d4d4d4;font:15px/1.6 ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0}
.box{max-width:560px;padding:32px;border:1px solid #252525;border-radius:3px;background:#141414}
h1{font-size:17px;margin:0 0 12px;color:#fab283}a{color:#fab283}</style></head>
<body><div class="box"><h1>${esc(title)}</h1><div>${body}</div></div></body></html>`;

// -------------------------------------------------------------------- boot
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    json(res, 500, { error: e.message || 'Internal error' });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`publisher-mcp listening on :${PORT}`);
  console.log(`  MCP endpoint  ${PUBLIC_BASE}/mcp`);
  console.log(`  identity via  ${DEX_ISSUER} (aud: ${MCP_CLIENT_ID})`);
  console.log(`  gallery       ${GALLERY}`);
  if (!INTERNAL_API_TOKEN) console.warn('  WARNING: INTERNAL_API_TOKEN is unset — gallery writes will be rejected');
  if (!GOOGLE_CLIENT_ID) console.warn('  WARNING: GOOGLE_CLIENT_ID is unset — Apps Script publishing is disabled');
});

module.exports = { handle, callTool, TOOLS };
