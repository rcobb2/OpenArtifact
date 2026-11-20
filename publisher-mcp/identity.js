'use strict';
/**
 * Identity: validate the bearer token Claude presents against Dex.
 *
 * Claude for Enterprise is registered as the `claude-foundry` static client in
 * deploy/dex.yaml, using the "Use your own OAuth client" option. The token it
 * sends is a Dex-issued ID token, so verifying its signature against the Dex
 * JWKS gives a trustworthy @colgate.edu identity — which is the whole reason
 * this server uses OAuth rather than a shared static bearer. A shared token
 * authenticates the *connector*, not the person, and this server has to know
 * the person: it attributes published apps to them and lists their apps back.
 *
 * Zero dependencies, so the JWS verification is done with node:crypto.
 */

const crypto = require('node:crypto');

const JWKS_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_S = 60;

const cache = { url: null, keys: null, fetchedAt: 0 };

const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Discover the JWKS URI from the issuer's OIDC metadata, then fetch the keys. */
async function getKeys(issuer) {
  if (cache.url === issuer && cache.keys && Date.now() - cache.fetchedAt < JWKS_TTL_MS) {
    return cache.keys;
  }
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const discovery = await fetch(discoveryUrl, { signal: AbortSignal.timeout(10_000) });
  if (!discovery.ok) throw new Error(`OIDC discovery failed: HTTP ${discovery.status} from ${discoveryUrl}`);
  const meta = await discovery.json();
  if (meta.issuer !== issuer) {
    throw new Error(`Issuer mismatch: metadata says ${meta.issuer}, expected ${issuer}`);
  }
  const jwksResp = await fetch(meta.jwks_uri, { signal: AbortSignal.timeout(10_000) });
  if (!jwksResp.ok) throw new Error(`JWKS fetch failed: HTTP ${jwksResp.status}`);
  const { keys } = await jwksResp.json();
  if (!Array.isArray(keys) || !keys.length) throw new Error('JWKS contained no keys');
  cache.url = issuer;
  cache.keys = keys;
  cache.fetchedAt = Date.now();
  return keys;
}

const ALGS = {
  RS256: { hash: 'RSA-SHA256', pad: crypto.constants.RSA_PKCS1_PADDING },
  RS384: { hash: 'RSA-SHA384', pad: crypto.constants.RSA_PKCS1_PADDING },
  RS512: { hash: 'RSA-SHA512', pad: crypto.constants.RSA_PKCS1_PADDING },
  PS256: { hash: 'RSA-SHA256', pad: crypto.constants.RSA_PKCS1_PSS_PADDING },
  ES256: { hash: 'SHA256', ec: true },
};

function verifySignature(jwk, alg, signingInput, signature) {
  const spec = ALGS[alg];
  if (!spec) throw new Error(`Unsupported JWT algorithm: ${alg}`);
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (spec.ec) {
    // JWS ES256 signatures are raw r||s; Node expects DER unless told otherwise.
    return crypto.createVerify(spec.hash)
      .update(signingInput)
      .verify({ key, dsaEncoding: 'ieee-p1363' }, signature);
  }
  return crypto.createVerify(spec.hash).update(signingInput).verify(
    { key, padding: spec.pad, ...(spec.pad === crypto.constants.RSA_PKCS1_PSS_PADDING
      ? { saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST } : {}) },
    signature,
  );
}

/**
 * Verify a Dex-issued JWT and return { email, name, sub }.
 * Throws with a readable reason on any failure — the caller turns that into a
 * 401 with a WWW-Authenticate pointing at the resource metadata.
 */
async function verifyDexToken(token, { issuer, audience, allowedDomain }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');
  const [h, pl, sig] = parts;

  let header, claims;
  try {
    header = JSON.parse(b64urlToBuf(h).toString('utf8'));
    claims = JSON.parse(b64urlToBuf(pl).toString('utf8'));
  } catch { throw new Error('Malformed JWT segments'); }

  if (header.alg === 'none') throw new Error('Unsigned tokens are not accepted');

  const keys = await getKeys(issuer);
  const candidates = header.kid ? keys.filter((k) => k.kid === header.kid) : keys;
  if (!candidates.length) throw new Error(`No JWKS key matches kid ${header.kid}`);

  const signingInput = Buffer.from(`${h}.${pl}`);
  const signature = b64urlToBuf(sig);
  const verified = candidates.some((jwk) => {
    try { return verifySignature(jwk, header.alg, signingInput, signature); }
    catch { return false; }
  });
  if (!verified) throw new Error('JWT signature verification failed');

  // Claims.
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== issuer) throw new Error(`Unexpected issuer: ${claims.iss}`);
  if (typeof claims.exp === 'number' && claims.exp + CLOCK_SKEW_S < now) throw new Error('Token expired');
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > now) throw new Error('Token not yet valid');

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (audience && !aud.includes(audience)) {
    throw new Error(`Token audience ${JSON.stringify(claims.aud)} does not include ${audience}`);
  }

  const email = String(claims.email || '').trim().toLowerCase();
  if (!email) throw new Error('Token carries no email claim');
  if (allowedDomain && !email.endsWith('@' + allowedDomain)) {
    throw new Error(`${email} is not a @${allowedDomain} account`);
  }
  // Dex sets email_verified from the upstream provider; both Google (with
  // hostedDomains) and Entra (single-tenant) vouch for the address.
  if (claims.email_verified === false) throw new Error(`${email} is not verified`);

  return { email, name: claims.name || email, sub: claims.sub };
}

module.exports = { verifyDexToken, _getKeys: getKeys };
