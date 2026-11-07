// ==UserScript==
// @name         Magnet Grabber
// @namespace    https://github.com/inklikeurine/userscripts
// @version      1.00
// @description  Copy magnet links to the clipboard on click instead of opening a torrent client.
// @match        *://*/*
// @grant        none
// @run-at       document-start
// @homepageURL  https://github.com/inklikeurine/userscripts/tree/main/any-site/magnet-grabber
// @supportURL   https://github.com/inklikeurine/userscripts/issues
// @downloadURL  https://raw.githubusercontent.com/inklikeurine/userscripts/main/any-site/magnet-grabber/magnet-grabber.user.js
// @updateURL    https://raw.githubusercontent.com/inklikeurine/userscripts/main/any-site/magnet-grabber/magnet-grabber.user.js
// ==/UserScript==

// magnet-grabber — a click on a magnet link copies it and shows a brief
// popup at the pointer. One delegated capture-phase listener on document, so
// there is nothing to re-apply on SPA navigation and nothing to double-inject.

(function () {
  'use strict';

  const POPUP_MS = 400;
  const FADE_MS = 150;

  function showPopup(text, x, y) {
    const popup = document.createElement('div');
    popup.textContent = text;
    Object.assign(popup.style, {
      position: 'fixed',
      left: (x + 10) + 'px',
      top: (y + 10) + 'px',
      zIndex: '2147483647',
      background: 'rgba(0, 0, 0, 0.85)',
      color: '#fff',
      padding: '4px 8px',
      borderRadius: '4px',
      fontSize: '12px',
      fontFamily: 'sans-serif',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 0.1s linear',
    });
    document.body.appendChild(popup);

    requestAnimationFrame(function () { popup.style.opacity = '1'; });
    setTimeout(function () {
      popup.style.opacity = '0';
      setTimeout(function () { popup.remove(); }, FADE_MS);
    }, POPUP_MS);
  }

  // The async Clipboard API needs a secure context; plain-http pages fall
  // back to a hidden textarea and execCommand (allowed inside a click).
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('execCommand copy failed'));
  }

  document.addEventListener('click', function (e) {
    const link = e.target.closest && e.target.closest('a[href^="magnet:" i]');
    if (!link) return;

    e.preventDefault();
    e.stopPropagation();

    const { clientX, clientY } = e;
    copyText(link.getAttribute('href')).then(
      function () { showPopup('Magnet copied!', clientX, clientY); },
      function () { showPopup('Copy failed', clientX, clientY); }
    );
  }, true);
})();
