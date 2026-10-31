// ==UserScript==
// @name         Sonarr: Quick Tags
// @namespace    https://github.com/inklikeurine/userscripts
// @version      1.00
// @description  Adds a green tag button next to Links on a Sonarr series page that opens a small tag editor; tags save the moment you add or remove them.
// @match        *://*:8989/*
// @grant        none
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/inklikeurine/userscripts/tree/main/sonarr/quick-tags
// @supportURL   https://github.com/inklikeurine/userscripts/issues
// @downloadURL  https://raw.githubusercontent.com/inklikeurine/userscripts/main/sonarr/quick-tags/quick-tags.user.js
// @updateURL    https://raw.githubusercontent.com/inklikeurine/userscripts/main/sonarr/quick-tags/quick-tags.user.js
// ==/UserScript==

// quick-tags — a green "tag +" button in the row of labels on a Sonarr series
// page, right after "Links" (where Sonarr puts its own "Tags" label once a
// series has tags). It opens a small popover that works like Sonarr's own tag
// box: chips for the current tags, type to get suggestions, Enter / Tab /
// space / comma to add, Backspace in an empty box to remove the last tag,
// new tags are created on the spot. Every add or remove is saved at once.
//
// How it talks to Sonarr: the page itself publishes window.Sonarr
// ({ apiKey, urlBase, … }), and the script calls the same API the v5 web UI
// uses, <urlBase>/api/v5 (window.Sonarr.apiRoot still says /api/v3, which
// v5 keeps for other apps; the UI ignores it). Saving goes through the Mass
// Editor endpoint (PUT /series/editor with applyTags add/remove), which only
// touches tags. Sonarr then pushes the change to every open page, so its own
// Tags label updates without a reload.
//
// Requires Sonarr 5.0.0.2800 or newer.
//
// Runs on any address on port 8989 (Sonarr's default). Other addresses are
// added by the user in Violentmonkey's script settings; see the README. On a
// page that is not Sonarr (no window.Sonarr) the script does nothing.
//
// Structure:
//   apply()   — puts the button in place; safe to call any number of times
//   observe() — re-runs apply() as the page changes (Sonarr is a single-page app)
//   openPopover() / closePopover() and the render*/add*/remove* helpers below

(function () {
  'use strict';

  // Every element this script adds is tagged with this attribute so
  // re-running apply() finds and skips its own work.
  const MARK = 'data-quick-tags';
  const STYLE_ID = 'quick-tags-style';
  const POPOVER_ID = 'quick-tags-popover';
  const DEBOUNCE_MS = 150;

  // Sonarr's own rule for tag names (TagController; the server also
  // lowercases them), and the keys its tag box treats as "add this tag".
  const TAG_LABEL_RE = /^[a-z0-9-]+$/;
  const TAG_RULE_MESSAGE = 'Allowed characters a-z, 0-9 and -';
  const DELIMITERS = ['Tab', 'Enter', ' ', ','];

  // --- Selectors (verified 2026-10-31 against the built UI of Sonarr
  //     5.0.0.2907 and the source of 5.0.0.2800; v4 is not supported) ---
  //
  // Sonarr's class names are CSS modules, "<File>-module_<class>_<hash>",
  // e.g. "SeriesDetails-module_links_zqxuy". The hash changes per release;
  // the readable part does not, so match on that.
  //
  //   <div class="SeriesDetails-module_detailsChips_…">
  //     <div class="SeriesDetails-module_chipsRow_…">   first row: Monitored, Links, Tags
  //       <a …monitoredToggle…> Monitored label </a>
  //       <span class="Tooltip-module_reference_…">     Tooltip anchor wrapper
  //         <span class="SeriesDetails-module_detailsLabel_… Label-module_…">
  //           <svg/> <span class="SeriesDetails-module_links_…">Links</span>
  //       <span …reference…> Tags label </span>        only when the series has tags
  //     <div class="SeriesDetails-module_chipsRow_…">   second row: files, size, profile, …
  //
  // The button goes straight after the row child that holds "Links". (The
  // Links pop-up is rendered in a portal elsewhere, not inside this row.)
  function moduleClass(file, name) {
    return new RegExp('^' + file + '-module_' + name + '_');
  }
  const ROW_CLASS = moduleClass('SeriesDetails', 'chipsRow');
  const LABEL_CLASS = moduleClass('SeriesDetails', 'detailsLabel');
  const LINKS_CLASS = moduleClass('SeriesDetails', 'links');

  function hasClass(el, re) {
    return Array.prototype.some.call(el.classList, function (c) { return re.test(c); });
  }

  function closestWithClass(el, re) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (hasClass(node, re)) return node;
    }
    return null;
  }

  // Returns { row, child, label }: the chips row that holds the Links label,
  // the row's direct child that contains it, and the label element itself
  // (its classes are copied onto the button so it gets Sonarr's exact label
  // size and shape).
  function findLinks() {
    for (const text of document.querySelectorAll('span[class*="-module_links_"]')) {
      if (!hasClass(text, LINKS_CLASS)) continue;
      const row = closestWithClass(text, ROW_CLASS);
      if (!row) continue;
      let child = text;
      while (child.parentElement !== row) child = child.parentElement;
      return { row: row, child: child, label: closestWithClass(text, LABEL_CLASS) };
    }
    return null;
  }

  // --- Sonarr page and API ---

  function sonarr() {
    const s = window.Sonarr;
    return s && s.apiKey ? s : null;
  }

  // Series pages are <urlBase>/series/<titleSlug>.
  function currentSlug() {
    const prefix = (sonarr().urlBase || '') + '/series/';
    if (!location.pathname.startsWith(prefix)) return null;
    const slug = location.pathname.slice(prefix.length).split('/')[0];
    return slug ? decodeURIComponent(slug) : null;
  }

  async function api(method, path, body) {
    const s = sonarr();
    const response = await fetch((s.urlBase || '') + '/api/v5' + path, {
      method: method,
      headers: { 'X-Api-Key': s.apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  // Sonarr answers a rejected request with either a list of validation
  // errors or { message }.
  async function errorMessage(response) {
    try {
      const data = await response.json();
      if (Array.isArray(data) && data.length) return data.map(function (e) { return e.errorMessage; }).join('; ');
      if (data && data.message) return data.message;
    } catch (e) { /* not JSON */ }
    return 'Sonarr said ' + response.status + ' ' + response.statusText;
  }

  // The API looks series up by number, the page address uses the slug.
  // One full list per page load is enough; slugs don't change.
  const seriesIdBySlug = new Map();

  async function loadSeries(slug) {
    if (!seriesIdBySlug.has(slug)) {
      for (const s of await api('GET', '/series')) seriesIdBySlug.set(s.titleSlug, s.id);
    }
    const id = seriesIdBySlug.get(slug);
    if (id === undefined) throw new Error('Could not find this series in Sonarr.');
    return api('GET', '/series/' + id);
  }

  function byLabel(a, b) { return a.label.localeCompare(b.label); }

  // --- Styles ---
  //
  // Colours come from Sonarr's theme variables (Content/theme.css, light and
  // dark), with plain dark-theme values as fallbacks. The button's size and
  // shape come from the Links label's classes, copied onto it; the :where()
  // rule (zero specificity) only applies if that copy found nothing.

  const CSS = `
:where(.quick-tags-button) {
  margin: 0; padding: 5px 12px 5px 10px; border: 0; border-radius: 999px;
  font-size: 13px; line-height: 1;
}
.quick-tags-button.quick-tags-button {
  display: inline-flex; align-items: center; gap: 1px;
  border-color: var(--successColor, #3f9f5f); background-color: var(--successColor, #3f9f5f);
  color: var(--white, #fff); font-family: inherit; cursor: pointer;
}
.quick-tags-button.quick-tags-button:hover { filter: brightness(1.12); }
.quick-tags-button.quick-tags-button:focus-visible {
  outline: 2px solid var(--inputFocusBorderColor, #66afe9); outline-offset: 1px;
}
.quick-tags-button svg { display: block; flex-shrink: 0; fill: currentColor; opacity: 1; }
.quick-tags-button .quick-tags-icon-tag { width: 14px; height: 14px; }
.quick-tags-button .quick-tags-icon-plus { width: 9px; height: 9px; }

#${POPOVER_ID} {
  position: fixed; z-index: 2000; box-sizing: border-box;
  width: 340px; max-width: calc(100vw - 16px); padding: 10px; border-radius: 4px;
  background: var(--popoverBodyBackgroundColor, #2a2a2a);
  box-shadow: 0 5px 10px var(--popoverShadowColor, rgba(0, 0, 0, 0.2));
  color: var(--textColor, #ccc); font-size: 14px; line-height: 1.4; text-align: left;
}
#${POPOVER_ID}::before {
  content: ''; position: absolute; top: -10px; left: var(--quick-tags-arrow, 20px);
  margin-left: -10px; border: 10px solid transparent; border-top: 0;
  border-bottom-color: var(--popoverBodyBackgroundColor, #2a2a2a);
}
#${POPOVER_ID} .quick-tags-box {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
  min-height: 35px; box-sizing: border-box; padding: 2px 6px; cursor: text;
  border: 1px solid var(--inputBorderColor, #dde6e9); border-radius: 4px;
  background: var(--inputBackgroundColor, #333);
  box-shadow: inset 0 1px 1px var(--inputBoxShadowColor, rgba(0, 0, 0, 0.075));
}
#${POPOVER_ID} .quick-tags-box:focus-within {
  border-color: var(--inputFocusBorderColor, #66afe9);
  box-shadow: inset 0 1px 1px var(--inputBoxShadowColor, rgba(0, 0, 0, 0.075)),
    0 0 8px var(--inputFocusBoxShadowColor, rgba(102, 175, 233, 0.6));
}
#${POPOVER_ID} .quick-tags-chip {
  display: inline-flex; align-items: center; gap: 5px; max-width: 100%;
  margin: 0; padding: 3px 5px 3px 7px; border: 1px solid var(--infoColor, #5d9cec); border-radius: 2px;
  background: var(--infoColor, #5d9cec); color: var(--infoTextColor, #fff);
  font: inherit; font-size: 13px; line-height: 1; cursor: pointer;
}
#${POPOVER_ID} .quick-tags-chip span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${POPOVER_ID} .quick-tags-chip .quick-tags-x { font-size: 15px; opacity: 0.75; }
#${POPOVER_ID} .quick-tags-chip:hover .quick-tags-x,
#${POPOVER_ID} .quick-tags-chip:focus-visible .quick-tags-x { opacity: 1; }
#${POPOVER_ID} .quick-tags-chip.quick-tags-pending { opacity: 0.55; cursor: progress; }
#${POPOVER_ID} .quick-tags-input {
  flex: 1 1 80px; min-width: 80px; height: 29px; margin: 0; padding: 0 3px;
  border: 0; outline: 0; background: transparent; color: var(--textColor, #ccc); font: inherit;
}
#${POPOVER_ID} .quick-tags-list {
  margin: 2px 0 0; padding: 0; list-style: none; max-height: 200px; overflow-y: auto;
  border: 1px solid var(--inputBorderColor, #dde6e9); border-radius: 4px;
  background: var(--inputBackgroundColor, #333);
}
#${POPOVER_ID} .quick-tags-list:empty { display: none; }
#${POPOVER_ID} .quick-tags-list li { padding: 5px 12px; cursor: pointer; }
#${POPOVER_ID} .quick-tags-list li.quick-tags-highlighted {
  background: var(--menuItemHoverBackgroundColor, rgba(127, 127, 127, 0.25));
}
#${POPOVER_ID} .quick-tags-status { min-height: 1.4em; margin-top: 6px; font-size: 12px; color: var(--helpTextColor, #909293); }
#${POPOVER_ID} .quick-tags-status.quick-tags-error { color: var(--dangerColor, #f05050); }
`;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // --- Small DOM helpers ---

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function icon(className, viewBox, d) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  // --- The button ---

  function createButton(links) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute(MARK, '');
    button.title = 'Add tags';
    button.setAttribute('aria-label', 'Add tags');
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    // A tag with a hole, then a plus sign.
    button.appendChild(icon('quick-tags-icon-tag', '0 0 16 16',
      'M2 1.5h5.3c.3 0 .5.1.7.3l6.5 6.5c.4.4.4 1 0 1.4l-5.3 5.3c-.4.4-1 .4-1.4 0L1.3 8.5c-.2-.2-.3-.4-.3-.7V2.5c0-.6.4-1 1-1z' +
      'M4.5 3.2a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z'));
    button.appendChild(icon('quick-tags-icon-plus', '0 0 10 10', 'M4 1h2v3h3v2H6v3H4V6H1V4h3z'));
    copyLabelClasses(button, links);
    button.addEventListener('click', function () {
      if (open && open.button === button) closePopover(true);
      else openPopover(button);
    });
    return button;
  }

  // Take the Links label's classes so the button is exactly the same size.
  function copyLabelClasses(button, links) {
    const classes = links && links.label ? Array.from(links.label.classList) : [];
    button.className = classes.concat('quick-tags-button').join(' ');
  }

  function apply() {
    if (!sonarr()) return;
    const links = currentSlug() ? findLinks() : null;
    let button = document.querySelector('button[' + MARK + ']');

    if (open && (!open.button.isConnected || open.slug !== currentSlug())) closePopover(false);
    if (!links) {
      if (button) button.remove();
      return;
    }

    injectStyle();
    if (button && button.parentElement !== links.row) {
      button.remove();
      button = null;
    }
    if (!button) button = createButton(links);

    // Keep it right after Links (React may re-render around it).
    copyLabelClasses(button, links);
    if (links.child.nextElementSibling !== button) links.child.after(button);
  }

  function observe() {
    let timer = 0;
    const observer = new MutationObserver(function () {
      clearTimeout(timer);
      timer = setTimeout(apply, DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- The popover ---
  //
  // One at a time; `open` holds its state:
  //   button, root, box, input, list, status — DOM
  //   slug, series                — the series being edited (series.tags = tag ids)
  //   tagList                     — every tag in Sonarr, sorted by label
  //   creating                    — labels of new tags still being created
  //   suggestions, highlighted    — the dropdown, like Sonarr's autosuggest
  //   queue, pending              — saves run one after another

  let open = null;

  function openPopover(button) {
    closePopover(false);
    const state = {
      button: button,
      slug: currentSlug(),
      series: null,
      tagList: [],
      creating: [],
      suggestions: [],
      highlighted: null,
      queue: Promise.resolve(),
      pending: 0,
    };
    buildPopover(state);
    open = state;
    button.setAttribute('aria-expanded', 'true');
    position();
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    document.addEventListener('mousedown', onOutsideMouseDown, true);
    document.addEventListener('keydown', onEscape, true);

    setStatus(state, 'Loading…');
    Promise.all([loadSeries(state.slug), api('GET', '/tag')]).then(function (results) {
      state.series = results[0];
      state.tagList = results[1].sort(byLabel);
      state.input.disabled = false;
      if (open === state) state.input.focus();
      setStatus(state, '');
      render(state);
    }).catch(function (error) {
      setStatus(state, error.message, true);
      console.warn('[quick-tags]', error);
    });
  }

  function buildPopover(state) {
    const root = element('div');
    root.id = POPOVER_ID;
    root.setAttribute(MARK, '');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Tags');

    const box = element('div', 'quick-tags-box');
    const input = element('input', 'quick-tags-input');
    input.type = 'text';
    input.placeholder = 'Add a tag…';
    input.setAttribute('aria-label', 'Add a tag');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.disabled = true;
    box.appendChild(input);
    box.addEventListener('mousedown', function (event) {
      if (event.target === box) { event.preventDefault(); input.focus(); }
    });

    const list = element('ul', 'quick-tags-list');
    list.setAttribute('role', 'listbox');
    const status = element('div', 'quick-tags-status');
    status.setAttribute('aria-live', 'polite');

    root.append(box, list, status);
    document.body.appendChild(root);
    Object.assign(state, { root: root, box: box, input: input, list: list, status: status });

    input.addEventListener('input', function () { updateSuggestions(state); });
    input.addEventListener('keydown', function (event) { onInputKeyDown(state, event); });
  }

  // Close; `commit` adds whatever is still typed in the box, the way
  // Sonarr's tag box does when it loses focus. Escape throws it away.
  function closePopover(commit) {
    if (!open) return;
    const state = open;
    if (commit && state.series && state.input.value.trim()) addTag(state, pickTag(state));
    open = null;
    state.root.remove();
    state.button.setAttribute('aria-expanded', 'false');
    window.removeEventListener('scroll', position, true);
    window.removeEventListener('resize', position);
    document.removeEventListener('mousedown', onOutsideMouseDown, true);
    document.removeEventListener('keydown', onEscape, true);
  }

  // Captured on the document so it works while the box is still loading,
  // and so Sonarr's own Escape handling (closing modals) doesn't also fire.
  function onEscape(event) {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    const button = open.button;
    closePopover(false);
    button.focus();
  }

  function onOutsideMouseDown(event) {
    if (!open) return;
    if (open.root.contains(event.target) || open.button.contains(event.target)) return;
    closePopover(true);
  }

  // Just below the button, arrow pointing at it, kept inside the window.
  // Fixed positioning, because Sonarr scrolls an inner container, not the page.
  function position() {
    if (!open) return;
    if (!open.button.isConnected) { closePopover(false); return; }
    const rect = open.button.getBoundingClientRect();
    const width = open.root.offsetWidth;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    open.root.style.top = (rect.bottom + 10) + 'px';
    open.root.style.left = left + 'px';
    const arrow = Math.max(14, Math.min(rect.left + rect.width / 2 - left, width - 14));
    open.root.style.setProperty('--quick-tags-arrow', arrow + 'px');
  }

  function setStatus(state, text, isError) {
    state.status.textContent = text;
    state.status.classList.toggle('quick-tags-error', !!isError);
  }

  function tagById(state, id) {
    return state.tagList.find(function (t) { return t.id === id; });
  }

  function render(state) {
    renderChips(state);
    renderSuggestions(state);
    position();
  }

  function renderChips(state) {
    for (const chip of state.box.querySelectorAll('.quick-tags-chip')) chip.remove();
    // Alphabetical, so a chip doesn't jump when its save comes back.
    const tags = state.series.tags.map(function (id) { return tagById(state, id); })
      .filter(Boolean).sort(byLabel);
    for (const tag of tags) {
      const chip = element('button', 'quick-tags-chip');
      chip.type = 'button';
      chip.title = 'Remove ' + tag.label;
      chip.append(element('span', '', tag.label), element('span', 'quick-tags-x', '×'));
      chip.addEventListener('click', function () { removeTag(state, tag.id); state.input.focus(); });
      state.box.insertBefore(chip, state.input);
    }
    for (const label of state.creating) {
      const chip = element('span', 'quick-tags-chip quick-tags-pending');
      chip.title = 'Creating ' + label + '…';
      chip.appendChild(element('span', '', label));
      state.box.insertBefore(chip, state.input);
    }
  }

  // Same rule as Sonarr: tags whose name contains what's typed, from one
  // character on, minus the ones the series already has.
  function updateSuggestions(state) {
    const value = state.input.value.trim().toLowerCase();
    state.suggestions = !state.series || !value ? [] : state.tagList.filter(function (tag) {
      return tag.label.toLowerCase().includes(value) && !state.series.tags.includes(tag.id);
    });
    state.highlighted = null;
    if (state.status.classList.contains('quick-tags-error')) setStatus(state, '');
    renderSuggestions(state);
  }

  function renderSuggestions(state) {
    state.list.textContent = '';
    state.suggestions.forEach(function (tag, index) {
      const item = element('li', index === state.highlighted ? 'quick-tags-highlighted' : '', tag.label);
      item.setAttribute('role', 'option');
      // mousedown, not click: the input must keep focus.
      item.addEventListener('mousedown', function (event) {
        event.preventDefault();
        addTag(state, tag);
      });
      state.list.appendChild(item);
    });
  }

  // What Enter (or Tab, space, comma) would add: the highlighted suggestion,
  // else an existing tag with exactly this name, else a new tag.
  function pickTag(state) {
    if (state.highlighted !== null) return state.suggestions[state.highlighted];
    const value = state.input.value.trim().toLowerCase();
    if (!value) return null;
    return state.tagList.find(function (t) { return t.label.toLowerCase() === value; }) || { label: value };
  }

  function onInputKeyDown(state, event) {
    if (!state.series) return;
    const key = event.key;

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const count = state.suggestions.length;
      if (!count) return;
      event.preventDefault();
      const h = state.highlighted;
      if (key === 'ArrowDown') state.highlighted = h === null ? 0 : Math.min(h + 1, count - 1);
      else state.highlighted = h === null || h === 0 ? null : h - 1;
      renderSuggestions(state);
      const item = state.list.children[state.highlighted];
      if (item) item.scrollIntoView({ block: 'nearest' });
      return;
    }

    if (key === 'Backspace' && !state.input.value) {
      const last = state.series.tags.map(function (id) { return tagById(state, id); })
        .filter(Boolean).sort(byLabel).pop();
      if (last) removeTag(state, last.id);
      event.preventDefault();
      return;
    }

    if (DELIMITERS.includes(key)) {
      const tag = pickTag(state);
      if (tag) {
        event.preventDefault();
        addTag(state, tag);
      }
    }
  }

  // --- Saving ---
  //
  // The chip changes at once; the save runs in the background, one at a
  // time. If Sonarr refuses, the chip goes back and the reason is shown.

  function addTag(state, tag) {
    if (!tag) return;
    if (!tag.id && !TAG_LABEL_RE.test(tag.label)) {
      setStatus(state, TAG_RULE_MESSAGE, true);
      return;
    }
    state.input.value = '';
    state.suggestions = [];
    state.highlighted = null;

    if (tag.id) {
      if (state.series.tags.includes(tag.id)) { render(state); return; }
      state.series.tags.push(tag.id);
      render(state);
      save(state, 'add', tag.id, function () {
        state.series.tags = state.series.tags.filter(function (id) { return id !== tag.id; });
      });
      return;
    }

    if (state.creating.includes(tag.label)) { render(state); return; }
    state.creating.push(tag.label);
    render(state);
    state.pending++;
    setStatus(state, 'Saving…');
    state.queue = state.queue.then(function () {
      return api('POST', '/tag', { label: tag.label });
    }).then(function (created) {
      state.tagList.push(created);
      state.tagList.sort(byLabel);
      state.creating = state.creating.filter(function (l) { return l !== tag.label; });
      if (!state.series.tags.includes(created.id)) state.series.tags.push(created.id);
      render(state);
      return putTags(state, 'add', created.id).catch(function (error) {
        state.series.tags = state.series.tags.filter(function (id) { return id !== created.id; });
        throw error;
      });
    }).then(function () {
      saved(state);
    }, function (error) {
      state.creating = state.creating.filter(function (l) { return l !== tag.label; });
      failed(state, error);
    });
  }

  function removeTag(state, id) {
    if (!state.series.tags.includes(id)) return;
    state.series.tags = state.series.tags.filter(function (t) { return t !== id; });
    render(state);
    save(state, 'remove', id, function () { state.series.tags.push(id); });
  }

  function save(state, applyTags, id, undo) {
    state.pending++;
    setStatus(state, 'Saving…');
    state.queue = state.queue.then(function () {
      return putTags(state, applyTags, id);
    }).then(function () {
      saved(state);
    }, function (error) {
      undo();
      failed(state, error);
    });
  }

  // The Mass Editor endpoint: changes only this series' tags.
  function putTags(state, applyTags, id) {
    return api('PUT', '/series/editor', {
      seriesIds: [state.series.id],
      tags: [id],
      applyTags: applyTags,
      moveFiles: false,
    });
  }

  function saved(state) {
    state.pending--;
    if (!state.pending && !state.status.classList.contains('quick-tags-error')) setStatus(state, 'Saved');
  }

  function failed(state, error) {
    state.pending--;
    render(state);
    setStatus(state, 'Not saved: ' + error.message, true);
    console.warn('[quick-tags]', error);
  }

  apply();
  observe();
})();
