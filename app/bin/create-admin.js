#!/usr/bin/env node
'use strict';
/* Adds a dashboard login from the command line, for the times the dashboard
 * itself cannot help: moving a club off its shared password, or getting back
 * into a card whose last owner has left the club.
 *
 * Run it with the service stopped — the server keeps the database in memory and
 * would write its own copy back over this one:
 *
 *   sudo systemctl stop pitchtribe
 *   node bin/create-admin.js --username jane /var/lib/pitchtribe/db.json
 *   sudo systemctl start pitchtribe
 *
 * The first account created is always an owner: somebody has to be able to add
 * everyone else. With no --password it adopts the club's existing shared
 * dashboard password, so nobody has to be told anything new; after that, an
 * omitted password is generated and printed once.
 */
const fs = require('node:fs');

const { Store } = require('../lib/store');
const setup = require('../lib/setup');
const um = require('../lib/user-model');
const { generateSecurePassword } = require('../lib/password-policy');

const USAGE = `usage: create-admin.js [options] <path to db.json>

  --username <name>   login name, lower-case (default: ${setup.DEFAULT_OWNER_USERNAME})
  --name <full name>  how the people list shows them
  --email <address>   for a password-reset link
  --role <role>       ${um.ROLES.join(' | ')} (default: owner)
  --password <secret> or PT_PASSWORD in the environment
  --must-change       make them choose their own password at first sign-in
  --retire-shared     switch the club's shared dashboard password off afterwards
  --list              show the people list and stop
  --help

With no --password the first account adopts the club's shared dashboard
password; later accounts get a generated one, printed once.`;

const FLAGS = new Set(['--must-change', '--retire-shared', '--list', '--help', '-h']);
const VALUES = new Set(['--username', '--name', '--email', '--role', '--password']);

function parseArgs(argv) {
  const opts = { file: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FLAGS.has(arg)) {
      opts[arg.replace(/^-+/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true;
    } else if (VALUES.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      opts[arg.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else if (opts.file) {
      throw new Error('give one path to db.json');
    } else {
      opts.file = arg;
    }
  }
  return opts;
}

const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

function describe(data) {
  const state = setup.setupState(data);
  const lines = [`Stage: ${state.stage} — ${state.users} login(s), ${state.owners} owner(s), shared dashboard password ${state.sharedPassword ? 'on' : 'off'}`];
  for (const u of um.usersView(data.users)) {
    lines.push(`  ${u.username.padEnd(20)} ${u.role.padEnd(7)} ${u.active ? 'active ' : 'off    '} ${u.mustChangePassword ? 'must change password' : ''}`.trimEnd());
  }
  if (!data.users.length) lines.push('  (nobody on the people list yet)');
  return lines.join('\n');
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    fail(`${err.message}\n\n${USAGE}`, 2);
  }
  if (opts.help || opts.h) {
    console.log(USAGE);
    return;
  }
  if (!opts.file) fail(USAGE, 2);
  if (!fs.existsSync(opts.file)) {
    fail(`${opts.file} not found — has the dashboard been set up yet? If not, just open it and choose a password.`);
  }

  // The store normalises an older database on the way in (a version-1 file has
  // no users key at all) and writes it back atomically, 0600.
  const store = new Store(opts.file);
  const data = store.data;

  if (opts.list) {
    console.log(describe(data));
    return;
  }

  const first = !data.users.length;
  const password = opts.password || process.env.PT_PASSWORD || '';
  // An adopted password is the club's own and a typed one is the operator's
  // choice; only a password this tool invented has to be replaced.
  let generated = '';
  if (!password && !(first && setup.sharedPasswordActive(data))) {
    generated = generateSecurePassword();
  }

  const body = {
    username: opts.username,
    name: opts.name,
    email: opts.email,
    password: password || generated,
    mustChangePassword: Boolean(opts.mustChange || generated),
  };

  let user;
  try {
    if (first) {
      if (opts.role && opts.role !== 'owner') {
        fail('The first login has to be an owner — somebody has to be able to add everyone else.');
      }
      user = setup.firstOwner(data, body);
    } else {
      if (!body.username) fail('--username is needed: only the first account gets a default name.', 2);
      user = um.createUser({ ...body, role: opts.role || 'owner' }, { users: data.users });
    }
    data.users.push(user);
    if (opts.retireShared) setup.retireSharedPassword(data);
  } catch (err) {
    // Validation errors (lib/validate.js) carry a status and a message written
    // for the person reading it; anything else is a bug and should show itself.
    if (!err || !err.status) throw err;
    fail(err.message);
  }

  store.writeNow();

  console.log(`Added ${user.username} (${user.role}).`);
  if (generated) console.log(`Password: ${generated}\nWrite it down now — it is not stored anywhere and cannot be shown again.`);
  else if (!password) console.log('This account signs in with the club’s existing shared dashboard password.');
  if (opts.retireShared) {
    console.log('The shared dashboard password is off: everyone now signs in with their own name and password.');
  }
  if (setup.sharedPasswordActive(data)) {
    console.log('The shared dashboard password still works too. Retire it with --retire-shared once everyone has their own login.');
  }
  console.log('\nStart the dashboard again: sudo systemctl start pitchtribe');
}

main(process.argv.slice(2));
