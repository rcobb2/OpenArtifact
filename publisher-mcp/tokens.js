'use strict';
/**
 * Capability: per-user Google refresh tokens for the Apps Script API.
 *
 * Why this exists at all: the Apps Script API does not work with service
 * accounts, so deployment must act with a *delegated user* credential. Dex
 * cannot mint Apps Script scopes either, so the identity token Claude sends is
 * no help here. Hence a second, narrow consent at /link/google whose refresh
 * token is kept here, encrypted, keyed by email.
 *
 * Storage is a JSON file under /data. Refresh tokens are long-lived campus
 * credentials, so they are encrypted at rest with AES-256-GCM under
 * TOKEN_ENCRYPTION_KEY rather than written in the clear.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Demo mode. Lets the whole publish flow be explored without a Google OAuth
 * client. Never set FOUNDRY_DEMO in a real deployment: linked accounts are
 * fake and no Google call is ever made.
 */
const DEMO = /^(1|true|yes)$/i.test(process.env.FOUNDRY_DEMO || '');

const DATA_DIR = process.env.TOKEN_DATA_DIR || '/data';
const STORE_PATH = path.join(DATA_DIR, 'google-tokens.json');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function encryptionKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY || '';
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes of hex (openssl rand -hex 32)');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function decrypt(blob) {
  const [iv, tag, data] = String(blob).split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
  catch { return {}; }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

/** Short-lived access tokens, kept in memory only. */
const accessCache = new Map(); // email -> { token, expiresAt }

const tokenStore = {
  isLinked(email) {
    return !!readStore()[email.toLowerCase()];
  },

  /** Demo-only: mark an account linked without talking to Google. */
  storeDemoLink(email) {
    if (!DEMO) throw new Error('storeDemoLink requires FOUNDRY_DEMO=1');
    const store = readStore();
    store[email.toLowerCase()] = {
      refresh_token: encrypt('demo-refresh-token'),
      scope: 'https://www.googleapis.com/auth/script.projects https://www.googleapis.com/auth/script.deployments',
      linked_at: new Date().toISOString(),
      demo: true,
    };
    writeStore(store);
    accessCache.delete(email.toLowerCase());
  },

  /** Trade the authorization code for a refresh token and persist it. */
  async exchangeAndStore(email, code, { clientId, clientSecret, redirectUri }) {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.error_description || body.error || `HTTP ${resp.status}`);
    if (!body.refresh_token) {
      throw new Error(
        'Google returned no refresh token. The consent must use access_type=offline '
        + 'and prompt=consent; re-authorizing without prompt=consent omits it.');
    }

    const store = readStore();
    store[email.toLowerCase()] = {
      refresh_token: encrypt(body.refresh_token),
      scope: body.scope || '',
      linked_at: new Date().toISOString(),
    };
    writeStore(store);
    accessCache.delete(email.toLowerCase());
    return true;
  },

  /**
   * A usable access token for this user, refreshing if needed.
   * Returns null when the user has not linked their account — the caller turns
   * that into an instruction rather than an error.
   */
  async getGoogleAccessToken(email, { clientId, clientSecret }) {
    const key = email.toLowerCase();
    const cached = accessCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const entry = readStore()[key];
    if (!entry) return null;
    if (entry.demo) {
      if (!DEMO) return null; // a demo link must never work outside demo mode
      return 'demo-access-token';
    }

    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: decrypt(entry.refresh_token),
        client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // invalid_grant means the user revoked consent or the token aged out.
      // Drop it so the next attempt sends them back through linking.
      if (body.error === 'invalid_grant') {
        const store = readStore();
        delete store[key];
        writeStore(store);
        return null;
      }
      throw new Error(`Google token refresh failed: ${body.error_description || body.error || resp.status}`);
    }

    const token = body.access_token;
    accessCache.set(key, { token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 });
    return token;
  },

  unlink(email) {
    const store = readStore();
    delete store[email.toLowerCase()];
    writeStore(store);
    accessCache.delete(email.toLowerCase());
  },
};

module.exports = { tokenStore, _encrypt: encrypt, _decrypt: decrypt };
