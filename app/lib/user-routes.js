'use strict';
/* Settings → People: the club's dashboard logins, one record per volunteer
   instead of the single shared password.

   Every rule about a user record — what a username may be, which role may do
   what, that the last owner cannot be removed — lives in lib/user-model.js.
   This file is only the HTTP layer: it works out who is asking, asks the model
   whether that is allowed, and persists the answer. If a rule looks like it
   belongs to both, it belongs to the model.

   These routes hang off the authenticated `api` router, so a session cookie and
   the x-pitchtribe header have already been checked (see requireAuth in
   lib/app.js). What is checked here is the narrower question of whether this
   particular volunteer may manage the people list.

   Sessions: a signed-in volunteer's cookie names them and carries the moment it
   was issued (lib/auth.js). Suspending an account or resetting its password
   therefore takes effect on that person's very next request and on nobody
   else's — um.setPassword stamps the account, and lib/app.js turns away cookies
   older than the stamp. Nothing here rotates the club-wide signing secret,
   because one volunteer's reset must not log the screens-night team out
   mid-match. */
const { generateSecurePassword } = require('./password-policy');

const auth = require('./auth');
const v = require('./validate');
const um = require('./user-model');

/* A starter password, for when an owner adds somebody and would rather not
   invent one. A policy-compliant random password — the volunteer is told it once, on screen, and
   has to replace it at first sign-in, so it is readable-ish rather than
   memorable. */
const newTemporaryPassword = generateSecurePassword;

function mountUserRoutes({ api, store, limiter, adminHash, currentUser = () => null, audit }) {
  const data = () => store.data;

  const route = (fn) => (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out && typeof out.then === 'function') out.catch(next);
    } catch (err) {
      next(err);
    }
  };

  /* Who is making this request: the signed-in volunteer, or null when the
     session was opened with the club's one shared dashboard password. */
  const actor = (req) => currentUser(req) || null;

  /** Guard for every route here: may this person manage who can sign in? */
  function requirePeopleAdmin(req) {
    const me = actor(req);
    /* Nobody in particular is signed in, so this is the shared dashboard
       password — already checked by requireAuth, and it grants everything there
       is to grant. A club that signs in by name never takes this branch. */
    if (!me) return null;
    if (!um.can(me, 'users')) throw new v.HttpError(403, 'Only an owner can manage who can sign in');
    return me;
  }

  function userOr404(id) {
    const user = um.findById(data().users, id);
    if (!user) throw new v.HttpError(404, 'No such person');
    return user;
  }

  /* `touch`, not `mutate`: the people list changes nothing on the screens, so
     there is no revision to bump and no reason to make every player reload its
     playlist. `immediate` because a password hash must not be left sitting in
     the store's 30-second save timer when the Pi loses power. */
  const save = (fn) => store.touch(fn, { immediate: true });

  api.get(
    '/users',
    route((req, res) => {
      const me = requirePeopleAdmin(req);
      res.set('Cache-Control', 'no-store').json({
        users: um.usersView(data().users),
        roles: um.ROLES,
        // Who the dashboard thinks it is, so the page can grey out the controls
        // that would lock this person out of it.
        me: um.publicUser(me),
      });
    })
  );

  api.post(
    '/users',
    route((req, res) => {
      requirePeopleAdmin(req);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      // No password in the form means "give me one to read out": it is returned
      // once, in this response, and never recoverable afterwards.
      const temporary = !body.password;
      const password = temporary ? newTemporaryPassword() : body.password;
      const user = um.createUser(
        { ...body, password, mustChangePassword: temporary || v.bool(body.mustChangePassword, false) },
        { users: data().users }
      );
      save((d) => {
        d.users.push(user);
      });
      audit?.logAdminAction(req.ip, 'user_created', { userId: user.id });
      res.status(201).json({ user: um.publicUser(user), ...(temporary ? { temporaryPassword: password } : {}) });
    })
  );

  api.patch(
    '/users/:id',
    route((req, res) => {
      const me = requirePeopleAdmin(req);
      const user = userOr404(req.params.id);
      const body = { ...(req.body && typeof req.body === 'object' ? req.body : {}) };

      /* The model keeps the club's last owner. This keeps the person doing the
         clicking: demoting or switching off your own account is how an owner
         loses the page they would need to undo it, even with other owners
         around to ask. */
      if (me && me.id === user.id) {
        if (body.role !== undefined && um.role(body.role, user.role) !== user.role) {
          throw v.bad('You cannot change your own role — ask another owner to do it');
        }
        if (body.active !== undefined && !v.bool(body.active, true)) {
          throw v.bad('You cannot switch off your own account');
        }
      }

      // Credentials are not part of an edit. They go through the reset route
      // below, which asks for the owner's own password first.
      delete body.password;
      delete body.passwordHash;
      delete body.mustChangePassword;

      save((d) => {
        um.applyUpdate(um.findById(d.users, user.id), body, { users: d.users });
      });
      audit?.logAdminAction(req.ip, 'user_updated', { userId: user.id });
      res.json({ user: um.publicUser(um.findById(data().users, req.params.id)) });
    })
  );

  api.delete(
    '/users/:id',
    route((req, res) => {
      const me = requirePeopleAdmin(req);
      const user = userOr404(req.params.id);
      if (me && me.id === user.id) throw v.bad('You cannot remove your own account');
      um.assertRemovable(user, data().users);
      save((d) => {
        d.users = d.users.filter((u) => u.id !== user.id);
      });
      audit?.logAdminAction(req.ip, 'user_removed', { userId: user.id });
      res.json({ ok: true, removed: user.id });
    })
  );

  api.post(
    '/users/:id/password-reset',
    route((req, res) => {
      const me = requirePeopleAdmin(req);
      const user = userOr404(req.params.id);
      const body = req.body && typeof req.body === 'object' ? req.body : {};

      /* Handing out somebody else's password is the one thing on this page
         worth doing from a borrowed, unlocked laptop, so it asks for the
         owner's own password again — the bar Settings → Remote access already
         sets — and sits behind the login limiter so the prompt is not itself a
         way to guess it. */
      if (limiter && limiter.blocked(req.ip)) {
        throw new v.HttpError(429, 'Too many attempts — wait 15 minutes and try again');
      }
      const expected = me ? me.passwordHash : adminHash && adminHash();
      if (!auth.verifyPassword(String(body.currentPassword || ''), expected)) {
        if (limiter) limiter.fail(req.ip);
        throw new v.HttpError(403, 'Your own dashboard password isn’t right');
      }
      if (limiter) limiter.reset(req.ip);

      const temporary = !body.password;
      const password = temporary ? newTemporaryPassword() : body.password;
      save((d) => {
        const target = um.findById(d.users, user.id);
        um.setPassword(target, password);
        // A password the owner read out loud is for getting in once. One the
        // volunteer chose and typed themselves is theirs to keep.
        target.mustChangePassword = temporary;
      });
      audit?.logPasswordReset(req.ip, { userId: user.id });
      res.json({
        user: um.publicUser(um.findById(data().users, req.params.id)),
        ...(temporary ? { temporaryPassword: password } : {}),
      });
    })
  );
}

module.exports = { mountUserRoutes, newTemporaryPassword };
