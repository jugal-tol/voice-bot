'use strict';
/**
 * EnableX Demo Portal — SSO side-door (ADDITIVE, no dependencies).
 *
 * Does NOT change the app's existing client-side login. It only adds an optional
 * auto-login entry used when a visitor arrives from the demo portal carrying a
 * short-lived, portal-signed token:
 *
 *    GET /sso?token=<RS256 JWT signed by the demo portal>
 *
 * EvueMe's native auth is a client-side flag: sessionStorage['evueme_auth']='ok'.
 * On a valid token this route returns a tiny page that sets that SAME flag and
 * redirects into the app. Direct visitors keep using /login.html, untouched.
 *
 * Verified with Node's built-in `crypto` (no external libraries), using the
 * portal's public key (bundled as portal-public.pem). One-time use is enforced
 * in-memory. If the public key is missing, the /sso route just sends to login.
 *
 *   PORTAL_PUBLIC_KEY_PATH  path to the portal's public key (default ./portal-public.pem)
 *   PORTAL_PUBLIC_KEY       (alternative) the PEM contents directly
 *   SSO_TARGET_ID           expected token audience (default: evueme)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logLogin } = require('../loginLog');

const ISSUER = 'demo-portal';
const TARGET_ID = process.env.SSO_TARGET_ID || 'evueme';
const AUTH_KEY = 'evueme_auth'; // matches public/login.html + index.html

function loadPublicKey() {
  try {
    if (process.env.PORTAL_PUBLIC_KEY) return process.env.PORTAL_PUBLIC_KEY;
    const p = process.env.PORTAL_PUBLIC_KEY_PATH || path.join(__dirname, 'portal-public.pem');
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}
const PUBLIC_KEY = loadPublicKey();

function b64urlToBuffer(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function verifyToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, s] = parts;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), PUBLIC_KEY, b64urlToBuffer(s));
  if (!ok) throw new Error('bad signature');
  const claims = JSON.parse(b64urlToBuffer(p).toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && now > claims.exp) throw new Error('expired');
  if (claims.iss !== ISSUER) throw new Error('bad issuer');
  if (claims.aud !== TARGET_ID) throw new Error('bad audience');
  return claims;
}

const usedNonces = new Map();
function nonceAlreadyUsed(nonce, expSec) {
  const now = Date.now();
  for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n);
  if (usedNonces.has(nonce)) return true;
  usedNonces.set(nonce, expSec ? expSec * 1000 : now + 120000);
  return false;
}

function ssoHandler(req, res) {
  if (!PUBLIC_KEY) return res.redirect('/login.html');
  const token = req.query.token;
  if (!token) return res.redirect('/login.html');

  let claims;
  try {
    claims = verifyToken(token);
  } catch (e) {
    console.warn('[portal-sso] token verify failed:', e.message);
    return res.redirect('/login.html?sso=invalid');
  }

  if (nonceAlreadyUsed(claims.nonce, claims.exp)) {
    console.warn('[portal-sso] token already used');
    return res.redirect('/login.html?sso=expired');
  }

  // Record this portal-launched (SSO) login (fire-and-forget).
  logLogin({ username: claims.user, source: 'evueme-portal-login', req }).catch(() => {});

  // Set the SAME client-side flag the native login sets, then enter the app.
  res.set('Content-Type', 'text/html');
  res.send(
    '<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title></head>' +
      '<body><script>try{sessionStorage.setItem(' +
      JSON.stringify(AUTH_KEY) +
      ",'ok');sessionStorage.setItem('evueme_entry','sso');sessionStorage.setItem('evueme_user'," +
      JSON.stringify(claims.user || '') +
      ");}catch(e){}location.replace('/');</script>Signing you in…</body></html>"
  );
}

module.exports = { ssoHandler, isConfigured: () => !!PUBLIC_KEY };
