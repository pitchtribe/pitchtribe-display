'use strict';
/* Dashboard passwords and sessions, scrypt-hashed and HMAC-signed.
   A club signs in either as a volunteer on its people list (lib/user-model.js)
   or, on a card that has not grown a people list yet, with the single password
   it shared between everyone. Sessions are stateless signed cookies; rotating
   settings.sessionSecret signs the whole club out. */
const crypto = require('node:crypto');

const COOKIE = 'pt_session';
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

let decoyHash = null;
/** Spend a password check's worth of work with no password to check against.
    Verifying is deliberately slow, so a sign-in that answers a username nobody
    has straight away would quietly tell a stranger which volunteers exist. The
    decoy is built on first use: a club that is never probed never pays for it. */
function burnPasswordTime(password) {
  if (!decoyHash) decoyHash = hashPassword(crypto.randomBytes(16).toString('base64'));
  verifyPassword(password, decoyHash);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

/* A session carries its own text and a signature over it, so the server keeps
   no list of who is signed in. Two shapes, because a club that upgrades
   mid-match must not find its dashboard signed out:
     v1.<expires>                      — whoever knew the club's shared password
     v2.<userId>.<issuedAt>.<expires>  — one volunteer's own account

   The issue time is what lets one person be signed out on their own. Changing
   or resetting a volunteer's password stamps their account (tokensValidFrom in
   lib/user-model.js) and every cookie issued before the stamp stops being
   accepted, while the club-wide signing secret — and so everybody else's
   session — is left alone. Rotating that secret still signs the whole club out.

   Ids are base64url (lib/store.js newId), so they never contain the dot the
   parts are joined with. */
function issueToken(secret, userId = null, { now = Date.now() } = {}) {
  const expires = now + SESSION_DAYS * 86400 * 1000;
  const body = userId ? `v2.${userId}.${now}.${expires}` : `v1.${expires}`;
  return `${body}.${sign(body, secret)}`;
}

/** Read a session back: `{ userId, issuedAt, expires }`, with `userId` null for
    a shared-password session — or null for a cookie that is missing, mangled,
    tampered with or out of date. Whether that user still exists, is still
    switched on, and has not been signed out since `issuedAt` is the caller's
    question; this only says what the cookie claims. */
function readToken(token, secret) {
  const parts = String(token || '').split('.');
  const version = parts[0];
  const want = version === 'v1' ? 3 : version === 'v2' ? 5 : 0;
  if (parts.length !== want) return null;
  const given = Buffer.from(parts.pop());
  const body = parts.join('.');
  const expected = Buffer.from(sign(body, secret));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const named = version === 'v2';
  // A v2 cookie with no id in it names nobody; it is not the shared session.
  if (named && !parts[1]) return null;
  const issuedAt = named ? Number(parts[2]) : null;
  const expires = Number(parts[named ? 3 : 1]);
  if (!Number.isFinite(expires) || expires <= Date.now()) return null;
  if (named && !Number.isFinite(issuedAt)) return null;
  return { userId: named ? parts[1] : null, issuedAt, expires };
}

/** Is this a usable session, whoever it belongs to? */
const verifyToken = (token, secret) => readToken(token, secret) !== null;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, req) {
  const secure = req.secure ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

/** Tiny in-memory limiter for login attempts: 10 failures per 15 min per IP. */
class LoginLimiter {
  constructor({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  blocked(ip) {
    const rec = this.hits.get(ip);
    if (!rec) return false;
    if (Date.now() - rec.first > this.windowMs) {
      this.hits.delete(ip);
      return false;
    }
    return rec.count >= this.max;
  }
  fail(ip) {
    const rec = this.hits.get(ip);
    if (!rec || Date.now() - rec.first > this.windowMs) this.hits.set(ip, { first: Date.now(), count: 1 });
    else rec.count += 1;
  }
  reset(ip) {
    this.hits.delete(ip);
  }
}

module.exports = {
  COOKIE,
  hashPassword,
  verifyPassword,
  burnPasswordTime,
  issueToken,
  readToken,
  verifyToken,
  parseCookies,
  sessionCookie,
  clearCookie,
  LoginLimiter,
};
