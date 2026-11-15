// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The media-files test's fixture (the cut round, review media-v S2): a player script served from another site. It
// gives the page's video an empty captions track of its own, and fills it only when a visitor chooses it in the
// browser's captions menu (the track's mode becomes "showing"). Nothing happens when the video just plays.
(function () {
  var v = document.querySelector('video[data-lines]');
  if (!v) return;
  var lines = JSON.parse(v.getAttribute('data-lines'));
  var t = v.addTextTrack('captions', 'English', 'en');
  t.mode = 'disabled';
  v.textTracks.addEventListener('change', function () {
    if (t.mode !== 'disabled' && !(t.cues && t.cues.length)) lines.forEach(function (l) { t.addCue(new VTTCue(l[0], l[1], l[2])); });
  });
})();
