'use strict';
/**
 * Runtime deployment.
 *
 * STATUS: both paths are scaffolded, not live. The Apps Script call sequence
 * below is written out in full and guarded by a single NOT_IMPLEMENTED switch;
 * everything around it — identity, token acquisition, gallery registration —
 * is complete and exercised. Flip APPS_SCRIPT_LIVE=1 once the Colgate Google
 * client exists and the sequence has been run by hand once.
 */

const crypto = require('node:crypto');

const APPS_SCRIPT_LIVE = /^(1|true|yes)$/i.test(process.env.APPS_SCRIPT_LIVE || '');
/**
 * Demo mode: simulate the deployment so the end-to-end flow can be explored
 * without a Google OAuth client. The manifest guardrails and file mapping
 * below still run for real — only the four network calls are skipped.
 * Never set FOUNDRY_DEMO in a real deployment.
 */
const DEMO = /^(1|true|yes)$/i.test(process.env.FOUNDRY_DEMO || '');
const SCRIPT_API = 'https://script.googleapis.com/v1';

/** Apps Script expects a specific file layout; map our filenames onto it. */
function toScriptFiles(files) {
  const out = [];
  for (const [name, source] of Object.entries(files)) {
    if (name === 'appsscript.json') {
      out.push({ name: 'appsscript', type: 'JSON', source });
    } else if (/\.gs$/i.test(name)) {
      out.push({ name: name.replace(/\.gs$/i, ''), type: 'SERVER_JS', source });
    } else if (/\.html?$/i.test(name)) {
      out.push({ name: name.replace(/\.html?$/i, ''), type: 'HTML', source });
    }
    // Anything else is build output Apps Script cannot host; drop it.
  }
  if (!out.some((f) => f.name === 'appsscript')) {
    throw new Error('appsscript.json is required for an Apps Script deployment');
  }
  if (!out.some((f) => f.type === 'SERVER_JS')) {
    throw new Error('At least one .gs file is required (Code.gs with doGet)');
  }
  return out;
}

/** Reject a manifest that would run as the deployer or escape the domain. */
function assertSafeManifest(files) {
  let manifest;
  try { manifest = JSON.parse(files['appsscript.json']); }
  catch { throw new Error('appsscript.json is not valid JSON'); }
  const webapp = manifest.webapp || {};
  if (webapp.executeAs !== 'USER_ACCESSING') {
    throw new Error(
      'appsscript.json must set webapp.executeAs = "USER_ACCESSING". Running as the deployer '
      + 'would give every viewer the publisher\'s access to campus data.');
  }
  if (webapp.access !== 'DOMAIN') {
    throw new Error('appsscript.json must set webapp.access = "DOMAIN" to keep the app inside colgate.edu.');
  }
  return manifest;
}

async function api(accessToken, method, path, body) {
  const resp = await fetch(`${SCRIPT_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = json.error?.message || `HTTP ${resp.status}`;
    // The commonest first-run failure, and the error text alone doesn't say so.
    if (/not been used|disabled|PERMISSION_DENIED/i.test(msg)) {
      throw new Error(
        `${msg}\n\nMost likely the user has not turned on "Google Apps Script API" at `
        + 'https://script.google.com/home/usersettings. That is a per-user setting with no '
        + 'admin override, and the API fails opaquely without it.');
    }
    throw new Error(msg);
  }
  return json;
}

/**
 * Create an Apps Script project, push the bundle, cut a version and deploy it
 * as a domain-restricted web app — all as the requesting user.
 *
 * Acting as the user is not a stylistic choice: the Apps Script API does not
 * work with service accounts, so there is no app-only path.
 *
 * Required scopes (granted at /link/google):
 *   https://www.googleapis.com/auth/script.projects
 *   https://www.googleapis.com/auth/script.deployments
 */
async function deployAppsScript({ accessToken, title, files }) {
  assertSafeManifest(files);
  const scriptFiles = toScriptFiles(files);

  if (DEMO) {
    // Shaped like a real Apps Script deployment, but nothing was deployed.
    const scriptId = 'demo-' + crypto.randomBytes(12).toString('hex');
    const deploymentId = 'AKfycb' + crypto.randomBytes(16).toString('base64url').slice(0, 26);
    return {
      scriptId,
      deploymentId,
      versionNumber: 1,
      launchUrl: `https://script.google.com/a/macros/colgate.edu/s/${deploymentId}/exec`,
      simulated: true,
      fileCount: scriptFiles.length,
    };
  }

  if (!APPS_SCRIPT_LIVE) {
    throw new Error(
      'NOT_IMPLEMENTED: Apps Script deployment is scaffolded but not enabled.\n\n'
      + 'The call sequence below is implemented in publisher-mcp/deploy.js and runs once '
      + 'APPS_SCRIPT_LIVE=1 and a Colgate Google OAuth client is configured:\n'
      + '  1. POST   /v1/projects                      { title }            -> scriptId\n'
      + '  2. PUT    /v1/projects/{scriptId}/content   { files[] }\n'
      + '  3. POST   /v1/projects/{scriptId}/versions  { description }      -> versionNumber\n'
      + '  4. POST   /v1/projects/{scriptId}/deployments\n'
      + '            { versionNumber, manifestFileName: "appsscript", description }\n'
      + `\nValidated so far: manifest is domain-restricted and executes as the viewer; `
      + `${scriptFiles.length} file(s) map cleanly onto the Apps Script layout.`);
  }

  // 1. Create the project.
  const project = await api(accessToken, 'POST', '/projects', { title });
  const scriptId = project.scriptId;

  // 2. Push the bundle.
  await api(accessToken, 'PUT', `/projects/${scriptId}/content`, { files: scriptFiles });

  // 3. Cut an immutable version.
  const version = await api(accessToken, 'POST', `/projects/${scriptId}/versions`, {
    description: `Published from Claude via Colgate App Foundry on ${new Date().toISOString()}`,
  });

  // 4. Deploy that version as a web app.
  const deployment = await api(accessToken, 'POST', `/projects/${scriptId}/deployments`, {
    versionNumber: version.versionNumber,
    manifestFileName: 'appsscript',
    description: 'Colgate App Foundry',
  });

  const webApp = (deployment.entryPoints || []).find((e) => e.entryPointType === 'WEB_APP');
  const launchUrl = webApp?.webApp?.url
    || `https://script.google.com/a/macros/colgate.edu/s/${deployment.deploymentId}/exec`;

  return { scriptId, deploymentId: deployment.deploymentId, versionNumber: version.versionNumber, launchUrl };
}

/**
 * Power Apps Code Apps: build the handoff, don't pretend to deploy.
 *
 * There is no REST API for Code Apps — publishing runs through a CLI, the
 * service-principal path returns 500s while `pac code push` is in preview, and
 * a service principal cannot create a new code app at all (a maker must run
 * `pac code init` first). So this returns the exact commands instead, and the
 * gallery card is filed as `pending` rather than claiming the app is live.
 */
function buildPowerAppsBundle({ title, files }) {
  const names = Object.keys(files);
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
  return {
    fileCount: names.length,
    instructions:
      `Power Apps Code Apps have no deployment API, so this one needs three commands run `
      + `locally, signed in as yourself:\n\n`
      + `  pac auth create --deviceCode\n`
      + `  pac code init --displayName ${JSON.stringify(title)}\n`
      + `  npm run build && pa app push\n\n`
      + `Files in the bundle: ${names.join(', ')}\n\n`
      + `The gallery card is filed as "pending". Once the app is live, set its launch URL:\n`
      + `  curl -X PATCH https://foundry.colgate.edu/api/artifacts/<id> \\\n`
      + `    -H 'Content-Type: application/json' \\\n`
      + `    -d '{"launch_url":"https://apps.powerapps.com/play/e/<env>/a/<app>","deploy_status":"deployed"}'\n\n`
      + `Suggested project directory: ${slug}/`,
  };
}

module.exports = { deployAppsScript, buildPowerAppsBundle, toScriptFiles, assertSafeManifest };
