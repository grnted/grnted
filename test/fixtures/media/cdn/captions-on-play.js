// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The media-files test's fixture (fix round 1, S1): a player script served from another site. It gives the
// page's video its captions track the first time the video plays; until then the video has no track at all.
(function () {
  var v = document.querySelector('video[data-text]');
  if (!v) return;
  v.addEventListener('play', function once() {
    v.removeEventListener('play', once);
    var t = document.createElement('track');
    t.kind = 'captions';
    t.srclang = 'en';
    t.label = 'English';
    t.default = true;
    t.src = v.getAttribute('data-text');
    v.appendChild(t);
  });
})();
