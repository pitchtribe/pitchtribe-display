/* Queue position helpers for the dashboard jukebox. */
(() => {
  'use strict';
  window.PTJukeboxQueue = {
    nextIndex(currentIndex, length) {
      const next = currentIndex + 1;
      return next >= 0 && next < length ? next : -1;
    },
  };
})();
