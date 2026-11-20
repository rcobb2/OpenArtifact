#!/usr/bin/env node
'use strict';
/**
 * Drive the publisher MCP the way Claude for Enterprise would.
 *
 *   node demo/publish.js                       # interactive
 *   node demo/publish.js --list                # list the signed-in user's apps
 *   node demo/publish.js --as jhartman@colgate.edu --title "Grade Curver" \
 *        --runtime apps-script
 *
 * Shows the raw JSON-RPC on the wire, because the point is to see what the
 * connector actually does — including the 401 you get without a valid token.
 */

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const ORIGIN = process.env.DEMO_ORIGIN || `http://localhost:${process.env.DEMO_PORT || 4747}`;
const B = '\x1b[1m', D = '\x1b[2m', A = '\x1b[38;5;215m', G = '\x1b[32m', R = '\x1b[31m', O = '\x1b[0m';

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes('--' + name);

let rpcId = 0;
async function rpc(token, method, params, { quiet = false } = {}) {
  const body = { jsonrpc: '2.0', id: ++rpcId, method, params };
  if (!quiet) {
    console.log(`\n${D}POST ${ORIGIN}/mcp${O}`);
    console.log(`${D}Authorization: Bearer ${token ? token.slice(0, 24) + '…' : '(none)'}${O}`);
    console.log(`${D}${JSON.stringify(body, null, 2).split('\n').slice(0, 24).join('\n')}${O}`);
  }
  const resp = await fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!quiet) {
    const auth = resp.headers.get('www-authenticate');
    console.log(`\n${resp.ok ? G : R}← HTTP ${resp.status}${O}`);
    if (auth) console.log(`${D}WWW-Authenticate: ${auth}${O}`);
  }
  return { status: resp.status, body: json };
}

const textOf = (r) => r.body?.result?.content?.[0]?.text || '';

async function tokenFor(email) {
  const r = await fetch(`${ORIGIN}/demo/token?email=${encodeURIComponent(email)}`);
  if (!r.ok) throw new Error(`No demo account ${email}. Try --as rcobb@colgate.edu`);
  return (await r.json()).token;
}

const appsScriptFiles = (title) => ({
  'index.html': `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`,
  'Code.gs': 'function doGet(){ return HtmlService.createHtmlOutputFromFile("index"); }',
  'appsscript.json': JSON.stringify({
    timeZone: 'America/New_York', runtimeVersion: 'V8',
    webapp: { access: 'DOMAIN', executeAs: 'USER_ACCESSING' },
  }, null, 2),
});

const plainFiles = (title) => ({
  'index.html': `<!doctype html><html><head><title>${title}</title></head><body style="font:16px system-ui;padding:40px"><h1>${title}</h1></body></html>`,
});

async function main() {
  // Show what an unauthenticated call looks like — this is what makes Claude
  // start its OAuth flow.
  if (flag('unauthenticated')) {
    await rpc(null, 'tools/list', {});
    return;
  }

  const people = await (await fetch(`${ORIGIN}/demo/people`)).json().catch(() => null);
  if (!people) {
    console.error(`${R}Can't reach the demo at ${ORIGIN}. Start it with:${O}\n\n  node demo/run.js\n`);
    process.exit(1);
  }

  let as = arg('as');
  let title = arg('title');
  let runtime = arg('runtime');

  const interactive = !as || (!flag('list') && !title);
  let rl;
  if (interactive) {
    rl = readline.createInterface({ input: stdin, output: stdout });
    if (!as) {
      console.log(`\n${B}Publish as which person?${O}`);
      people.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} ${D}<${p.email}> — ${p.role}${O}`));
      const pick = await rl.question(`\n  choose [1-${people.length}]: `);
      as = (people[parseInt(pick, 10) - 1] || people[0]).email;
    }
    if (!flag('list')) {
      title = title || await rl.question(`  app title: `) || 'Untitled App';
      if (!runtime) {
        console.log(`\n  1. apps-script    ${D}Google Sheets/Drive/Gmail — deploys (simulated)${O}`);
        console.log(`  2. power-apps     ${D}SharePoint/Dataverse — returns CLI handoff${O}`);
        console.log(`  3. static-preview ${D}no campus data — gallery card only${O}`);
        const r = await rl.question(`\n  runtime [1-3]: `);
        runtime = { 1: 'apps-script', 2: 'power-apps', 3: 'static-preview' }[parseInt(r, 10)] || 'apps-script';
      }
    }
    rl.close();
  }

  const token = await tokenFor(as);
  console.log(`\n${B}Acting as${O} ${A}${as}${O} ${D}(Dex-issued JWT, verified against the JWKS)${O}`);

  if (flag('list')) {
    const r = await rpc(token, 'tools/call', { name: 'list_my_foundry_apps', arguments: {} });
    console.log('\n' + (textOf(r) || JSON.stringify(r.body, null, 2)));
    return;
  }

  const scopes = runtime === 'apps-script'
    ? ['https://www.googleapis.com/auth/spreadsheets']
    : runtime === 'power-apps' ? ['SharePoint.Read'] : [];

  const r = await rpc(token, 'tools/call', {
    name: 'publish_to_colgate_foundry',
    arguments: {
      title,
      description: arg('description', `${title}, built in Claude.`),
      runtime,
      scopes,
      files: runtime === 'apps-script' ? appsScriptFiles(title) : plainFiles(title),
    },
  });

  const text = textOf(r);
  const isErr = r.body?.result?.isError;
  console.log(`\n${isErr ? R + 'tool reported a problem' : G + 'result'}${O}\n`);
  console.log(text || JSON.stringify(r.body, null, 2));

  if (isErr && /link\/google/.test(text)) {
    console.log(`\n${D}Expected: this person hasn't linked a Google account yet.`);
    console.log(`Open ${ORIGIN}/link/google signed in as them, then run this again.${O}`);
  }
  if (!isErr) {
    try {
      const out = JSON.parse(text);
      console.log(`\n${B}Gallery${O}  ${A}${out.gallery_url}${O}`);
      if (out.launch_url) console.log(`${B}Launch${O}   ${A}${out.launch_url}${O}`);
    } catch { /* already printed */ }
  }
}

main().catch((e) => { console.error(`\n${R}${e.message}${O}`); process.exit(1); });
