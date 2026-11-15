// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The media-files test's fixture (files-script.html): a script that gives the video its captions when a button
// far from the video is pressed.
document.addEventListener('click', function (e) {
  if (e.target.id !== 'load-en') return;
  var t = document.createElement('track');
  t.kind = 'captions';
  t.srclang = 'en';
  t.src = '/files/speech.vtt';
  document.getElementById('scripted').appendChild(t);
});
