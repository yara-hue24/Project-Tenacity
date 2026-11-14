// Workstation features around the planner: menus and toolbar, undo and history, saved plans,
// the crew's map notes, search, settings, the guided tour, the "where on Mars" locator, and the
// path visualisation. The planner itself (plan, simulate, validate) stays in app.js.
import { S, C, $, esc, on, emit, log, fmtM, fmtLat, fmtLon, clamp, distM, clockH, parseClock } from './state.js';
import * as UI from './ui.js';
import * as MV from './mapview.js';
import * as P from './plan.js';
import * as DB from './store.js';

let app = null;             // functions handed over by app.js
const clone = (o) => JSON.parse(JSON.stringify(o));
const now = () => new Date().toISOString();
const hhmm = (iso) => iso.slice(11, 19);

// ---------- menus and toolbar ----------

const ICON = {
  undo: '<svg viewBox="0 0 16 16"><path d="M5 3 2 6l3 3M2 6h7a4 4 0 0 1 0 8H6"/></svg>',
  redo: '<svg viewBox="0 0 16 16"><path d="m11 3 3 3-3 3M14 6H7a4 4 0 0 0 0 8h3"/></svg>',
  search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/></svg>',
  play: '<svg viewBox="0 0 16 16"><path d="M2 13 6 6l3 4 2-3 3 6zM11 3.5a1 1 0 1 0 0 .01"/></svg>',
  gear: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>',
  tour: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.3"/><path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.6.3-.8.7-.8 1.3M8 11.6v.2"/></svg>',
  save: '<svg viewBox="0 0 16 16"><path d="M3 2h8l2 2v10H3zM5 2v4h5V2M5 14V9h6v5"/></svg>',
};
const MENUS = ['File', 'Edit', 'View', 'Windows', 'Help'];

function buildChrome() {
  $('#menus').innerHTML = MENUS.map((m) => `<button data-menu="${m}" aria-haspopup="menu" aria-expanded="false">${m}</button>`).join('');
  $('#menus').addEventListener('click', (e) => {
    const b = e.target.closest('[data-menu]');
    if (!b) return;
    if (b.getAttribute('aria-expanded') === 'true') return UI.closeMenu();
    UI.openMenu(b, menuItems(b.dataset.menu));
  });
  $('#menus').addEventListener('mouseover', (e) => {
    const b = e.target.closest('[data-menu]');
    if (b && document.querySelector('#menus [aria-expanded="true"]') && b.getAttribute('aria-expanded') !== 'true') UI.openMenu(b, menuItems(b.dataset.menu));
  });
  $('#toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (b && !b.disabled) emit('cmd', { name: b.dataset.cmd });
  });
  paintToolbar();
}

export function paintToolbar() {
  const tb = (cmd, icon, label, tip, extra = '') => `<button class="tb${extra.includes('wide') ? ' wide' : ''}" data-cmd="${cmd}" title="${tip}" aria-label="${tip}" ${extra.includes('off') ? 'disabled' : ''} data-tour="tb-${cmd}">${ICON[icon]}${label ? `<span class="lab">${label}</span>` : ''}</button>`;
  $('#toolbar').innerHTML = tb('undo', 'undo', '', 'Undo (Ctrl+Z)', hi > 0 ? '' : 'off') + tb('redo', 'redo', '', 'Redo (Ctrl+Y)', hi < hist.length - 1 ? '' : 'off')
    + tb('save', 'save', '', 'Save plan as…') + '<span class="tb-sep"></span>'
    + tb('viz', 'play', 'Visualize path', 'Fly along the route over the 3D terrain', 'wide')
    + `<button class="tb wide" data-cmd="search" title="Search (Ctrl+K)" data-tour="tb-search">${ICON.search}<span class="lab">Search</span><kbd>Ctrl K</kbd></button>`
    + tb('settings', 'gear', 'Settings', 'Settings', 'wide') + tb('tour', 'tour', 'Tour', 'Guided tour of the tool', 'wide');
}

function menuItems(name) {
  const hidden = (id) => S.ws.hidden.includes(id);
  if (name === 'File') return [
    { label: 'Open plan…', cmd: 'open' }, { label: 'Save plan as…', cmd: 'save' }, 'sep',
    { label: 'Export plan and notes (JSON)', cmd: 'export' }, { label: 'Import…', cmd: 'import' }, 'sep',
    { label: 'Cuff card (print)…', cmd: 'cuff' },
  ];
  if (name === 'Edit') return [
    { label: 'Undo', cmd: 'undo', kbd: 'Ctrl+Z', disabled: hi <= 0 }, { label: 'Redo', cmd: 'redo', kbd: 'Ctrl+Y', disabled: hi >= hist.length - 1 }, 'sep',
    { label: 'Add note at probe point', cmd: 'note', disabled: !S.probe }, { label: 'Add keep-out at probe point', cmd: 'koz', disabled: !S.probe || S.mode === 'lock' }, 'sep',
    { label: 'Reset plan and INCONS', cmd: 'reset', disabled: S.mode === 'lock' },
  ];
  if (name === 'View') return [
    { label: 'Visualize path (3D flyover)', cmd: 'viz' }, { label: 'Show the whole walk', cmd: 'fit' }, { label: 'Go to the crew', cmd: 'gocrew' }, 'sep',
    ...MV.PRESETS.map((p) => ({ label: `Layers: ${p.title}`, cmd: 'preset', data: p.id, checked: S.preset === p.id && !S.custom, disabled: !!p.needs && !(p.needs === 'grid' ? S.grid : S.home) })), 'sep',
    { label: 'Explain routes in colour', cmd: 'explain', checked: S.set.explain }, { label: 'Search…', cmd: 'search', kbd: 'Ctrl+K' },
  ];
  if (name === 'Windows') return [
    ...UI.PANELS.map(([id, label]) => ({ label, cmd: 'panel', data: id, checked: !hidden(id) })), 'sep',
    { label: 'Workspace: Planning (default)', cmd: 'workspace', data: 'planning' }, { label: 'Workspace: Map focus', cmd: 'workspace', data: 'map' },
    { label: 'Workspace: Analysis', cmd: 'workspace', data: 'analysis' }, { label: 'Workspace: Following the walk', cmd: 'workspace', data: 'follow' }, 'sep',
    { label: 'Swap left and right docks', cmd: 'swap', checked: !!S.ws.swap }, { label: 'Reset layout', cmd: 'workspace', data: 'planning' },
  ];
  return [
    { label: 'Guided tour', cmd: 'tour' }, { label: 'Keyboard shortcuts', cmd: 'keys' }, { label: 'Where the data comes from', cmd: 'sources' }, 'sep',
    { label: 'About Tenacity', cmd: 'about' },
  ];
}

// ---------- undo and history ----------

let hist = [];      // snapshots of this session, oldest first
let hi = -1;        // where we are in it
S.history = [];     // everything stored, newest first, for the History tab

const snapshot = (label) => ({ t: now(), label, plan: clone(S.plan), params: clone(S.params), trip: S.trip,
  verdict: S.sim ? `${S.sim.verdict.go ? 'GO' : 'NO-GO'}${Number.isFinite(S.sim.verdict.marginMin) ? ` ${S.sim.verdict.marginMin >= 0 ? '+' : '−'}${Math.abs(Math.round(S.sim.verdict.marginMin))} min` : ''}` : '' });

// Called after every change to the plan.
export function commit(label) {
  const snap = snapshot(label);
  hist = hist.slice(0, hi + 1);
  hist.push(snap);
  if (hist.length > 80) hist.shift();
  hi = hist.length - 1;
  S.history.unshift(snap);
  if (S.history.length > 200) S.history.pop();
  DB.put('history', snap).then((id) => { snap.id = id; DB.trimHistory(); });
  paintToolbar();
  if (S.tab === 'history') app.renderTab();
}
const lockedOut = (what) => { if (!app.locked()) return false; log('A', `Locked: switch to Edit to ${what}`); return true; };
function applySnap(s, why) {
  const plan = P.clean(clone(s.plan));
  if (!plan) return log('C', 'That version could not be restored: it is not a valid plan');
  S.plan = plan;
  S.params = app.cleanParams({ ...S.params, ...s.params });
  S.trip = s.trip;
  S.sel = null;
  log('status', why);
  app.planChanged();
  paintToolbar();
}
function undo() { if (lockedOut('undo')) return; if (hi > 0) { hi--; applySnap(hist[hi], `Undo: back to "${hist[hi].label}"`); } }
function redo() { if (lockedOut('redo')) return; if (hi < hist.length - 1) { hi++; applySnap(hist[hi], `Redo: "${hist[hi].label}"`); } }

function historyHTML() {
  if (!S.history.length) return '<div class="note">No changes yet. Every change to the plan is kept here and can be restored.</div>';
  return `<div class="pad"><span class="dim">${S.history.length} versions kept ${DB.persistent() ? 'in this browser\'s database' : 'for this session only (the browser refused a database)'}. Newest first.</span>
    <span class="grow"></span><button class="btn sm" data-act="clearhistory">Clear history</button></div>
    <div class="list">${S.history.map((h, i) => `<div class="item"><span class="k">${h.t.slice(0, 10)} ${hhmm(h.t)} UTC</span>
      <span><b>${esc(h.label)}</b><small>${esc(h.plan.name || '')} · ${h.plan.stations.length} stations · ${esc(h.verdict || '')}</small></span>
      <span class="acts"><button class="btn sm" data-act="restore" data-i="${i}">Restore</button></span></div>`).join('')}</div>`;
}

// ---------- saved plans ----------

S.saved = [];
async function savePlan(name) {
  const id = `p${Date.now()}`;
  const rec = { id, name, saved_utc: now(), plan: { ...clone(S.plan), name }, params: clone(S.params) };
  await DB.put('plans', rec);
  S.saved.unshift(rec);
  S.plan.name = name;
  S.trip = `saved:${id}`;
  log(DB.persistent() ? 'status' : 'C', DB.persistent() ? `Plan saved as "${name}" in this browser` : `Plan "${name}" is kept for this session only: this browser refused a database. Use File ▸ Export to keep it.`);
  app.save();
  app.render();
}
function saveDialog() {
  UI.dialog({ title: 'Save plan as', body: `<label>Name<br><input type="text" class="full" id="dlg-name" value="${esc(S.plan.name || 'My walk')}" maxlength="60"></label>
    <p class="dim">The plan, its stations, keep-out zones and INCONS are saved in this browser. Use File ▸ Export to move them to another computer.</p>`,
  buttons: [{ label: 'Cancel' }, { label: 'Save', cmd: 'save-go', primary: true }],
  onMount: (el) => el.querySelector('#dlg-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); emit('cmd', { name: 'save-go', el }); UI.closeDialog(); } }) });
}
function openDialog() {
  const built = S.cfg.trips.map((t) => `<div class="item"><span class="k">Built in</span><span><b>${esc(t.name)}</b><small>${esc(t.goal_short)}</small></span><span class="acts"><button class="btn sm primary" data-act="openplan" data-id="${t.id}">Open</button></span></div>`).join('');
  const mine = S.saved.map((r) => `<div class="item"><span class="k">${r.saved_utc.slice(0, 10)}</span><span><b>${esc(r.name)}</b><small>${r.plan.stations.length} stations · saved ${hhmm(r.saved_utc)} UTC</small></span>
    <span class="acts"><button class="btn sm primary" data-act="openplan" data-id="saved:${r.id}">Open</button><button class="btn sm" data-act="delplan" data-id="${r.id}">Delete</button></span></div>`).join('');
  UI.dialog({ title: 'Open plan', wide: true, body: `<h3>Ready-made walks</h3><div class="list">${built}</div><h3>My plans</h3><div class="list">${mine || '<div class="note">None saved yet. Use File ▸ Save plan as…</div>'}</div>` });
}
export function openPlan(id) {
  if (lockedOut('open another plan')) return app.render();
  if (id.startsWith('saved:')) {
    const rec = S.saved.find((r) => `saved:${r.id}` === id);
    const plan = rec ? P.clean(clone(rec.plan)) : null;
    if (!plan) return log('C', 'That saved plan could not be opened: it is not a valid plan');
    S.plan = plan;
    S.params = app.cleanParams({ ...S.params, ...rec.params });
    S.trip = id;
  } else app.loadTrip(id);
  S.sel = null; S.probe = null; S.tS = 0;
  app.planChanged(true);
  commit(`Opened "${S.plan.name}"`);
}

async function exportFile() {
  const data = await DB.dump();
  data.current = { plan: S.plan, params: S.params };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tenacity-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  log('status', `Exported ${data.plans.length} saved plans, ${data.marks.length} notes and ${data.history.length} history entries`);
}
function importFile(sure) {
  if (sure !== true) return UI.dialog({ title: 'Import a Tenacity file?', body: '<p>Importing <b>replaces</b> every saved plan, note and history entry in this browser with the contents of the file. Export first if you want to keep what is here.</p>', buttons: [{ label: 'Cancel' }, { label: 'Choose a file…', cmd: 'import-go', primary: true }] });
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    try {
      const data = JSON.parse(await input.files[0].text());
      await DB.restore(data);
      await loadStored();
      const plan = data.current ? P.clean(data.current.plan) : null;
      if (plan) { S.plan = plan; S.params = app.cleanParams({ ...S.params, ...data.current.params }); }
      log('status', `Imported ${S.saved.length} plans and ${S.marks.length} notes`);
      app.planChanged(true);
    } catch (err) { log('C', `Import failed: ${err.message}`); }
  };
  input.click();
}

// ---------- notes and marks on the map ----------

S.marks = [];
export const MARK_KINDS = { note: ['Note', 'N'], hazard: ['Hazard', '!'], sample: ['Sample to collect', 'S'], photo: ['Photo point', 'P'] };
function addMark(pt) {
  const m = { id: `m${Date.now()}`, lat: pt.lat, lon: pt.lon, kind: 'note', title: '', text: '', t: now() };
  S.marks.push(m);
  S.editMark = m.id;
  DB.put('marks', m);
  UI.togglePanel('probe', true);
  app.renderProbe(); MV.drawPlan();
  if (S.tab === 'notes') app.renderTab();
  setTimeout(() => { const el = $('#mark-title'); if (el) el.focus(); }, 30);
}
function saveMark(id, root) {
  const m = S.marks.find((x) => x.id === id);
  if (!m) return;
  m.kind = root.querySelector('#mark-kind').value;
  m.title = root.querySelector('#mark-title').value.trim();
  m.text = root.querySelector('#mark-text').value.trim();
  m.t = now();
  S.editMark = null;
  DB.put('marks', m);
  log('status', `Note saved: ${m.title || MARK_KINDS[m.kind][0]}`);
  app.renderProbe(); MV.drawPlan();
  if (S.tab === 'notes') app.renderTab();
}
function delMark(id) {
  S.marks = S.marks.filter((x) => x.id !== id);
  S.editMark = null;
  DB.del('marks', id);
  app.renderProbe(); MV.drawPlan();
  if (S.tab === 'notes') app.renderTab();
}
// The notes within reach of the probe point, and the editor for the one being written.
export function marksAtHTML(pt) {
  const near = S.marks.filter((m) => distM(m, pt) < 12);
  return near.map((m) => (S.editMark === m.id ? `<div class="noteform" id="markform">
      <div class="acts"><select id="mark-kind" aria-label="Kind of mark">${Object.entries(MARK_KINDS).map(([k, [label]]) => `<option value="${k}" ${m.kind === k ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <input type="text" id="mark-title" placeholder="Short title" value="${esc(m.title)}" maxlength="40" style="flex:1"></div>
      <textarea id="mark-text" placeholder="What should the crew know about this spot?" maxlength="600">${esc(m.text)}</textarea>
      <div class="acts"><button class="btn primary sm" data-act="savenote" data-id="${m.id}">Save note</button><button class="btn sm" data-act="delnote" data-id="${m.id}">Delete</button></div></div>`
    : `<div class="sub">${MARK_KINDS[m.kind][0]} · ${esc(m.title || 'untitled')}</div><div class="note" style="color:var(--text)">${esc(m.text || 'No text.')}
      <div class="acts" style="margin-top:6px;display:flex;gap:6px"><button class="btn sm" data-act="editnote" data-id="${m.id}">Edit</button><button class="btn sm" data-act="delnote" data-id="${m.id}">Delete</button></div></div>`)).join('');
}
function notesHTML() {
  if (!S.marks.length) return '<div class="note">No notes yet. Click a point on the map, then choose "Add note" in the Probe panel. Notes are kept in this browser and travel with an exported plan.</div>';
  return `<div class="list">${[...S.marks].reverse().map((m) => `<div class="item"><span class="f ${m.kind === 'hazard' ? 'fC' : 'f0'}" style="${m.kind === 'hazard' ? '' : 'color:var(--strong)'}">${MARK_KINDS[m.kind][1]}</span>
    <span><b>${esc(m.title || MARK_KINDS[m.kind][0])}</b><small>${esc(m.text || '')} · ${fmtLat(m.lat)}, ${fmtLon(m.lon)} · ${m.t.slice(0, 10)}</small></span>
    <span class="acts"><button class="btn sm" data-act="gonote" data-id="${m.id}">Show</button><button class="btn sm" data-act="delnote" data-id="${m.id}">Delete</button></span></div>`).join('')}</div>`;
}

export function tabHTML(tab) {
  if (tab === 'notes') return notesHTML();
  if (tab === 'history') return historyHTML();
  return '';
}

// ---------- settings ----------

function settingsDialog() {
  const opt = (label, sub, control) => `<label class="opt"><span>${label}<small>${sub}</small></span>${control}</label>`;
  const check = (key) => `<input type="checkbox" data-set="${key}" ${S.set[key] ? 'checked' : ''}>`;
  DB.counts().then((n) => { const el = $('#set-db'); if (el) el.textContent = `${n.plans} saved plans, ${n.marks} notes, ${n.history} history entries. ${DB.persistent() ? 'Stored in this browser (IndexedDB).' : 'This browser refused a database; kept for this session only.'}`; });
  const el = UI.dialog({ title: 'Settings', wide: true, body: `
    <h3>Display</h3>
    ${opt('Interface size', 'Large suits a tablet or gloved hands: bigger text and targets.', `<select data-set="scale">${[['compact', 'Compact'], ['normal', 'Normal'], ['large', 'Large (gloves)']].map(([v, l]) => `<option value="${v}" ${S.set.scale === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
    ${opt('Pulse on the crew marker', 'A slow pulse so the crew position is found at a glance.', check('crewPulse'))}
    <h3>Map</h3>
    ${opt('Smooth zoom', 'Continuous zoom with the wheel. Turn off for stepped zoom.', check('smoothZoom'))}
    ${opt('Explain routes in colour', 'When a path is found over the terrain, colour the ground it avoided and show the straight line it rejected.', check('explain'))}
    <h3>Help</h3>
    ${opt('Offer the tour on first visit', 'The guided tour can always be started from Help.', check('autoTour'))}
    <h3>Stored data</h3>
    <p class="dim" id="set-db">Counting…</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="cmd" data-id="export">Export everything</button><button class="btn" data-act="cmd" data-id="import">Import…</button><button class="btn" data-act="cmd" data-id="wipe">Delete stored data</button><button class="btn" data-act="cmd" data-id="resetlayout">Reset layout</button></div>`,
  buttons: [{ label: 'Done', primary: true }] });
  el.addEventListener('change', (e) => {
    const key = e.target.dataset.set;
    if (!key) return;
    S.set[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    UI.saveSettings();
    if (key === 'smoothZoom') log('status', 'Smooth zoom applies after the page is reloaded');
    if (key === 'explain') { MV.syncLayers(); MV.drawPlan(); }
    if (key === 'crewPulse') MV.drawPlan();
    if (key === 'scale') emit('resized');
  });
}

// ---------- search ----------

let index = null;
function buildIndex() {
  const items = [];
  const goStop = (id) => () => { const s = S.byId.get(id); MV.map.setView([s.lat, s.lon], Math.max(MV.map.getZoom(), 17), { animate: false }); emit('pick', { stop: id, lat: s.lat, lon: s.lon }); };
  for (const [id, t] of Object.entries(S.cfg.targets)) if (S.byId.has(id)) items.push({ group: 'Places', label: t.name, sub: t.kind, key: t.name, run: goStop(id) });
  for (const [id, list] of Object.entries(S.minerals.stops)) for (const sm of list) if (S.byId.has(id)) items.push({ group: 'Drill and scoop samples (CheMin)', label: sm.sample, sub: `sol ${sm.sol}`, key: sm.sample, run: goStop(id) });
  const apxs = S.science.apxs;
  if (apxs) for (const [id, spots] of Object.entries(apxs.stops)) { const seen = new Set(); for (const sp of spots) { if (!sp.target || seen.has(sp.target) || !S.byId.has(id)) continue; seen.add(sp.target); items.push({ group: 'Chemistry targets (APXS)', label: String(sp.target).replace(/_/g, ' '), sub: `sol ${sp.sol}`, key: String(sp.target).replace(/_/g, ' '), run: goStop(id) }); } }
  const cc = S.science.chemcam;
  if (cc) for (const [id, v] of Object.entries(cc.stops)) for (const [name] of v.targets) if (S.byId.has(id)) items.push({ group: 'Laser targets (ChemCam)', label: String(name).replace(/_/g, ' '), sub: `rover stop, sol ${S.byId.get(id).sol}`, key: String(name).replace(/_/g, ' '), run: goStop(id) });
  index = items;
}
const COMMANDS = [['Visualize path (3D flyover)', 'viz'], ['Guided tour', 'tour'], ['Settings', 'settings'], ['Open plan…', 'open'], ['Save plan as…', 'save'], ['Show the whole walk', 'fit'], ['Go to the crew', 'gocrew'],
  ['Cuff card (print)', 'cuff'], ['Export plan and notes', 'export'], ['Keyboard shortcuts', 'keys'], ['Undo', 'undo'], ['Redo', 'redo'], ['Reset layout', 'resetlayout']];
function searchItems(q) {
  if (!index) buildIndex();
  const out = [];
  const needle = q.toLowerCase();
  const hit = (s) => s.toLowerCase().includes(needle);
  const coord = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(q);
  if (coord) {
    const lat = Number(coord[1]);
    const lon = Number(coord[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 360) out.push({ group: 'Coordinates', label: `Go to ${fmtLat(lat)}, ${fmtLon(lon)}`, sub: 'planetocentric latitude, east longitude', run: () => { MV.map.setView([lat, lon], Math.max(MV.map.getZoom(), 15), { animate: false }); emit('pick', { lat, lon }); } });
  }
  S.plan.stations.forEach((st, i) => { const p = P.pointOf(st.at); if (!q || hit(`${P.stationId(i)} ${p.name}`)) out.push({ group: 'Stations in this plan', label: `${P.stationId(i)} ${p.name}`, sub: `${st.dwellMin} min`, run: () => emit('select', { type: 'station', i }) }); });
  for (const m of S.marks) if (q && hit(`${m.title} ${m.text}`)) out.push({ group: 'My notes', label: m.title || MARK_KINDS[m.kind][0], sub: m.text.slice(0, 50), run: () => goMark(m.id) });
  for (const [label, cmd] of COMMANDS) if (!q || hit(label)) out.push({ group: 'Commands', label, sub: '', run: () => emit('cmd', { name: cmd }) });
  if (q) {
    for (const r of S.sim.rules) if (hit(`${r.id} ${r.title}`)) out.push({ group: 'Flight rules', label: `${r.id} ${r.title}`, sub: r.level === 'pass' ? 'PASS' : r.level, run: () => emit('cmd', { name: 'rule', data: r.id }) });
    for (const l of MV.LAYERS) if (l.avail() && l.cat !== 'base' && hit(`${l.title} ${l.group}`)) out.push({ group: 'Layers', label: l.title, sub: `${l.group} · toggle`, run: () => emit('cmd', { name: 'layer', data: l.id }) });
    let n = 0;
    for (const it of index) { if (n >= 40) break; if (hit(it.key)) { out.push(it); n++; } }
  } else {
    for (const it of index) if (it.group === 'Places') out.push(it);
  }
  return out.slice(0, 80);
}
function goMark(id) {
  const m = S.marks.find((x) => x.id === id);
  if (!m) return;
  MV.map.setView([m.lat, m.lon], Math.max(MV.map.getZoom(), 17), { animate: false });
  emit('pick', { lat: m.lat, lon: m.lon });
}

// ---------- guided tour ----------

function tourSteps() {
  const tab = (id) => () => emit('tab', id);
  return [
    { title: 'Plan a walk on Mars before you take it', text: 'Tenacity is a planning tool for a crew walking at Gale Crater, where NASA\'s Curiosity rover has driven. You lay out a walk, the tool simulates it, and flight rules say whether it is safe. This tour takes about two minutes. A yellow blinking box shows what each step is about.' },
    { sel: '#verdict', title: 'The answer: GO or NO-GO', text: 'One line says whether the walk is safe, by how many minutes, and which rule is the tightest. Everything else on screen explains this line.' },
    { sel: '[data-panel="activity"]', title: 'The plan, step by step', text: 'INCONS is how you start (time, oxygen, pace). Each LEG is a walk; each STN is a station where you stop and work. Solid means a rover has driven that ground; dashed means it is known only from orbit.', try: 'click a row to open it.', before: () => { UI.togglePanel('activity', true); emit('select', null); } },
    { sel: '#activity .card', title: 'Change the plan here', text: 'Controls with a <b style="color:var(--accent)">blue edge</b> are things you can adjust: minutes of work, effort, how a leg is walked. Every change runs the simulation again and updates the answer at the top.', try: 'press + to add 15 minutes of work and watch the margin change.', before: () => emit('select', { type: 'station', i: 0 }) },
    { sel: '#mode', title: 'Sketch a new walk', text: '<b>Sketch</b>: each click on the map adds a station, and the terrain engine finds the easiest path to it. <b>Edit</b>: click to inspect and adjust. <b>Lock</b>: read-only, for following the walk.', try: 'switch to Sketch after the tour and click the map.' },
    { sel: '#map', title: 'The map', text: 'Magenta is the planned route. White hatching is ground too steep for a suit. The red line is the furthest you can be and still get home on the backup supply. The white marker with a pulse is where the crew is. Drag to pan, scroll to zoom.', before: () => { MV.applyPreset('plan'); MV.fitPlan(); } },
    { sel: '#crumb', title: 'Where you are looking', text: 'This bar names the place the map shows, from the planet down to the spot, and how wide the view is. The "Where on Mars" panel on the left shows the same on a small map of the planet.' },
    { sel: '[data-panel="probe"]', title: 'Probe any point', text: 'Click anywhere on the map and every layer is read at that point: slope, ground, walk-home time, what Curiosity measured there, and a photo if a rover stopped there. Add the point to the walk, or leave a note for the crew.', before: () => { UI.togglePanel('probe', true); const st = S.plan.stations[0]; if (st) { const p = P.pointOf(st.at); emit('pick', { lat: p.lat, lon: p.lon, stop: st.at.stop }); } } },
    { sel: '[data-panel="rules"]', title: 'Flight rules', text: 'Each rule is checked along the whole walk. PASS, or a flag: <b class="f fW">W</b> blocks the walk, <b class="f fC">C</b> needs a decision, <b class="f fA">A</b> is for awareness. Click a rule to jump to where it bites. The small <i>i</i> buttons explain every term, with links.', before: () => UI.togglePanel('rules', true) },
    { sel: '[data-panel="sim"]', title: 'Simulation', text: 'Oxygen, cooling water and battery at the start and end of the walk, the distance, and the likely range of duration. Every number is tagged MEASURED, NASA VALUE, DERIVED or ASSUMED.', before: () => UI.togglePanel('sim', true) },
    { sel: '#preset', title: 'Layers for each task', text: 'One click switches the map for a task: terrain hazards, science, light and radio line of sight, or how far you can go. The Layers tab below lists all of them with their sources.', try: 'click "Terrain hazard", then "Plan" to come back.' },
    { sel: '#clock', title: 'Mars time and playback', text: 'Earth time, Mars time, the sol, and the time since leaving the refuge. Press play to run the walk; shadow layers follow the playhead.', try: 'press ▶ and watch the crew marker move.' },
    { sel: '#bot', title: 'Sequence, timeline, layers, notes, history', text: 'The sequence lists every command with its numbers. Timeline and Profile show the walk against the clock and the ground. Notes holds your marks on the map. History keeps every version of the plan.', before: () => { UI.togglePanel('bottom', true); tab('sequence')(); } },
    { sel: '#toolbar', title: 'Visualize, search, settings', text: '<b>Visualize path</b> flies along the route over the 3D terrain. <b>Search</b> finds places, samples, layers and rules. <b>Settings</b> has a large mode for gloves. Undo and redo are on the left.' },
    { sel: '#menus', title: 'Make the workspace yours', text: 'Drag the dark gutters between panels to resize them. Click a panel\'s triangle to fold it, or × to hide it. The <b>Windows</b> menu brings panels back, swaps sides, and has ready-made workspaces.', try: 'open Windows ▸ Workspace: Map focus, then Reset layout.' },
    { title: 'That is the tour', text: 'Start with the ready-made "Boxwork ridges" walk, or switch to Sketch and click the map. You can replay this tour from Help ▸ Guided tour.' },
  ];
}
export function startTour() {
  const before = { ws: clone(S.ws), mode: S.mode, sel: S.sel, probe: S.probe, tab: S.tab, preset: S.preset, custom: S.custom, fill: S.fill, on: [...S.on] };
  UI.workspacePreset('planning');
  S.mode = 'edit';
  app.render();
  // When the tour ends, the workspace, mode and view go back to how they were.
  UI.startTour(tourSteps(), () => {
    S.set.tourSeen = true;
    UI.saveSettings();
    S.ws = before.ws; S.mode = before.mode; S.sel = before.sel; S.probe = before.probe; S.tab = before.tab;
    S.preset = before.preset; S.custom = before.custom; S.fill = before.fill; S.on = new Set(before.on);
    UI.applyWorkspace();
    MV.syncLayers();
    app.render();
  });
}
function offerTour() {
  UI.dialog({ title: 'Welcome to Tenacity', body: `<p>An EVA planner for walking on Mars. You lay out a walk at Gale Crater, the tool simulates it on real NASA terrain data, and flight rules say <b>GO</b> or <b>NO-GO</b>.</p>
    <p class="dim">The screen is dense on purpose. Tenacity is designed for astronauts and mission operations staff, not for the general public, so every rule, number and source stays in view. The two-minute tour points at each part of the screen with a blinking box.</p>`,
  buttons: [{ label: 'Skip', cmd: 'tourskip' }, { label: 'Start the tour', cmd: 'tour', primary: true }] });
}

// ---------- where on Mars ----------

const JEZERO = { lat: 18.44, lon: 77.45 };
function placeName(c) {
  const ref = P.refugePt();
  const near = (p, km) => distM(p, c) < km * 1000;
  if (near(ref, 150)) {
    let best = null;
    let bd = 500;
    for (const [id, t] of Object.entries(S.cfg.targets)) { const s = S.byId.get(id); if (!s) continue; const d = distM(s, c); if (d < bd) { bd = d; best = t.name; } }
    const part = c.lat < -4.69 ? 'Mount Sharp, lower slope' : 'Crater floor (Aeolis Palus)';
    const chain = S.chainNear ? S.chainNear(c, 400) : null;
    const region = chain !== null && S.regionAt ? S.regionAt(chain) : null;
    return ['Mars', 'Gale Crater', part, ...(region ? [region.name.replace(/ \(.*/, '')] : []), ...(best ? [`near ${best}`] : [])];
  }
  if (near(JEZERO, 60)) return ['Mars', 'Jezero Crater', 'Perseverance rover area'];
  return ['Mars', `${fmtLat(c.lat)}, ${fmtLon(c.lon)}`];
}
function renderLocator() {
  if (!MV.map || !MV.map._loaded) return;
  const b = MV.map.getBounds();
  const c = MV.map.getCenter();
  const centre = { lat: c.lat, lon: c.lng };
  const widthM = distM({ lat: c.lat, lon: b.getWest() }, { lat: c.lat, lon: b.getEast() });
  const width = widthM > 20000 ? `${Math.round(widthM / 1000).toLocaleString('en-GB')} km` : widthM > 2000 ? `${(widthM / 1000).toFixed(1)} km` : `${Math.round(widthM)} m`;
  const names = placeName(centre);
  $('#crumb').innerHTML = `<b>N ↑</b><i>│</i>${names.map((n, i) => (i === names.length - 1 ? `<b>${esc(n)}</b>` : esc(n))).join('<i>›</i>')}<i>│</i>view ${width} wide`;

  // Whole planet: longitude 0 to 360 east, latitude 90 to -90.
  const wx = (lon) => ((lon % 360) + 360) % 360;
  const wy = (lat) => 90 - lat;
  const vw = Math.max(b.getEast() - b.getWest(), 0);
  const vh = Math.max(b.getNorth() - b.getSouth(), 0);
  const grat = [60, 120, 180, 240, 300].map((x) => `<line x1="${x}" y1="0" x2="${x}" y2="180" stroke="#2c2c2c"/>`).join('') + [30, 60, 90, 120, 150].map((y) => `<line x1="0" y1="${y}" x2="360" y2="${y}" stroke="${y === 90 ? '#444' : '#2c2c2c'}"/>`).join('');
  const frame = vw > 6 ? `<rect x="${wx(b.getWest())}" y="${wy(b.getNorth())}" width="${Math.min(vw, 360)}" height="${Math.min(vh, 180)}" fill="rgba(255,255,255,0.08)" stroke="#fff" stroke-width="1.5"/>`
    : `<circle cx="${wx(c.lng)}" cy="${wy(c.lat)}" r="9" fill="none" stroke="#fff" stroke-width="1.5"/><path d="M${wx(c.lng) - 14} ${wy(c.lat)}h28M${wx(c.lng)} ${wy(c.lat) - 14}v28" stroke="#fff" stroke-width="1"/>`;
  const rover = (r) => `<circle cx="${wx(r.now.lon)}" cy="${wy(r.now.lat)}" r="3" fill="${C.text}"/><text x="${wx(r.now.lon) + 6}" y="${wy(r.now.lat) + 3}">${esc(r.name)}</text>`;
  const world = `<svg viewBox="0 25 360 130" data-loc="world" role="img" aria-label="Where the view is on Mars">${grat}<text x="4" y="36">MARS · 0° to 360° E</text>${S.rovers.map(rover).join('')}${frame}</svg>`;

  // Gale: the rover's whole track, with the view frame and the refuge.
  const [[south, west], [north, east]] = S.overlays.bounds;
  const k = Math.cos((-4.7 * Math.PI) / 180);
  const gw = (east - west) * k;
  const gh = north - south;
  const gx = (lon) => ((lon - west) * k / gw) * 100;
  const gy = (lat) => ((north - lat) / gh) * (100 * gh / gw);
  const H = 100 * gh / gw;
  const track = S.site.route.filter((_, i) => i % 12 === 0).map((r) => `${gx(r[0]).toFixed(1)},${gy(r[1]).toFixed(1)}`).join(' ');
  const ref = P.refugePt();
  const inGale = c.lat < north + 0.3 && c.lat > south - 0.3 && c.lng > west - 0.3 && c.lng < east + 0.3;
  const gFrame = !inGale ? '' : vw < 0.012
    ? `<circle cx="${gx(c.lng)}" cy="${gy(c.lat)}" r="5" fill="none" stroke="#fff" stroke-width="1.2"/>`
    : `<rect x="${gx(b.getWest())}" y="${gy(b.getNorth())}" width="${gx(b.getEast()) - gx(b.getWest())}" height="${gy(b.getSouth()) - gy(b.getNorth())}" fill="rgba(255,255,255,0.08)" stroke="#fff" stroke-width="1.2"/>`;
  const gale = `<svg viewBox="0 0 100 ${H.toFixed(1)}" data-loc="gale" style="width:30%" role="img" aria-label="Where the view is along the rover track"><polyline points="${track}" fill="none" stroke="${C.label}" stroke-width="1"/>
    <text x="3" y="9">GALE</text><circle cx="${gx(ref.lon)}" cy="${gy(ref.lat)}" r="2.6" fill="${C.route}"/>${gFrame}</svg>`;
  const crew = S.sim && S.tS > 0 ? P.positionAt(S.sim, S.tS) : ref;
  $('#locator').innerHTML = `${world}<div style="display:flex;gap:8px;align-items:flex-start">${gale}<div style="flex:1;display:grid;gap:3px;font-size:0.92em">
    <div><span class="k">View centre</span><br><span class="v">${fmtLat(c.lat)}, ${fmtLon(((c.lng % 360) + 360) % 360)}</span></div>
    <div><span class="k">View width</span><br><span class="v">${width}</span></div>
    <div><span class="k">Crew</span><br><span class="v">${S.tS > 0 ? `${fmtM(distM(ref, crew))} from refuge` : 'at the refuge'}</span></div>
    <button class="btn sm" data-act="cmd" data-id="gocrew">Go to the crew</button></div></div>`;
}
function locatorClick(e) {
  const svg = e.target.closest('svg[data-loc]');
  if (!svg) return;
  const r = svg.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width;
  const fy = (e.clientY - r.top) / r.height;
  if (svg.dataset.loc === 'world') return MV.map.setView([65 - fy * 130, fx * 360], Math.min(MV.map.getZoom(), 6), { animate: false });
  const [[south, west], [north, east]] = S.overlays.bounds;
  MV.map.setView([north - fy * (north - south), west + fx * (east - west)], Math.max(MV.map.getZoom(), 14), { animate: false });
}

// ---------- visualize path ----------

// Orbital imagery for the 3D view: HiRISE tiles from NASA's Curiosity map, joined into one picture
// cut to the region. Returns null if the tiles cannot be fetched in time; the view then shades the
// terrain by its own relief.
const HIRISE = 'https://mars.nasa.gov/mmgis-maps/MSL/Layers/MSL_Gale_HiRISE-LRGB_78quads/';
async function terrainTexture(region) {
  const z = clamp(Math.floor(Math.log2((1900 * 360) / ((region.east - region.west) * 256))), 13, 18);
  const n = 2 ** z;
  const xOf = (lon) => ((lon + 180) / 360) * n;
  const yOf = (lat) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  const x0 = xOf(region.west);
  const y0 = yOf(region.north);
  const W = Math.round((xOf(region.east) - x0) * 256);
  const H = Math.round((yOf(region.south) - y0) * 256);
  if (W < 16 || H < 16 || W > 4096 || H > 4096) return null;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const jobs = [];
  for (let tx = Math.floor(x0); tx <= Math.floor(xOf(region.east)); tx++) {
    for (let ty = Math.floor(y0); ty <= Math.floor(yOf(region.south)); ty++) {
      jobs.push(new Promise((ok) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => { ctx.drawImage(im, Math.round((tx - x0) * 256), Math.round((ty - y0) * 256)); ok(true); };
        im.onerror = () => ok(false);
        // Bottom-up tile rows. The query string keeps these apart from the map's own copies in the browser
        // cache: those were fetched without CORS and could not be used as a texture.
        im.src = `${HIRISE}${z}/${tx}/${n - 1 - ty}.png?texture=1`;
      }));
    }
  }
  const done = await Promise.race([Promise.all(jobs), new Promise((ok) => setTimeout(() => ok(null), 8000))]);
  if (!done || done.filter(Boolean).length < done.length * 0.6) return null;
  try { ctx.getImageData(0, 0, 1, 1); } catch { return null; }   // unusable if the browser marked it cross-origin
  return canvas;
}

let view3d = null;
let vizRun = 0;
function closeViz() {
  vizRun++;
  if (view3d) { try { view3d.destroy(); } catch { /* already gone */ } view3d = null; }
  $('#viz').hidden = true;
  $('#viz').innerHTML = '';
  MV.map.invalidateSize();
}
async function visualize() {
  const el = $('#viz');
  const run = ++vizRun;
  app.setPlaying(false);
  const legs = S.legs.filter((l) => l.path.length > 1);
  if (!legs.length) return log('C', 'Nothing to visualize: add a station first');
  // Where each station falls along the whole route, so its photo can be shown as the camera arrives.
  const total = legs.reduce((a, l) => a + l.lengthM, 0) || 1;
  let acc = 0;
  const stops = [];
  for (const l of legs) {
    acc += l.lengthM;
    if (l.station !== null) { const st = S.plan.stations[l.station]; const s = st.at.stop ? S.byId.get(st.at.stop) : null; stops.push({ f: acc / total, id: l.to, name: l.toName, photo: s && s.photo ? (s.photo.file || s.photo.url) : null, sol: s && s.photo ? s.photo.sol : null }); }
  }
  for (const s of stops) if (s.photo) new Image().src = s.photo;     // fetched now, so each is ready when the camera arrives
  el.hidden = false;
  el.innerHTML = `<canvas class="gl"></canvas>
    <div class="vbar"><span class="ttl">Path visualisation · ${esc(S.plan.name || 'walk')} · ${fmtM(total)}</span><span class="grow"></span>
      <button class="btn" data-act="cmd" data-id="viz">Replay</button><button class="btn primary" data-act="cmd" data-id="vizclose">Close</button><button class="ib" data-info="viz" aria-label="About this view">i</button></div>
    <div class="pov" hidden></div><div class="prog"><i></i></div>`;
  const pov = el.querySelector('.pov');
  const bar = el.querySelector('.prog i');
  let shown = null;
  const onProgress = (f) => {
    bar.style.width = `${(f * 100).toFixed(1)}%`;
    const at = [...stops].reverse().find((s) => f >= s.f - 0.004 && f < s.f + 0.11);   // the latest station reached, for a few seconds
    if ((at ? at.id : null) === shown) return;
    shown = at ? at.id : null;
    pov.hidden = !at;
    if (at) pov.innerHTML = `${at.photo ? `<img src="${at.photo}" alt="Curiosity's view at this station">` : ''}<div><b>${at.id} · ${esc(at.name)}</b>${at.photo ? `What you will see here: Curiosity Navcam, sol ${at.sol}. NASA/JPL-Caltech.` : 'No rover photo at this point: the ground here is known only from orbit.'}</div>`;
  };
  try {
    if (!S.grid) throw new Error('the elevation grid is not loaded');
    const V = await import('./view3d.js');
    if (run !== vizRun) return;
    if (view3d) view3d.destroy();
    view3d = V.createView3D(el.querySelector('canvas'));
    const pts = legs.flatMap((l) => l.path);
    const padLat = 220 / 59275;
    const padLon = padLat / Math.cos((pts[0].lat * Math.PI) / 180);
    const region = { south: Math.min(...pts.map((p) => p.lat)) - padLat, north: Math.max(...pts.map((p) => p.lat)) + padLat, west: Math.min(...pts.map((p) => p.lon)) - padLon, east: Math.max(...pts.map((p) => p.lon)) + padLon };
    const lim = S.params.slopeLimitDeg ?? 20;
    let nogo = null;
    if (S.slope) { nogo = new Uint8Array(S.slope.length); for (let i = 0; i < nogo.length; i++) nogo[i] = S.slope[i] > lim ? 1 : 0; }
    const ref = P.refugePt();
    const texture = await terrainTexture(region);
    if (run !== vizRun) return;
    view3d.setScene({ grid: S.grid, region, exaggeration: 1.5, texture, nogo,
      credit: texture ? 'imagery: MRO HiRISE, NASA/JPL-Caltech/Univ. of Arizona · elevation: MRO HiRISE model via NASA Mars Trek' : undefined,
      legs: legs.map((l) => ({ id: l.id, dashed: !l.proven, pts: l.path.map((p) => ({ lat: p.lat, lon: p.lon })) })),
      stations: S.plan.stations.map((st, i) => { const p = P.pointOf(st.at); return { lat: p.lat, lon: p.lon, label: `${P.stationId(i)} ${p.name}` }; }),
      refuge: { lat: ref.lat, lon: ref.lon, label: `REFUGE ${ref.name}` },
      marks: S.marks.map((m) => ({ lat: m.lat, lon: m.lon, label: m.title || MARK_KINDS[m.kind][0], colour: m.kind === 'hazard' ? C.caut : '#ffffff' })) });
    log('status', `Path visualisation: ${fmtM(total)} over the 3D terrain, heights exaggerated 1.5 times, ${texture ? 'draped with HiRISE imagery (NASA/JPL-Caltech/Univ. of Arizona)' : 'shaded by its own relief (imagery not reached)'}`);
    await view3d.flyAlong(clamp(total * 9, 14000, 30000), onProgress);
  } catch (err) {
    // No 3D available: run the walk on the flat map instead, with the map following the crew.
    if (run !== vizRun) return;
    log('A', `3D view not available (${err.message}); playing the walk on the map instead`);
    closeViz();
    const dur = S.sim.totals.durS;
    const t0 = performance.now();
    const span = 16000;
    const tick = () => {
      if (run !== vizRun - 1 && run !== vizRun) return;
      const f = clamp((performance.now() - t0) / span, 0, 1);
      S.tS = f * dur;
      app.renderLive();
      const here = P.positionAt(S.sim, S.tS);
      if (here) MV.map.panTo([here.lat, here.lon], { animate: false });
      if (f < 1) requestAnimationFrame(tick);
    };
    MV.map.setZoom(Math.max(MV.map.getZoom(), 17), { animate: false });
    requestAnimationFrame(tick);
  }
}

// ---------- commands ----------

function command({ name, data, el }) {
  const run = {
    undo, redo, open: openDialog, save: saveDialog, export: exportFile, import: () => importFile(false), 'import-go': () => importFile(true), settings: settingsDialog, tour: startTour, viz: visualize, vizclose: closeViz,
    'reset-go': () => app.act('reset', { sure: '1' }),
    'wipe-go': async () => { for (const t of ['plans', 'history', 'marks']) await DB.clear(t); S.saved = []; S.marks = []; S.history = []; hist = [snapshot('Start')]; hi = 0; log('status', 'Stored plans, notes and history deleted'); app.render(); },
    'clearhistory-go': () => { DB.clear('history'); S.history = []; app.renderTab(); log('status', 'History cleared'); },
    'delplan-go': () => { DB.del('plans', data); S.saved = S.saved.filter((r) => r.id !== data); log('status', 'Saved plan deleted'); app.render(); },
    'save-go': () => { const v = (el || document).querySelector('#dlg-name'); const n = v ? v.value.trim() : ''; if (n) savePlan(n); },
    tourskip: () => { S.set.tourSeen = true; UI.saveSettings(); },
    search: () => UI.openSearch(searchItems),
    cuff: () => app.act('cuff', {}),
    reset: () => app.act('reset', {}),
    koz: () => app.act('koz', {}),
    note: () => S.probe && addMark(S.probe),
    fit: () => MV.fitPlan(),
    gocrew: () => { const p = S.tS > 0 ? P.positionAt(S.sim, S.tS) : P.refugePt(); MV.map.setView([p.lat, p.lon], Math.max(MV.map.getZoom(), 17), { animate: false }); },
    preset: () => app.act('preset', { id: data }),
    explain: () => { S.set.explain = !S.set.explain; UI.saveSettings(); MV.syncLayers(); MV.drawPlan(); app.render(); },
    panel: () => UI.togglePanel(data),
    workspace: () => UI.workspacePreset(data),
    resetlayout: () => UI.workspacePreset('planning'),
    swap: () => { S.ws.swap = !S.ws.swap; UI.applyWorkspace(); },
    rule: () => app.act('rule', { id: data }),
    layer: () => { const def = MV.LAYERS.find((l) => l.id === data); const onNow = def.kind === 'fill' ? S.fill === data : S.on.has(data); MV.toggleLayer(data, !onNow); log('status', `Layer ${onNow ? 'off' : 'on'}: ${def.title}`); },
    sources: () => { UI.togglePanel('bottom', true); emit('tab', 'sources'); },
    wipe: () => UI.dialog({ title: 'Delete stored data?', body: '<p>Every saved plan, note and history entry in this browser will be deleted. This cannot be undone. The plan on screen stays.</p>', buttons: [{ label: 'Cancel' }, { label: 'Delete everything', cmd: 'wipe-go', primary: true }] }),
    keys: () => UI.dialog({ title: 'Keyboard shortcuts', body: `<table>${[['Ctrl + K', 'Search'], ['Ctrl + Z / Ctrl + Y', 'Undo / redo'], ['Space', 'Play or pause the walk'], ['← / →', 'Previous or next step (also in the tour)'], ['V', 'Visualize path'], ['F', 'Show the whole walk'], ['Esc', 'Close a dialog, a menu or the tour']].map(([k, v]) => `<tr><td class="l">${k}</td><td class="t">${v}</td></tr>`).join('')}</table>` }),
    about: () => UI.dialog({ title: 'About Tenacity', body: `<p>An EVA planner for walking on Mars, built for the NASA Space Apps Challenge 2026, "Interplanetary Survival Guide: Martian Map".</p>
      <p>It follows the way rover drivers at JPL plan a drive (sketch, simulate, validate) and applies it to a crew on foot at Gale Crater, on real NASA data: the Curiosity rover's track and measurements, and orbital imagery, elevation and mineral maps.</p>
      <p>It is deliberately not simplified. It is designed for trained users (astronauts and mission operations staff), not for the general public, so it keeps every rule, number and source in view instead of hiding detail for a simpler screen.</p>
      <p class="dim">Every number is tagged MEASURED, NASA VALUE, DERIVED or ASSUMED. Walking speed and effort on Mars have never been measured; they are assumptions. Not affiliated with or endorsed by NASA.</p>`,
    buttons: [{ label: 'Where the data comes from', cmd: 'sources' }, { label: 'Close', primary: true }] }),
  }[name];
  if (run) run();
}

// Actions raised by buttons inside panels. Returns true when handled here.
export function handle(action, d, el) {
  if (action === 'cmd') { command({ name: d.id }); return true; }
  if (action === 'collapse') { UI.collapsePanel(d.id); return true; }
  if (action === 'hidepanel') { UI.togglePanel(d.id, false); log('status', `Panel hidden: ${d.id}. Bring it back from the Windows menu.`); return true; }
  if (action === 'note') { if (S.probe) addMark(S.probe); return true; }
  if (action === 'editnote') { S.editMark = d.id; app.renderProbe(); return true; }
  if (action === 'savenote') { saveMark(d.id, el.closest('#markform')); return true; }
  if (action === 'delnote') { delMark(d.id); return true; }
  if (action === 'gonote') { goMark(d.id); return true; }
  if (action === 'restore') { const h = S.history[Number(d.i)]; if (h && !lockedOut('restore a version')) { applySnap(h, `Restored the version from ${hhmm(h.t)} UTC: "${h.label}"`); commit(`Restored "${h.label}"`); } return true; }
  if (action === 'clearhistory') { UI.dialog({ title: 'Clear the history?', body: `<p>${S.history.length} stored versions of the plan will be deleted. This cannot be undone.</p>`, buttons: [{ label: 'Cancel' }, { label: 'Clear history', cmd: 'clearhistory-go', primary: true }] }); return true; }
  if (action === 'openplan') { UI.closeDialog(); openPlan(d.id); return true; }
  if (action === 'delplan') { const rec = S.saved.find((r) => r.id === d.id); UI.dialog({ title: 'Delete this saved plan?', body: `<p>"${esc(rec ? rec.name : '')}" will be deleted from this browser. This cannot be undone.</p>`, buttons: [{ label: 'Cancel' }, { label: 'Delete', cmd: 'delplan-go', data: d.id, primary: true }] }); return true; }
  return false;
}

// Stored records are checked before use: a file from elsewhere may hold anything.
const text = (v, n) => String(v ?? '').slice(0, n);
async function loadStored() {
  S.saved = (await DB.all('plans')).filter((r) => r && P.valid(r.plan) && typeof r.saved_utc === 'string').map((r) => ({ ...r, id: text(r.id, 40), name: text(r.name, 60) })).sort((a, b) => (a.saved_utc < b.saved_utc ? 1 : -1));
  S.marks = (await DB.all('marks')).filter((m) => m && Number.isFinite(m.lat) && Number.isFinite(m.lon) && Math.abs(m.lat) <= 90 && Math.abs(m.lon) <= 360)
    .map((m) => ({ id: text(m.id, 40), lat: m.lat, lon: m.lon, kind: MARK_KINDS[m.kind] ? m.kind : 'note', title: text(m.title, 40), text: text(m.text, 600), t: text(m.t, 30) }));
  S.history = (await DB.all('history')).filter((h) => h && P.valid(h.plan) && typeof h.t === 'string').map((h) => ({ ...h, label: text(h.label, 120), verdict: text(h.verdict, 40) })).sort((a, b) => (a.t < b.t ? 1 : -1));
}

export async function init(appApi) {
  app = appApi;
  buildChrome();
  on('cmd', command);
  await DB.openStore();
  await loadStored();
  hist = [snapshot('Start')];
  hi = 0;
  paintToolbar();

  let moved = 0;
  const later = () => { clearTimeout(moved); moved = setTimeout(renderLocator, 120); };
  MV.map.on('move zoom', later);
  on('playhead', later);
  on('resized', () => { MV.map.invalidateSize(); later(); });
  $('#locator').addEventListener('click', locatorClick);
  renderLocator();

  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input, select, textarea');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return command({ name: 'search' }); }
    if (typing) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
    if (e.ctrlKey || e.metaKey || e.altKey || UI.tourRunning()) return;
    if (e.key === 'v' || e.key === 'V') command({ name: 'viz' });
    if (e.key === 'f' || e.key === 'F') MV.fitPlan();
    if (e.key === 'Escape' && !$('#viz').hidden) closeViz();
  });
}

// Shown once the first plan is on screen.
export function afterFirstPaint() {
  if (S.set.autoTour && !S.set.tourSeen && window.innerWidth > 900) offerTour();
}
