#!/usr/bin/env node
'use strict';
/**
 * End-to-end test for the publisher MCP.
 *
 * Stands up a fake Dex (OIDC discovery + JWKS + real RS256 signing), a real
 * gallery, and the real MCP server, then drives the whole chain over HTTP.
 * No mocks of our own code — the identity, gallery and tool paths are the
 * production ones.
 *
 *   node test.js
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORTS = { dex: 4911, gallery: 4912, mcp: 4913 };
const GALLERY_TOKEN = 'internal-test-token';
const AUDIENCE = 'claude-foundry';
const ISSUER = `http://localhost:${PORTS.dex}/dex`;

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`); }
};

// ------------------------------------------------------------- fake Dex
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function mintToken(claims, { kid = KID, key = privateKey } = {}) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + 3600,
    email_verified: true, ...claims,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key);
  return `${header}.${payload}.${b64url(sig)}`;
}

function startFakeDex() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/dex/.well-known/openid-configuration') {
        return send({ issuer: ISSUER, jwks_uri: `${ISSUER}/keys` });
      }
      if (req.url === '/dex/keys') return send({ keys: [jwk] });
      res.writeHead(404).end();
    });
    s.listen(PORTS.dex, () => resolve(s));
  });
}

// ------------------------------------------------------------ child procs
function startProc(name, file, env, cwd) {
  const p = spawn(process.execPath, [file], {
    cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  p.stdout.on('data', (d) => log.push(d.toString()));
  p.stderr.on('data', (d) => log.push(d.toString()));
  p._log = log;
  p._name = name;
  return p;
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// --------------------------------------------------------------- MCP call
let rpcId = 0;
async function mcp(token, method, params) {
  const resp = await fetch(`http://localhost:${PORTS.mcp}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return { status: resp.status, headers: resp.headers, body: await resp.json().catch(() => ({})) };
}

const toolCall = (token, name, args) => mcp(token, 'tools/call', { name, arguments: args });
const textOf = (r) => r.body?.result?.content?.[0]?.text || '';

// ------------------------------------------------------------------- main
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-test-'));
  const repo = path.resolve(__dirname, '..');
  const dex = await startFakeDex();

  const gallery = startProc('gallery', path.join(repo, 'server.js'), {
    PORT: String(PORTS.gallery), DATA_DIR: path.join(tmp, 'gallery'),
    TRUST_PROXY_AUTH: '1', INTERNAL_API_TOKEN: GALLERY_TOKEN,
    FOUNDRY_ADMINS: 'admin@colgate.edu',
  }, repo);

  const mcpProc = startProc('mcp', path.join(__dirname, 'server.js'), {
    PORT: String(PORTS.mcp),
    FOUNDRY_HOST: `localhost:${PORTS.mcp}`,
    GALLERY_INTERNAL_URL: `http://localhost:${PORTS.gallery}`,
    INTERNAL_API_TOKEN: GALLERY_TOKEN,
    DEX_ISSUER: ISSUER,
    MCP_CLIENT_ID: AUDIENCE,
    ALLOWED_EMAIL_DOMAIN: 'colgate.edu',
    TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    TOKEN_DATA_DIR: path.join(tmp, 'mcp'),
  }, __dirname);

  const cleanup = () => {
    gallery.kill(); mcpProc.kill(); dex.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  try {
    if (!await waitFor(`http://localhost:${PORTS.gallery}/api/me`)) throw new Error('gallery did not start\n' + gallery._log.join(''));
    if (!await waitFor(`http://localhost:${PORTS.mcp}/healthz`)) throw new Error('mcp did not start\n' + mcpProc._log.join(''));

    const good = mintToken({ email: 'alice@colgate.edu', name: 'Alice', sub: 'u1' });

    console.log('\nOAuth discovery');
    {
      const r = await fetch(`http://localhost:${PORTS.mcp}/.well-known/oauth-protected-resource`);
      const b = await r.json();
      check('serves RFC 9728 protected-resource metadata', r.status === 200);
      check('points at the Dex issuer', b.authorization_servers?.[0] === ISSUER, JSON.stringify(b));
    }

    console.log('\nIdentity');
    {
      const r = await mcp(null, 'tools/list');
      check('no token -> 401', r.status === 401);
      check('401 carries WWW-Authenticate with resource_metadata',
        /resource_metadata=/.test(r.headers.get('www-authenticate') || ''),
        r.headers.get('www-authenticate') || '(none)');
    }
    {
      const r = await mcp('not-a-jwt', 'tools/list');
      check('malformed token -> 401', r.status === 401);
    }
    {
      const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const forged = mintToken({ email: 'mallory@colgate.edu' }, { key: other.privateKey });
      const r = await mcp(forged, 'tools/list');
      check('token signed by an unknown key -> 401', r.status === 401,
        JSON.stringify(r.body));
    }
    {
      const r = await mcp(mintToken({ email: 'alice@colgate.edu', aud: 'some-other-client' }), 'tools/list');
      check('wrong audience -> 401', r.status === 401);
    }
    {
      const r = await mcp(mintToken({ email: 'outsider@gmail.com' }), 'tools/list');
      check('non-colgate.edu email -> 401', r.status === 401);
    }
    {
      const r = await mcp(mintToken({ email: 'alice@colgate.edu', exp: Math.floor(Date.now() / 1000) - 7200 }), 'tools/list');
      check('expired token -> 401', r.status === 401);
    }
    {
      const r = await mcp(good, 'tools/list');
      check('valid token -> 200', r.status === 200);
      const names = (r.body.result?.tools || []).map((t) => t.name).sort();
      check('advertises both tools',
        JSON.stringify(names) === '["list_my_foundry_apps","publish_to_colgate_foundry"]',
        JSON.stringify(names));
    }

    console.log('\nProtocol');
    {
      const r = await mcp(good, 'initialize', { protocolVersion: '2025-06-18' });
      check('initialize returns a protocol version', !!r.body.result?.protocolVersion);
      check('initialize names the server',
        r.body.result?.serverInfo?.name === 'colgate-foundry-publisher');
    }

    console.log('\npublish: static-preview');
    let staticId;
    {
      const r = await toolCall(good, 'publish_to_colgate_foundry', {
        title: 'Credit Calculator', description: 'Works out credits to graduation.',
        runtime: 'static-preview', scopes: [],
        files: { 'index.html': '<html><title>Credit Calculator</title><body>hi</body></html>' },
      });
      const out = JSON.parse(textOf(r) || '{}');
      staticId = out.gallery_id;
      check('returns a gallery id', !!staticId, textOf(r));
      check('deploy_status none', out.deploy_status === 'none', textOf(r));
      const card = await (await fetch(`http://localhost:${PORTS.gallery}/api/artifacts/${staticId}`,
        { headers: { Authorization: `Bearer ${GALLERY_TOKEN}` } })).json();
      check('card attributed to the token holder', card.owner_email === 'alice@colgate.edu', card.owner_email);
      check('card filed under Foundry/Previews', card.folder_path === 'Foundry / Previews', card.folder_path);
    }

    console.log('\npublish: apps-script (no Google link yet)');
    {
      const r = await toolCall(good, 'publish_to_colgate_foundry', {
        title: 'Roster Sync', runtime: 'apps-script',
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        files: {
          'index.html': '<html><body>ui</body></html>',
          'Code.gs': 'function doGet(){}',
          'appsscript.json': JSON.stringify({ webapp: { access: 'DOMAIN', executeAs: 'USER_ACCESSING' } }),
        },
      });
      const t = textOf(r);
      check('reports the tool error, not a protocol error', r.body.result?.isError === true);
      check('explains the one-time Google link', /link\/google/.test(t), t.slice(0, 200));
      check('mentions the per-user Apps Script API setting', /usersettings/.test(t));
    }

    console.log('\npublish: apps-script manifest guardrails');
    {
      // These run before any network call, so they are testable without Google.
      const { assertSafeManifest } = require('./deploy.js');
      const bad = { 'appsscript.json': JSON.stringify({ webapp: { access: 'DOMAIN', executeAs: 'USER_DEPLOYING' } }) };
      let threw = '';
      try { assertSafeManifest(bad); } catch (e) { threw = e.message; }
      check('rejects executeAs USER_DEPLOYING', /USER_ACCESSING/.test(threw), threw);

      const anyone = { 'appsscript.json': JSON.stringify({ webapp: { access: 'ANYONE', executeAs: 'USER_ACCESSING' } }) };
      threw = '';
      try { assertSafeManifest(anyone); } catch (e) { threw = e.message; }
      check('rejects access ANYONE', /DOMAIN/.test(threw), threw);
    }

    console.log('\npublish: power-apps (pending handoff)');
    {
      const r = await toolCall(good, 'publish_to_colgate_foundry', {
        title: 'Facilities Triage', runtime: 'power-apps',
        scopes: ['SharePoint.Read'],
        files: { 'index.html': '<html><body>built</body></html>', 'assets/app.js': 'console.log(1)' },
      });
      const out = JSON.parse(textOf(r) || '{}');
      check('files the card as pending', out.deploy_status === 'pending', textOf(r));
      check('no launch_url yet', out.launch_url === null);
      check('hands back the pac commands', /pac code init/.test(out.note || ''), (out.note || '').slice(0, 120));
    }

    console.log('\nlist_my_foundry_apps');
    {
      const r = await toolCall(good, 'list_my_foundry_apps', {});
      const rows = JSON.parse(textOf(r) || '[]');
      check('lists exactly alice\'s two cards', rows.length === 2, textOf(r));
      check('includes runtime and deploy status',
        rows.every((x) => x.runtime && x.deploy_status), textOf(r));

      const bob = mintToken({ email: 'bob@colgate.edu', sub: 'u2' });
      const rb = await toolCall(bob, 'list_my_foundry_apps', {});
      check('bob sees none of alice\'s apps', /No apps published/.test(textOf(rb)), textOf(rb));
    }

    console.log('\nrevision via `replaces`');
    {
      const r = await toolCall(good, 'publish_to_colgate_foundry', {
        title: 'Credit Calculator', runtime: 'static-preview', replaces: staticId,
        files: { 'index.html': '<html><title>Credit Calculator v2</title><body>v2</body></html>' },
      });
      const out = JSON.parse(textOf(r) || '{}');
      check('creates a new card', !!out.gallery_id && out.gallery_id !== staticId);
      const rows = JSON.parse(textOf(await toolCall(good, 'list_my_foundry_apps', {})) || '[]');
      check('old card is gone, not duplicated', rows.length === 2, JSON.stringify(rows.map((x) => x.title)));
    }

    console.log('\nvalidation');
    {
      const r = await toolCall(good, 'publish_to_colgate_foundry', {
        title: 'X', runtime: 'nonsense', files: { 'index.html': 'x' },
      });
      check('rejects an unknown runtime', r.body.result?.isError === true && /runtime must be/.test(textOf(r)));
      const r2 = await toolCall(good, 'publish_to_colgate_foundry', { title: 'X', runtime: 'static-preview', files: {} });
      check('rejects an empty file set', r2.body.result?.isError === true && /files is required/.test(textOf(r2)));
      const r3 = await toolCall(good, 'no_such_tool', {});
      check('rejects an unknown tool', r3.body.result?.isError === true && /Unknown tool/.test(textOf(r3)));
    }
  } catch (e) {
    failed++;
    console.error('\n\x1b[31mFATAL\x1b[0m', e.message);
    console.error('gallery log:\n' + gallery._log.join(''));
    console.error('mcp log:\n' + mcpProc._log.join(''));
  } finally {
    cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
