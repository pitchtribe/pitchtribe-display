/* PitchTribe — pacing for a panel that scrolls itself.

   A TV has no scrollbar and nobody standing at it, so a slide holding more than
   one screenful walks its own content past: still at the top, a steady crawl
   down, still at the bottom. The only question worth getting right is the
   timing, and that is all this file does — the arithmetic, with no DOM in it, so
   it can be checked without a browser.

   The crawl speed is set in the panel's own font size per second rather than in
   pixels, because the panel is sized in viewport units: the same number then
   means the same reading pace on a 32" screen in a bar and a 65" one in a foyer.

   Three things are being traded off:
   - every row has to get on screen, or the slide is lying about the feed;
   - a slide cannot sit on the rotation forever, so the extension is capped;
   - a scroll too slow to notice looks like a screen that has frozen, so a
     generous slot is only stretched into so far, and then the panel rests at
     the bottom for what is left. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PTScroll = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PAUSE_MS = 1800; // held still at each end
  const EMS_PER_SEC = 3.4; // crawl speed, in the panel's own font sizes
  const MAX_MS = 90000; // longest a scrolling slide may hold the rotation
  const MIN_TRAVEL_MS = 1000;
  const SLOWEST_FACTOR = 3; // how far a long slot may stretch the crawl out

  /**
   * How long to scroll `distance` px of overflow, and how long the slide should
   * stay up to see it through.
   *
   * @param {object} o
   * @param {number} o.distance  px of content below the fold (<= 1 means it fits)
   * @param {number} o.em        the panel's font size in px, which sets the pace
   * @param {number} o.dwellMs   the slide's own slot; the scroll never gets less
   * @returns {{scrolls: boolean, distance: number, totalMs: number, travelMs: number, pauseMs: number}}
   *   `totalMs` is what to ask the player for, `travelMs` how long the crawl
   *   itself runs after the opening pause. `scrolls: false` means it all fits and
   *   nothing should move.
   */
  function plan({ distance, em, dwellMs, pauseMs = PAUSE_MS, emsPerSec = EMS_PER_SEC, maxMs = MAX_MS, slowestFactor = SLOWEST_FACTOR } = {}) {
    const span = Number(distance);
    const still = { scrolls: false, distance: 0, totalMs: 0, travelMs: 0, pauseMs: 0 };
    if (!Number.isFinite(span) || span <= 1) return still;

    const pause = Math.max(0, Number(pauseMs) || 0);
    const pxPerSec = Math.max(Number(em) || 16, 1) * Math.max(Number(emsPerSec) || EMS_PER_SEC, 0.1);
    const crawlMs = (span / pxPerSec) * 1000;
    const slot = Math.max(Number(dwellMs) || 0, 0);

    // Its own slot when that is already long enough, otherwise what the crawl
    // asks for — up to the cap, past which it scrolls faster rather than staying
    // longer. Never shorter than the slot the playlist gave it.
    const totalMs = Math.max(slot, Math.min(pause * 2 + crawlMs, Math.max(Number(maxMs) || MAX_MS, MIN_TRAVEL_MS + pause * 2)));
    const travelMs = Math.max(Math.min(totalMs - pause * 2, crawlMs * Math.max(Number(slowestFactor) || SLOWEST_FACTOR, 1)), MIN_TRAVEL_MS);

    return { scrolls: true, distance: span, totalMs: Math.round(totalMs), travelMs: Math.round(travelMs), pauseMs: pause };
  }

  /**
   * Where the track should sit, in px above its start, `elapsed` ms into a run.
   * Clamped at both ends, so the opening pause and anything after the crawl has
   * finished hold still instead of overshooting.
   */
  function offsetAt(plan_, elapsed) {
    if (!plan_ || !plan_.scrolls) return 0;
    const at = (Number(elapsed) - plan_.pauseMs) / plan_.travelMs;
    if (!Number.isFinite(at) || at <= 0) return 0;
    return plan_.distance * Math.min(1, at);
  }

  return { plan, offsetAt, PAUSE_MS, EMS_PER_SEC, MAX_MS, MIN_TRAVEL_MS, SLOWEST_FACTOR };
});
