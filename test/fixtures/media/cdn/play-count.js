// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The media-files test's fixture (fix round 1, S1): a script served from another site that follows the page's
// video and does nothing about captions: it notes on the video that it has been played.
(function () {
  var v = document.querySelector('video');
  if (!v) return;
  v.addEventListener('play', function () { v.setAttribute('data-played', String(Number(v.getAttribute('data-played') || 0) + 1)); });
})();
