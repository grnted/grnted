// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The media-files test's fixture (fix round 1, S3): a player script served from another site that gives the
// page's video its captions track when the video comes into view (a lazy player).
(function () {
  var v = document.querySelector('video[data-text]');
  if (!v || !('IntersectionObserver' in window)) return;
  var io = new IntersectionObserver(function (entries) {
    if (!entries.some(function (e) { return e.isIntersecting; })) return;
    io.disconnect();
    var t = document.createElement('track');
    t.kind = 'captions';
    t.srclang = 'en';
    t.label = 'English';
    t.default = true;
    t.src = v.getAttribute('data-text');
    v.appendChild(t);
  });
  io.observe(v);
})();
