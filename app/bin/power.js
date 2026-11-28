#!/usr/bin/env node
'use strict';
/* PitchTribe power control helper: reboots or shuts down the Pi as requested
   from the dashboard (Settings → Power). Runs as root (pitchtribe-power@.service),
   because the dashboard's server can't initiate a system reboot or shutdown.

     power.js status    record the last action (boot)
     power.js request   do what power-request.json asks

   power-request.json, written by the server:
     { id, action: 'reboot' }
     { id, action: 'shutdown' }
   power-status.json, written here:
     { last, lastRequestId }

   The status file is a mirror that the dashboard reads to know the last action
   taken. This helper reads the request file and executes the requested action.

   Safety: The request file is mode 0600, written atomically, and only actions
   'reboot' and 'shutdown' are accepted. Idempotency is provided by the
   lastRequestId check — the same request won't be executed twice. */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const REQUEST_FILE = path.join(DATA_DIR, 'power-request.json');
const STATUS_FILE = path.join(DATA_DIR, 'power-status.json');
const OWNER = process.env.DASHBOARD_USER || 'pitchtribe';
const GROUP = process.env.DASHBOARD_GROUP || 'pitchtribe-dashboard';

const command = process.argv[2];
if (!['status', 'request'].includes(command)) {
  console.error(`Usage: ${process.argv[1]} {status|request}`);
  process.exit(1);
}

/** Read a file as JSON, refusing symlinks and non-regular files. Returns null
    if the file doesn't exist or can't be parsed. */
function readJsonStrict(filepath) {
  try {
    const fd = fs.openSync(filepath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      fs.closeSync(fd);
      return null;
    }
    const content = fs.readFileSync(fd, 'utf8');
    fs.closeSync(fd);
    return JSON.parse(content);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Could not read ${filepath}: ${err.message}`);
    }
    return null;
  }
}

/** Write JSON to a file atomically, with specified mode and owner. */
function writeJson(filepath, data, mode, owner, group) {
  const tmp = `${filepath}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n');
  fs.fchownSync(fd, owner, group);
  fs.fchmodSync(fd, mode);
  fs.closeSync(fd);
  fs.renameSync(tmp, filepath);
}

/** Get the UID for a username. */
function getUid(username) {
  try {
    const entry = childProcess.execFileSync('id', ['-u', username], { encoding: 'utf8' }).trim();
    return Number(entry);
  } catch {
    console.error(`Could not get UID for user ${username}`);
    return 0;
  }
}

/** Get the GID for a group name. */
function getGid(groupname) {
  try {
    const entry = childProcess.execFileSync('getent', ['group', groupname], { encoding: 'utf8' }).trim();
    const gid = entry.split(':')[2];
    return Number(gid);
  } catch {
    console.error(`Could not get GID for group ${groupname}`);
    return 0;
  }
}

const uid = getUid(OWNER);
const gid = getGid(GROUP);

function status() {
  const existing = readJsonStrict(STATUS_FILE) || {};
  const data = {
    last: existing.last || null,
    lastRequestId: existing.lastRequestId || null,
  };
  writeJson(STATUS_FILE, data, 0o640, 0, gid);
  console.log('Status recorded');
}

function request() {
  const req = readJsonStrict(REQUEST_FILE);
  if (!req) {
    console.log('No request file found');
    return;
  }

  const existing = readJsonStrict(STATUS_FILE) || {};
  if (existing.lastRequestId === req.id) {
    console.log(`Request ${req.id} already processed — skipping`);
    return;
  }

  const { action } = req;
  if (action !== 'reboot' && action !== 'shutdown') {
    console.error(`Invalid action: ${action}`);
    return;
  }

  console.log(`Processing power request ${req.id}: ${action}`);

  // Update status first
  const statusData = {
    last: { action, at: new Date().toISOString() },
    lastRequestId: req.id,
  };
  writeJson(STATUS_FILE, statusData, 0o640, 0, gid);

  // Execute the action with a 2-second delay to allow the response to be sent
  setTimeout(() => {
    try {
      if (action === 'reboot') {
        console.log('Rebooting the system...');
        childProcess.execFileSync('systemctl', ['reboot']);
      } else if (action === 'shutdown') {
        console.log('Shutting down the system...');
        childProcess.execFileSync('systemctl', ['poweroff']);
      }
    } catch (err) {
      console.error(`Failed to ${action}: ${err.message}`);
    }
  }, 2000);
}

if (command === 'status') {
  status();
} else if (command === 'request') {
  request();
}
