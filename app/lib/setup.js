'use strict';
/* First run, and the move off the club's one shared password.

   A card is always at one of three stages, and this module names them so the
   sign-in screen, the first-owner step and bin/create-admin.js all agree:

     fresh  — nothing set up: no shared password, nobody on the people list.
              The dashboard shows its setup wizard (POST /api/auth/setup).
     shared — the club has a shared dashboard password and no people list. That
              is both a version-1 database and a card that has just finished the
              wizard: every volunteer types the same password.
     users  — somebody has a login of their own (lib/user-model.js).

   Moving a club from `shared` to `users` must not change the password anybody
   types. Clubs upgrade mid-match, and whoever is on screens duty tonight knows
   one password and is not reading release notes. So the first owner account
   adopts the existing shared hash as it stands — the same password, now
   attached to a name — and the shared password keeps working beside it until
   the club explicitly retires it.

   Nothing here reads or writes the database: callers pass in the data object
   from the store and persist the result (store.touch / Store.writeNow). */
const crypto = require('node:crypto');

const auth = require('./auth');
const v = require('./validate');
const um = require('./user-model');

const STAGES = { FRESH: 'fresh', SHARED: 'shared', USERS: 'users' };

/** The username an owner account gets when nobody says otherwise. */
const DEFAULT_OWNER_USERNAME = 'admin';

const sharedPasswordHash = (data) => (data && data.settings && data.settings.adminHash) || '';

const userList = (data) => (data && Array.isArray(data.users) ? data.users : []);

function stage(data) {
  if (userList(data).length) return STAGES.USERS;
  return sharedPasswordHash(data) ? STAGES.SHARED : STAGES.FRESH;
}

/** Is the setup wizard still the only thing this card can offer?

    Deliberately not "there is no shared password": a club that has retired its
    shared password has logins, and must not be offered a fresh start that would
    hand the card — and its content — to whoever opened the page first. */
const setupRequired = (data) => stage(data) === STAGES.FRESH;

/** True while the one password everyone knows still signs people in. */
const sharedPasswordActive = (data) => Boolean(sharedPasswordHash(data));

/** Everything the dashboard needs to know about where this card has got to. */
function setupState(data) {
  const current = stage(data);
  const users = userList(data);
  return {
    stage: current,
    setupRequired: current === STAGES.FRESH,
    /* A shared password and nobody on the people list: offer to turn it into
       the first owner's account. um.needsUserMigration says the same thing
       about a version-1 database; this also covers a card set up since. */
    migrationRequired: current === STAGES.SHARED,
    sharedPassword: sharedPasswordActive(data),
    users: users.length,
    owners: um.owners(users).length,
  };
}

/* A password nobody will ever type: the record is built through the model so
   every rule about it stays in one place, and the hash is then replaced with
   the club's existing one. */
const placeholderPassword = () => crypto.randomBytes(18).toString('base64url');

/** Build the club's first login, an owner by definition — somebody has to be
    able to add everyone else. Returns the record for the caller to persist.

    With no password in `body`, the account adopts the shared dashboard
    password, so the club carries on typing what it already types. */
function firstOwner(data, body = {}, { now = new Date() } = {}) {
  const users = userList(data);
  if (users.length) {
    throw new v.HttpError(409, 'The club already has logins — add people from Settings → People');
  }
  const shared = sharedPasswordHash(data);
  const chosen = body.password ? String(body.password) : '';
  if (!chosen && !shared) throw v.bad('Choose a password for this account');

  const user = um.createUser(
    {
      ...body,
      username: body.username || DEFAULT_OWNER_USERNAME,
      password: chosen || placeholderPassword(),
      role: 'owner',
      active: true,
      // A password somebody typed in is theirs to keep, and the shared one is
      // the club's own; neither is a starter password to be replaced at once.
      mustChangePassword: v.bool(body.mustChangePassword, false),
    },
    { users, now }
  );
  if (!chosen) user.passwordHash = shared;
  return user;
}

/** Switch the shared dashboard password off, in place. Returns false if there
    was none.

    The sessions it issued go with it: lib/app.js honours a shared-password
    cookie only while this hash is there. A volunteer signed in under their own
    name keeps their session, which is the point of doing it this way round —
    the club does not get signed out of its own dashboard mid-match.

    Only worth doing once people can sign in by name, so it refuses to leave
    the club outside: somebody has to hold an owner login of their own. */
function retireSharedPassword(data) {
  if (!sharedPasswordActive(data)) return false;
  const owners = um.owners(userList(data)).filter((u) => u.passwordHash);
  if (!owners.length) {
    throw v.bad('Give somebody their own owner login first — retiring the shared password now would lock the club out');
  }
  data.settings.adminHash = '';
  return true;
}

/* ---------------------------------------------------------------- routes ---
   Mounted on the authenticated dashboard router, so a session cookie and the
   x-pitchtribe header have already been checked (requireAuth in lib/app.js).
   While a club is at the `shared` stage there is nobody in particular signed
   in — only somebody who knew the club's password, which grants everything
   there is to grant — so claiming the first owner asks no further question
   about who it is. Once there are logins, both routes here are spent. */
function mountSetupRoutes({ api, store, limiter, adminHash = () => '', currentUser = () => null }) {
  const data = () => store.data;

  const route = (fn) => (req, res, next) => {
    try {
      fn(req, res);
    } catch (err) {
      next(err);
    }
  };

  /* `touch`, not `mutate`: logins change nothing on the screens, so there is no
     revision to bump and no reason to make every player reload its playlist.
     `immediate` because a password hash must not be left sitting in the store's
     30-second save timer when the Pi loses power. */
  const save = (fn) => store.touch(fn, { immediate: true });

  api.get('/setup/state', (req, res) => res.set('Cache-Control', 'no-store').json(setupState(data())));

  api.post(
    '/setup/owner',
    route((req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const user = firstOwner(data(), body);
      save((d) => {
        d.users.push(user);
      });
      res.status(201).json({
        user: um.publicUser(user),
        // Nothing to read out: this account signs in with the password the club
        // already uses. The dashboard says so instead of showing a new one.
        adoptedSharedPassword: !body.password,
      });
    })
  );

  api.post(
    '/setup/retire-shared-password',
    route((req, res) => {
      const me = currentUser(req) || null;
      if (me && !um.can(me, 'users')) {
        throw new v.HttpError(403, 'Only an owner can change how the club signs in');
      }
      /* Taking away the password every volunteer knows is worth doing from a
         borrowed, unlocked laptop, so it asks for the password of whoever is
         asking — the bar Settings → Remote access and a password reset already
         set — behind the login limiter, so the prompt is not itself a way to
         guess it. */
      if (limiter && limiter.blocked(req.ip)) {
        throw new v.HttpError(429, 'Too many attempts — wait 15 minutes and try again');
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const expected = me ? me.passwordHash : adminHash();
      if (!auth.verifyPassword(String(body.currentPassword || ''), expected)) {
        if (limiter) limiter.fail(req.ip);
        throw new v.HttpError(403, 'Your own dashboard password isn’t right');
      }
      if (limiter) limiter.reset(req.ip);

      let retired = false;
      save((d) => {
        retired = retireSharedPassword(d);
      });
      res.json({
        retired,
        ...setupState(data()),
        /* The shared password's own sessions die with it, this one included:
           whoever did this from the club's shared login has to sign in again,
           by name this time. */
        signedOut: retired && !me,
      });
    })
  );
}

module.exports = {
  STAGES,
  DEFAULT_OWNER_USERNAME,
  stage,
  setupState,
  setupRequired,
  sharedPasswordActive,
  firstOwner,
  retireSharedPassword,
  mountSetupRoutes,
};
