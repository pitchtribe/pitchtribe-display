'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('jukebox advances by queue position when the same track is queued twice', () => {
  const window = {};
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'shared', 'jukebox-queue.js'), 'utf8');
  vm.runInNewContext(source, { window });

  const queue = ['track-a', 'track-a', 'track-b'];
  const played = [queue[0]];
  let index = 0;
  while (true) {
    index = window.PTJukeboxQueue.nextIndex(index, queue.length);
    if (index === -1) break;
    played.push(queue[index]);
  }

  assert.deepEqual(played, ['track-a', 'track-a', 'track-b']);
  assert.equal(window.PTJukeboxQueue.nextIndex(queue.length - 1, queue.length), -1, 'the queue stops after its last entry');
});
