// Interface plumbing that is not about Mars: the loading screen, menus, the resizable workspace,
// dialogs, information pop-ups, search, and the guided tour. Commands leave here as 'cmd' events.
import { S, $, esc, emit, clamp } from './state.js';

const overlays = () => $('#overlays');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- loading screen ----------

const steps = [];
export function loadStep(id, label) {
  steps.push({ id, label, state: 'wait' });
  paintLoad();
}
export function loadMark(id, state) {
  const s = steps.find((x) => x.id === id);
  if (s) s.state = state;
  paintLoad();
}
function paintLoad() {
  const el = $('#load-steps');
  if (!el) return;
  el.innerHTML = steps.map((s) => `<li class="${s.state === 'ok' ? 'ok' : s.state === 'on' ? 'on' : ''}">${esc(s.label)}</li>`).join('');
  const done = steps.filter((s) => s.state === 'ok').length;
  $('#load-fill').style.width = `${Math.max(4, (done / Math.max(steps.length, 1)) * 100)}%`;
}
export function loadFinish() {
  const el = $('#loading');
  if (!el) return;
  el.classList.add('done');
  setTimeout(() => el.remove(), 450);
}

// ---------- settings and workspace state ----------

const WS_KEY = 'tenacity.ws';
const SET_KEY = 'tenacity.set';
export const PANELS = [['activity', 'Activity list'], ['locator', 'Where on Mars'], ['sim', 'Simulation'], ['rules', 'Flight rules'], ['probe', 'Probe'],
  ['bottom', 'Sequence dock'], ['console', 'Console'], ['legend', 'Map legend'], ['crumb', 'Map location bar']];
const WS_DEFAULT = { left: 300, right: 350, bottom: 250, hidden: [], collapsed: [], swap: false };
const SET_DEFAULT = { scale: 'normal', smoothZoom: true, explain: true, autoTour: true, tourSeen: false, crewPulse: true };
const read = (key, def) => { try { return { ...def, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { ...def }; } };
const write = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage may be blocked */ } };

export function saveSettings() { write(SET_KEY, S.set); applySettings(); }
function applySettings() {
  document.documentElement.dataset.scale = S.set.scale;
}

export function initWorkspace() {
  S.ws = read(WS_KEY, WS_DEFAULT);
  S.set = read(SET_KEY, SET_DEFAULT);
  if (window.innerWidth <= 1280 && !localStorage.getItem(WS_KEY)) { S.ws.left = 260; S.ws.right = 310; }
  applySettings();
  applyWorkspace();

  // Drag a gutter to resize the dock beside it.
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const sp = e.target.closest('.split');
    if (!sp) return;
    e.preventDefault();
    drag = { which: sp.dataset.split, x: e.clientX, y: e.clientY, start: { ...S.ws }, el: sp };
    sp.classList.add('drag');
    sp.setPointerCapture(e.pointerId);
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) * (S.ws.swap ? -1 : 1);
    if (drag.which === 'left') S.ws.left = clamp(drag.start.left + dx, 200, 560);
    if (drag.which === 'right') S.ws.right = clamp(drag.start.right - dx, 240, 640);
    if (drag.which === 'bottom') S.ws.bottom = clamp(drag.start.bottom - (e.clientY - drag.y), 110, Math.max(160, window.innerHeight - 320));
    applyWorkspace(false);
  });
  document.addEventListener('pointerup', () => {
    if (!drag) return;
    drag.el.classList.remove('drag');
    drag = null;
    write(WS_KEY, S.ws);
    emit('resized');
  });
}

export function applyWorkspace(notify = true) {
  const root = document.documentElement.style;
  root.setProperty('--left-w', `${S.ws.left}px`);
  root.setProperty('--right-w', `${S.ws.right}px`);
  root.setProperty('--bot-h', `${S.ws.bottom}px`);
  $('#app').classList.toggle('swap', !!S.ws.swap);
  for (const [id] of PANELS) {
    const hidden = S.ws.hidden.includes(id);
    const el = id === 'legend' ? $('#legend') : id === 'crumb' ? $('#crumb') : document.querySelector(`[data-panel="${id}"]`);
    if (el) el.hidden = hidden;
    if (el && el.classList.contains('panel')) el.classList.toggle('collapsed', S.ws.collapsed.includes(id));
  }
  $('#bot').classList.toggle('nocon', S.ws.hidden.includes('console'));
  // A dock with nothing shown gives its space, and its gutter, to the map.
  for (const [dock, split] of [['#dock-l', 'left'], ['#dock-r', 'right']]) {
    const empty = [...$(dock).querySelectorAll('.panel')].every((p) => p.hidden);
    $(dock).hidden = empty;
    document.querySelector(`.split[data-split="${split}"]`).hidden = empty;
  }
  document.querySelector('.split[data-split="bottom"]').hidden = S.ws.hidden.includes('bottom');
  if (notify) { write(WS_KEY, S.ws); emit('resized'); }
}

export function togglePanel(id, show) {
  const hidden = new Set(S.ws.hidden);
  const want = show ?? hidden.has(id);
  if (want) hidden.delete(id); else hidden.add(id);
  S.ws.hidden = [...hidden];
  if (want) S.ws.collapsed = S.ws.collapsed.filter((x) => x !== id);
  applyWorkspace();
}
export function collapsePanel(id) {
  S.ws.collapsed = S.ws.collapsed.includes(id) ? S.ws.collapsed.filter((x) => x !== id) : [...S.ws.collapsed, id];
  applyWorkspace();
}
export function workspacePreset(name) {
  const base = { ...WS_DEFAULT, swap: S.ws.swap };
  if (name === 'map') base.hidden = ['activity', 'locator', 'sim', 'rules', 'probe', 'bottom'];
  if (name === 'analysis') { base.bottom = Math.round(Math.min(420, window.innerHeight * 0.42)); base.right = 400; base.hidden = ['locator']; }
  if (name === 'follow') { base.hidden = ['locator', 'probe', 'console']; base.bottom = 180; }
  S.ws = base;
  applyWorkspace();
}

// ---------- menus ----------

let openMenuEl = null;
export function closeMenu() {
  if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
  document.querySelectorAll('#menus > button[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
// items: [{ label, cmd, data, kbd, checked, disabled } | 'sep']
export function openMenu(anchor, items) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  el.innerHTML = items.map((it, i) => (it === 'sep' ? '<hr>'
    : `<button role="menuitem" data-i="${i}" ${it.disabled ? 'disabled' : ''}><span class="chk">${it.checked ? '✓' : ''}</span><span>${esc(it.label)}</span>${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</button>`)).join('');
  overlays().appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = `${Math.min(r.left, window.innerWidth - el.offsetWidth - 8)}px`;
  el.style.top = `${Math.min(r.bottom + 2, window.innerHeight - el.offsetHeight - 8)}px`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const it = items[Number(b.dataset.i)];
    closeMenu();
    emit('cmd', { name: it.cmd, data: it.data });
  });
  anchor.setAttribute('aria-expanded', 'true');
  openMenuEl = el;
}

// ---------- dialogs ----------

// buttons: [{ label, cmd, data, primary, keep }]. Returns the dialog element; closeDialog() removes it.
export function closeDialog() { document.querySelectorAll('.scrim').forEach((s) => s.remove()); }
export function dialog({ title, body, buttons = [{ label: 'Close' }], wide = false, onMount }) {
  closeDialog();
  closeMenu();
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `<div class="dialog${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header><h2>${esc(title)}</h2><button class="ib" data-close aria-label="Close">×</button></header>
    <div class="body">${body}</div>
    <footer>${buttons.map((b, i) => `<button class="btn${b.primary ? ' primary' : ''}" data-b="${i}">${esc(b.label)}</button>`).join('')}</footer></div>`;
  overlays().appendChild(scrim);
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim || e.target.closest('[data-close]')) return closeDialog();
    const btn = e.target.closest('[data-b]');
    if (!btn) return;
    const b = buttons[Number(btn.dataset.b)];
    const el = scrim.querySelector('.dialog');
    if (!b.keep) closeDialog();
    if (b.cmd) emit('cmd', { name: b.cmd, data: b.data, el });
  });
  const el = scrim.querySelector('.dialog');
  if (onMount) onMount(el);
  const first = el.querySelector('input, select, textarea, .body button') || el.querySelector('footer .primary') || el.querySelector('footer button');
  if (first) first.focus();
  return el;
}

// ---------- information pop-ups ----------

let pop = null;
let popFor = null;
export function closePop() {
  if (pop) pop.remove();
  if (popFor) popFor.setAttribute('aria-expanded', 'false');
  pop = popFor = null;
}
// entry: { title, body: [paragraphs], links: [[label, url]] }
export function showInfo(anchor, entry) {
  if (popFor === anchor) return closePop();
  closePop();
  if (!entry) return;
  pop = document.createElement('div');
  pop.className = 'pop';
  pop.setAttribute('role', 'dialog');
  pop.innerHTML = `<h4>${esc(entry.title)}</h4>${entry.body.map((p) => `<p>${p}</p>`).join('')}
    ${entry.links && entry.links.length ? `<div class="links">${entry.links.map(([label, url]) => `<a class="golink" href="${url}" target="_blank" rel="noopener">${esc(label)} ↗</a>`).join('')}</div>` : ''}`;
  overlays().appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = r.left + r.width / 2 - w / 2;
  left = clamp(left, 8, window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  popFor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
}

// ---------- search ----------

// getItems(query) -> [{ group, label, sub, run }]
export function openSearch(getItems) {
  closeDialog();
  closeMenu();
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `<div class="palette" role="dialog" aria-label="Search"><input type="search" placeholder="Search places, samples, layers, rules, commands, or type lat, lon" aria-label="Search" autocomplete="off" spellcheck="false">
    <div class="res" role="listbox"></div><div class="hint">↑ ↓ to move · Enter to go · Esc to close</div></div>`;
  overlays().appendChild(scrim);
  const input = scrim.querySelector('input');
  const res = scrim.querySelector('.res');
  let items = [];
  let at = 0;
  const paint = () => {
    let last = null;
    res.innerHTML = items.map((it, i) => {
      const head = it.group !== last ? `<div class="grp">${esc(it.group)}</div>` : '';
      last = it.group;
      return `${head}<button role="option" data-i="${i}" class="${i === at ? 'on' : ''}"><span>${esc(it.label)}</span><small>${esc(it.sub || '')}</small></button>`;
    }).join('') || '<div class="hint">Nothing found. Try a place name, a sample, a rule number, or coordinates such as -4.80, 137.38.</div>';
    const on = res.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };
  const update = () => { items = getItems(input.value.trim()); at = 0; paint(); };
  const go = (i) => { const it = items[i]; if (!it) return; closeDialog(); it.run(); };
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); at = Math.min(items.length - 1, at + 1); paint(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); at = Math.max(0, at - 1); paint(); }
    if (e.key === 'Enter') { e.preventDefault(); go(at); }
  });
  res.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) go(Number(b.dataset.i)); });
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeDialog(); });
  update();
  input.focus();
}

// ---------- guided tour ----------

// A step: { sel, title, text, try, before }. The target gets a blinking box and the rest is dimmed;
// the words sit in one fixed panel, away from the target.
let tour = null;
export const tourRunning = () => !!tour;
export function endTour(finished = false) {
  if (!tour) return;
  clearInterval(tour.timer);
  tour.els.forEach((e) => e.remove());
  window.removeEventListener('keydown', tour.key, true);
  const done = tour.onEnd;
  tour = null;
  if (done) done(finished);
}
export function startTour(stepList, onEnd) {
  endTour();
  closeDialog(); closeMenu(); closePop();
  const shades = [0, 1, 2, 3].map(() => { const d = document.createElement('div'); d.className = 'tour-shade'; return d; });
  const box = document.createElement('div');
  box.className = 'tour-box';
  const panel = document.createElement('div');
  panel.className = 'tour-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-live', 'polite');
  [...shades, box, panel].forEach((e) => overlays().appendChild(e));
  tour = { i: -1, steps: stepList, els: [...shades, box, panel], onEnd, timer: 0 };

  const place = () => {
    if (!tour) return;
    const step = tour.steps[tour.i];
    const target = step.sel ? document.querySelector(step.sel) : null;
    const W = window.innerWidth;
    const H = window.innerHeight;
    let r = target && target.offsetParent !== null ? target.getBoundingClientRect() : null;
    // A target inside a scrolling panel is boxed only where it shows.
    const clip = r && target.closest('.bd, #tabbody');
    if (clip) {
      const c = clip.getBoundingClientRect();
      r = { left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) };
      r.width = r.right - r.left;
      r.height = r.bottom - r.top;
    }
    if (r && (r.width < 2 || r.height < 2)) r = null;
    if (!r) {
      box.style.display = 'none';
      shades[0].style.cssText = 'left:0;top:0;width:100vw;height:100vh';
      shades.slice(1).forEach((s) => { s.style.cssText = 'display:none'; });
      panel.style.top = '';
      panel.style.bottom = '12vh';
      return;
    }
    const pad = 5;
    const x0 = clamp(r.left - pad, 2, W - 6);
    const y0 = clamp(r.top - pad, 2, H - 6);
    const x1 = clamp(r.right + pad, x0 + 4, W - 2);
    const y1 = clamp(r.bottom + pad, y0 + 4, H - 2);
    box.style.cssText = `left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px`;
    shades[0].style.cssText = `left:0;top:0;width:100vw;height:${y0}px`;
    shades[1].style.cssText = `left:0;top:${y1}px;width:100vw;height:${H - y1}px`;
    shades[2].style.cssText = `left:0;top:${y0}px;width:${x0}px;height:${y1 - y0}px`;
    shades[3].style.cssText = `left:${x1}px;top:${y0}px;width:${W - x1}px;height:${y1 - y0}px`;
    // The words go where the target is not.
    const ph = panel.offsetHeight;
    if (H - y1 > ph + 24) { panel.style.top = `${Math.min(y1 + 14, H - ph - 10)}px`; panel.style.bottom = ''; }
    else if (y0 > ph + 24) { panel.style.top = `${Math.max(10, y0 - ph - 14)}px`; panel.style.bottom = ''; }
    else { panel.style.top = ''; panel.style.bottom = '10px'; }
  };

  const show = (i) => {
    if (!tour) return;
    if (i >= tour.steps.length) return endTour(true);
    tour.i = clamp(i, 0, tour.steps.length - 1);
    const step = tour.steps[tour.i];
    if (step.before) step.before();
    panel.innerHTML = `<div class="n">Tour · step ${tour.i + 1} of ${tour.steps.length}</div><h3>${esc(step.title)}</h3><p>${step.text}</p>
      ${step.try ? `<div class="try"><b>Try it:</b> ${step.try}</div>` : ''}
      <footer><div class="dots">${tour.steps.map((_, k) => `<i class="${k <= tour.i ? 'on' : ''}"></i>`).join('')}</div>
        <button class="btn" data-t="skip">End tour</button>
        <button class="btn" data-t="back" ${tour.i === 0 ? 'disabled' : ''}>Back</button>
        <button class="btn primary" data-t="next">${tour.i === tour.steps.length - 1 ? 'Finish' : 'Next'}</button></footer>`;
    const target = step.sel ? document.querySelector(step.sel) : null;
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    setTimeout(place, 30);
    setTimeout(place, 320);
    panel.querySelector('[data-t="next"]').focus();
  };
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    if (b.dataset.t === 'skip') endTour(false);
    if (b.dataset.t === 'back') show(tour.i - 1);
    if (b.dataset.t === 'next') show(tour.i + 1);
  });
  tour.key = (e) => {
    if (!tour) return;
    if (e.key === 'Escape') { e.preventDefault(); endTour(false); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(tour.i + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(tour.i - 1); }
  };
  window.addEventListener('keydown', tour.key, true);
  tour.timer = setInterval(place, 350);     // panels re-render under the tour; keep the box on its target
  show(0);
}

// Draw the eye to a control for a moment, outside the tour.
export function hint(sel) {
  const el = document.querySelector(sel);
  if (!el) return;
  el.classList.remove('hint-ring');
  void el.offsetWidth;
  el.classList.add('hint-ring');
  setTimeout(() => el.classList.remove('hint-ring'), 4200);
}

// Wire the things that live for the whole session.
export function initUI(infoOf) {
  document.addEventListener('click', (e) => {
    const info = e.target.closest('[data-info]');
    if (info) { e.stopPropagation(); return showInfo(info, infoOf(info.dataset.info)); }
    if (pop && !e.target.closest('.pop')) closePop();
    if (openMenuEl && !e.target.closest('.menu') && !e.target.closest('#menus')) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePop(); closeMenu(); if (!tour) closeDialog(); }
  });
  window.addEventListener('resize', () => { closePop(); closeMenu(); });
}
