'use strict';
/* Dashboard logins: one record per volunteer, instead of the club sharing a
   single password. This module owns the shape of a user record and every rule
   about it — what a username may be, which role can do what, who may not be
   deleted — so the routes, the sign-in flow and the first-run migration all
   agree. Nothing here reads or writes the database: callers pass in the users
   array from the store and persist the result through store.mutate().

   A record looks like:
     { id, username, name, email, role, active, passwordHash,
       mustChangePassword, createdAt, updatedAt, lastLoginAt,
       tokensValidFrom }

   passwordHash is scrypt (lib/auth.js) and must never reach the browser —
   send users through publicUser() on the way out. */
const auth = require('./auth');
const v = require('./validate');
const { newId } = require('./store');

/* Three roles, because a club is not an enterprise:
     owner  — runs the club's screens: content, settings and the people list
     editor — puts things on the screens, cannot change settings or people
     viewer — can look at the dashboard and change nothing
   There is always at least one owner; the guards below enforce that. */
const ROLES = ['owner', 'editor', 'viewer'];
const DEFAULT_ROLE = 'editor';

/* What each role may do. Routes ask can(user, 'users'), never user.role ===
   'owner', so adding a role later is a change to this table alone. */
const CAPABILITIES = {
  owner: ['view', 'content', 'settings', 'users'],
  editor: ['view', 'content'],
  viewer: ['view'],
};

const USERNAME_MAX = 32;
const USERNAME_MIN = 3;
// Lower-case letters, digits, dot, dash, underscore. Volunteers type this on a
// phone keyboard and read it off a note pinned in the clubhouse, so no spaces,
// no capitals to get wrong, and no leading punctuation.
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const { validatePassword, MIN_LENGTH: PASSWORD_MIN } = require('./password-policy');

const PASSWORD_MAX = 200;

/** Usernames are compared and stored lower-case: 'Jane' and 'jane' are one person. */
const normalizeUsername = (value) => String(value == null ? '' : value).trim().toLowerCase();

const normalizeEmail = (value) => String(value == null ? '' : value).trim().toLowerCase();

const findById = (users, id) => (users || []).find((u) => u.id === id) || null;

const findByUsername = (users, username) => {
  const wanted = normalizeUsername(username);
  if (!wanted) return null;
  return (users || []).find((u) => normalizeUsername(u.username) === wanted) || null;
};

const findByEmail = (users, email) => {
  const wanted = normalizeEmail(email);
  if (!wanted) return null;
  return (users || []).find((u) => normalizeEmail(u.email) === wanted) || null;
};

const owners = (users) => (users || []).filter((u) => u.role === 'owner' && u.active !== false);

/** Owners who could still run the club if this one stopped being one. */
const otherOwners = (users, user) => owners(users).filter((u) => u.id !== (user && user.id));

/** Can this user do this? Unknown or inactive users can do nothing. */
function can(user, capability) {
  if (!user || user.active === false) return false;
  return (CAPABILITIES[user.role] || []).includes(capability);
}

function email(value, { required = false } = {}) {
  const s = normalizeEmail(v.str(value, { max: 200, field: 'Email' }));
  if (!s) {
    if (required) throw v.bad('Email is required');
    return '';
  }
  // Deliberately loose: the only thing the dashboard does with an address is
  // send a password-reset link, and a club's address can be anything.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s)) throw v.bad('Enter a valid email address');
  return s;
}

function username(value, { users = [], existing = null } = {}) {
  const s = normalizeUsername(v.str(value, { max: USERNAME_MAX, required: true, field: 'Username' }));
  if (s.length < USERNAME_MIN) throw v.bad(`Username must be at least ${USERNAME_MIN} characters`);
  if (!USERNAME_RE.test(s)) {
    throw v.bad('Username can use lower-case letters, numbers, dots, dashes and underscores, and must start with a letter or number');
  }
  const clash = findByUsername(users, s);
  if (clash && (!existing || clash.id !== existing.id)) throw v.bad('That username is already taken');
  return s;
}

/** The one place the password rules live, so reset and change agree with sign-up. */
function password(value, { username: name = '' } = {}) {
  const s = String(value == null ? '' : value);
  if (s.length < PASSWORD_MIN) throw v.bad(`Password must be at least ${PASSWORD_MIN} characters`);
  if (s.length > PASSWORD_MAX) throw v.bad(`Password is too long (max ${PASSWORD_MAX} characters)`);
  if (name && s.toLowerCase() === normalizeUsername(name)) throw v.bad('Password cannot be the same as the username');
  const result = validatePassword(s);
  if (!result.valid) throw v.bad(result.errors.join('; '));

  return s;
}

const role = (value, fallback = DEFAULT_ROLE) => v.oneOf(String(value || ''), ROLES, fallback);

/** Validate the fields a form may set. Throws HttpError(400) on bad input. */
function sanitizeUser(body, { users = [], existing = null } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const pick = (key) => (b[key] !== undefined ? b[key] : existing ? existing[key] : undefined);
  const next = {
    username: username(pick('username'), { users, existing }),
    name: v.str(pick('name'), { max: 80, field: 'Name' }),
    email: email(pick('email')),
    role: role(pick('role'), existing ? existing.role : DEFAULT_ROLE),
    // Accounts are active unless someone said otherwise: a form that omits the
    // field is editing something else, not suspending the volunteer.
    active: v.bool(pick('active'), true),
  };
  if (next.email) {
    const clash = findByEmail(users, next.email);
    if (clash && (!existing || clash.id !== existing.id)) throw v.bad('That email address is already in use');
  }
  // A name is handy on the people list but not worth blocking anyone over.
  if (!next.name) next.name = next.username;
  return next;
}

/** Build a complete record. `password` is hashed here and never kept in clear. */
function createUser(body, { users = [], now = new Date() } = {}) {
  const fields = sanitizeUser(body, { users });
  const stamp = now.toISOString();
  return {
    id: newId(),
    ...fields,
    passwordHash: auth.hashPassword(password(body && body.password, { username: fields.username })),
    // Set when an owner hands out a starter password: the dashboard asks for a
    // new one before letting the volunteer get on with anything else.
    mustChangePassword: v.bool(body && body.mustChangePassword, false),
    createdAt: stamp,
    updatedAt: stamp,
    lastLoginAt: null,
  };
}

/** Apply an edit in place. Pass the whole users array so clashes are caught. */
function applyUpdate(user, body, { users = [], now = new Date() } = {}) {
  const fields = sanitizeUser(body, { users, existing: user });
  // Demoting or suspending the only owner would lock the club out of its own
  // settings and people list, with nobody left who could put it right.
  const losesOwner = user.role === 'owner' && (fields.role !== 'owner' || fields.active === false);
  if (losesOwner && !otherOwners(users, user).length) {
    throw v.bad('The club needs at least one owner — make someone else an owner first');
  }
  Object.assign(user, fields, { updatedAt: now.toISOString() });
  return user;
}

/** Set a new password, and sign out the sessions that were opened with the old
    one — this volunteer's only, not the club's (see sessionValid). The caller
    issues a fresh cookie for whoever is doing the typing so they stay in. */
function setPassword(user, value, { now = new Date() } = {}) {
  user.passwordHash = auth.hashPassword(password(value, { username: user.username }));
  user.mustChangePassword = false;
  user.tokensValidFrom = now.toISOString();
  user.updatedAt = now.toISOString();
  return user;
}

/** Does a session this account opened at `issuedAt` (ms, from the cookie) still
    count? No once the password has been changed or reset since, so a cookie
    signed in with the old password stops working — the club-wide signing secret
    cannot tell one volunteer's cookie from another's, this can. Suspended and
    deleted accounts are turned away here too, on their very next request. */
function sessionValid(user, issuedAt) {
  if (!user || user.active === false) return false;
  // No stamp: nothing has signed this account out, so any live cookie is good.
  const validFrom = Date.parse(user.tokensValidFrom || '');
  if (!Number.isFinite(validFrom)) return true;
  const opened = Number(issuedAt);
  if (!Number.isFinite(opened)) return false;
  // `>=`, so the cookie issued in the same millisecond as the change — the one
  // belonging to the person making it — is kept.
  return opened >= validFrom;
}

/** True when this password signs this user in. Inactive accounts never match. */
function verifyUserPassword(user, value) {
  if (!user || user.active === false || !user.passwordHash) return false;
  return auth.verifyPassword(value, user.passwordHash);
}

/** Guard for a delete: the last owner has to stay. */
function assertRemovable(user, users) {
  if (!user) throw new v.HttpError(404, 'No such person');
  if (user.role === 'owner' && !otherOwners(users, user).length) {
    throw v.bad('The club needs at least one owner — make someone else an owner before removing this one');
  }
  return user;
}

function recordLogin(user, { now = new Date() } = {}) {
  user.lastLoginAt = now.toISOString();
  return user;
}

/** The only shape a user may be sent to the browser in: no password hash. */
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name || user.username,
    email: user.email || '',
    role: user.role,
    active: user.active !== false,
    mustChangePassword: Boolean(user.mustChangePassword),
    createdAt: user.createdAt || null,
    lastLoginAt: user.lastLoginAt || null,
    can: CAPABILITIES[user.role] || [],
  };
}

/** The people list, owners first then alphabetical — how the dashboard shows it. */
const usersView = (users) =>
  (users || [])
    .map(publicUser)
    .sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.username.localeCompare(b.username));

/** A version-1 database: a shared password and nobody on the people list yet.
    The first-run migration turns that hash into the owner's account. */
const needsUserMigration = (data) =>
  Boolean(data && data.settings && data.settings.adminHash) && !(data.users || []).length;

module.exports = {
  ROLES,
  DEFAULT_ROLE,
  CAPABILITIES,
  USERNAME_RE,
  PASSWORD_MIN,
  normalizeUsername,
  normalizeEmail,
  findById,
  findByUsername,
  findByEmail,
  owners,
  otherOwners,
  can,
  email,
  username,
  password,
  role,
  sanitizeUser,
  createUser,
  applyUpdate,
  setPassword,
  sessionValid,
  verifyUserPassword,
  assertRemovable,
  recordLogin,
  publicUser,
  usersView,
  needsUserMigration,
};
