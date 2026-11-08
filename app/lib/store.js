'use strict';
/* JSON-file store. Club-sized data (hundreds of records) fits comfortably in
   memory; every mutation is written atomically (temp file + rename) so a
   power cut on the Pi never leaves a half-written database. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const SCHEMA_VERSION = 1;

function defaultSports() {
  return {
    enabled: false,
    leagues: ['eng.1'],
    timezone: 'Europe/London',
    apiToken: crypto.randomBytes(24).toString('base64url'),
  };
}

function emptyData() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    settings: {
      clubName: '',
      adminHash: '',
      sessionSecret: crypto.randomBytes(32).toString('hex'),
      defaultPlaylistId: null,
      sports: defaultSports(),
      widgets: { weather: null, wikipedia: true },
      language: 'en',
      portal: null, // guest Wi-Fi settings; null = defaults (see lib/portal-page.js)
      // Off by default: HTTPS on this Pi can only ever use a self-signed
      // certificate, so forcing it would greet every volunteer with a browser
      // warning. The club turns it on under Settings → Secure connection.
      httpsRedirect: false,
    },
    assets: [],
    playlists: [],
    screens: [],
  };
}

class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.data = this.load();
    this.saveTimer = null;
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const data = emptyData();
      this.writeNow(data);
      return data;
    }
    const data = JSON.parse(raw);
    const base = emptyData();
    const settings = { ...base.settings, ...data.settings };
    settings.sports = { ...base.settings.sports, ...(data.settings && data.settings.sports) };
    settings.widgets = { ...base.settings.widgets, ...(data.settings && data.settings.widgets) };
    return { ...base, ...data, settings };
  }

  writeNow(data = this.data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Apply a content change: bump the revision, persist, notify screens. */
  mutate(fn) {
    const result = fn(this.data);
    this.data.revision += 1;
    this.writeNow();
    this.emit('change', this.data.revision);
    return result;
  }

  /** Housekeeping change (heartbeats, settings) that screens needn't reload for.
      Persisted lazily so frequent heartbeats don't wear the SD card. */
  touch(fn, { immediate = false } = {}) {
    const result = fn(this.data);
    if (immediate) {
      this.flush();
    } else if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.flush(), 30_000);
      this.saveTimer.unref();
    }
    return result;
  }

  /** Replace everything with a restored database (from a backup file). */
  replace(next) {
    const revision = Math.max(this.data.revision || 0, next.revision || 0) + 1;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.writeNow({ ...next, revision });
    this.data = this.load();
    this.emit('change', this.data.revision);
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.writeNow();
  }
}

const newId = () => crypto.randomBytes(6).toString('base64url');

module.exports = { Store, newId };
