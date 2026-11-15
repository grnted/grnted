// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The media-files test's fixture (fix round 1, S1): a player script served from another site. It shows what is
// said as text over the page's video while it plays (no text track): the line for the current time, in a box it
// makes when the video first reports its time.
(function () {
  var v = document.querySelector('video[data-lines]');
  if (!v) return;
  var lines = JSON.parse(v.getAttribute('data-lines'));
  var box = null;
  v.addEventListener('timeupdate', function () {
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:absolute;left:0;right:0;bottom:36px;text-align:center;color:#fff;background:rgba(0,0,0,.75);font:16px sans-serif';
      v.parentNode.appendChild(box);
    }
    var now = lines.filter(function (l) { return v.currentTime >= l[0] && v.currentTime < l[1]; })[0];
    box.textContent = now ? now[2] : '';
  });
})();
