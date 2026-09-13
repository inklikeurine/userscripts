// ==UserScript==
// @name         YouTube: Hide Shorts
// @namespace    https://github.com/inklikeurine/userscripts
// @version      1.00
// @description  Removes Shorts from the home feed, subscriptions, search results and the sidebar.
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-start
// @homepageURL  https://github.com/inklikeurine/userscripts/tree/main/youtube/hide-shorts
// @supportURL   https://github.com/inklikeurine/userscripts/issues
// @downloadURL  https://raw.githubusercontent.com/inklikeurine/userscripts/main/youtube/hide-shorts/hide-shorts.user.js
// @updateURL    https://raw.githubusercontent.com/inklikeurine/userscripts/main/youtube/hide-shorts/hide-shorts.user.js
// ==/UserScript==

// CSS-only. One <style> element injected at document-start, before YouTube
// renders anything, so Shorts never flash into view. YouTube is a single-page
// app, but a stylesheet in <head> survives its in-page navigation, so there
// is no observer and nothing to re-run.
//
// Selectors verified against the live DOM on 2026-09-13 (logged out). See
// @local/notes/sites/youtube.md for what each element is and how it changed.

(function () {
  'use strict';

  const STYLE_ID = 'hide-shorts-style';

  const SELECTORS = [
    // --- Shelves ------------------------------------------------------------
    // Search results and feeds build Shorts shelves from "lockup" items; hide
    // the whole shelf so its "Shorts" header goes too. Two tag variants exist.
    'grid-shelf-view-model:has(ytm-shorts-lockup-view-model)',
    'grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2)',
    'ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model)',
    'ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model-v2)',
    // Older shelf elements, still used on watch pages and channel pages.
    'ytd-rich-shelf-renderer[is-shorts]',
    'ytd-reel-shelf-renderer',

    // --- Individual Shorts listed among normal videos ----------------------
    // Any video card whose link goes to /shorts/ is a Short.
    'ytd-video-renderer:has(a[href^="/shorts/"])',
    'ytd-rich-item-renderer:has(a[href^="/shorts/"])',
    'ytd-grid-video-renderer:has(a[href^="/shorts/"])',
    'ytd-compact-video-renderer:has(a[href^="/shorts/"])',

    // --- Navigation ---------------------------------------------------------
    // Sidebar entries (expanded and collapsed guide). Matched on href, not on
    // the label, so this works in every UI language.
    'ytd-guide-entry-renderer:has(a#endpoint[href="/shorts/"])',
    'ytd-mini-guide-entry-renderer:has(a#endpoint[href="/shorts/"])',
    // Channel page "Shorts" tab. This one is matched on its label.
    'yt-tab-shape[tab-title="Shorts"]',
  ];

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = SELECTORS.join(',\n') + ' { display: none !important; }';
    // <head> may not exist yet at document-start; <html> always does.
    (document.head || document.documentElement).appendChild(style);
  }

  inject();
})();
