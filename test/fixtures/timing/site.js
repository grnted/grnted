// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Shared site script: the menu toggle and, on the home page, a slideshow with a pause button.
(function () {
  var menu = document.getElementById('menu-toggle');
  if (menu) menu.addEventListener('click', function () { var n = document.getElementById('nav'); n.hidden = !n.hidden; menu.setAttribute('aria-expanded', String(!n.hidden)); });
  var slides = document.querySelectorAll('.slide');
  if (!slides.length) return;
  var i = 0;
  var timer = setInterval(function () { slides[i].classList.remove('on'); i = (i + 1) % slides.length; slides[i].classList.add('on'); }, 5000);
  document.getElementById('pause').addEventListener('click', function () { clearInterval(timer); this.textContent = 'Paused'; });
})();
