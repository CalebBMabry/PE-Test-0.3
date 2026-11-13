/* ============================================================
   Fitness Room Tracker — app logic
   All data lives in this browser (localStorage). No server.

   Data shape:
   {
     version: 1,
     unit: 'lb' | 'kg',
     people:   [{ id, name, birthday:'YYYY-MM-DD'|'', notes, created, sample? }],
     weekly:   { 'YYYY-MM-DD' (Monday): { personId: { w, hr } } },
     workouts: { 'YYYY-MM-DD' (Monday): { personId: { '0'..'4': { type, min } } } },
     lastBackup: ISO string | null
   }
   ============================================================ */
(() => {
  'use strict';

  const STORE_KEY = 'fitnessRoomTracker.v1';
  const TABS = ['dashboard', 'profiles', 'weekly', 'workouts', 'data', 'help'];
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const DEFAULT_TYPES = ['Circuit', 'Cardio', 'Strength', 'Weights', 'Running', 'Walking', 'Cycling',
    'HIIT', 'Stretching', 'Yoga', 'Sports', 'Fitness test', 'Absent'];

  /* ---------- small helpers ---------- */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const round1 = v => Math.round(v * 10) / 10;
  const num = v => {
    const s = String(v ?? '').trim().replace(',', '.');
    if (s === '' || isNaN(s)) return null;
    return Number(s);
  };
  const fmtNum = v => v == null ? '—' : round1(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const fmtChange = c => c == null ? '—' : (c > 0 ? '+' : c < 0 ? '−' : '±') + fmtNum(Math.abs(c));
  const changeClass = c => c == null || c === 0 ? 'same' : c > 0 ? 'up' : 'down';
  const median = arr => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

  /* ---------- dates (always local time) ---------- */
  const pad = n => String(n).padStart(2, '0');
  const toKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const mondayOf = d => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return addDays(x, -((x.getDay() + 6) % 7));
  };
  const thisWeek = () => toKey(mondayOf(new Date()));
  const todayIdx = () => (new Date().getDay() + 6) % 7; // 0 = Mon … 6 = Sun
  const fmtShort = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const fmtLong = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  // Accepts 2009-04-12, 4/12/2009, 4/12/09, 12.4.2009 (treated as M.D.Y), "April 12 2009".
  // Returns 'YYYY-MM-DD', '' for blank, or null if it can't be understood.
  function parseDate(input) {
    const s = String(input ?? '').trim();
    if (!s) return '';
    let m, y, mo, d;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
      y = +m[1]; mo = +m[2]; d = +m[3];
    } else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
      mo = +m[1]; d = +m[2]; y = +m[3];
      if (m[3].length === 2) { const cy = new Date().getFullYear() % 100; y += y <= cy ? 2000 : 1900; }
    } else {
      const t = new Date(s);
      return isNaN(t) ? null : toKey(t);
    }
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return toKey(dt);
  }

  function ageOf(bday) {
    if (!bday) return null;
    const b = fromKey(bday), t = new Date();
    let a = t.getFullYear() - b.getFullYear();
    if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) a--;
    return a;
  }

  /* ============================================================
     State & storage
     ============================================================ */
  const blank = () => ({ version: 1, unit: 'lb', people: [], weekly: {}, workouts: {}, lastBackup: null });

  function normalize(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.people)) throw new Error('Not a tracker backup');
    return { ...blank(), ...d, weekly: d.weekly || {}, workouts: d.workouts || {} };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) { console.warn('Could not load saved data', e); }
    return blank();
  }

  let S = load();
  let saveTimer = null;

  function save(now = false) {
    clearTimeout(saveTimer);
    const run = () => {
      saveTimer = null;
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(S));
        flashSaved();
      } catch (e) {
        toast('⚠️ Could not save — browser storage is full or blocked. Download a backup now!', { ms: 8000 });
      }
    };
    if (now) run(); else saveTimer = setTimeout(run, 250);
  }
  window.addEventListener('beforeunload', () => { if (saveTimer) save(true); });
  window.addEventListener('storage', e => { if (e.key === STORE_KEY) { S = load(); renderAll(); } });

  // One-step undo for anything big (bulk add, quick fill, import, delete, erase).
  let undoSnap = null;
  const snapshot = () => { undoSnap = JSON.stringify(S); };
  function undo() {
    if (!undoSnap) return;
    S = normalize(JSON.parse(undoSnap));
    undoSnap = null;
    save(true); renderAll();
    toast('↩️ Undone');
  }

  /* ---------- data accessors ---------- */
  const personById = id => S.people.find(p => p.id === id);
  const sortedPeople = () => [...S.people].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const matches = (p, q) => !q || p.name.toLowerCase().includes(q.trim().toLowerCase());

  const weeklyEntry = (wk, id) => S.weekly[wk]?.[id];
  function setWeekly(wk, id, field, val) {
    S.weekly[wk] ??= {};
    const e = (S.weekly[wk][id] ??= {});
    if (val == null || val === '') delete e[field]; else e[field] = val;
    if (e.w == null && e.hr == null) delete S.weekly[wk][id];
    if (!Object.keys(S.weekly[wk]).length) delete S.weekly[wk];
  }

  const getWorkout = (wk, id, day) => S.workouts[wk]?.[id]?.[day];
  function setWorkout(wk, id, day, field, val) {
    const W = S.workouts;
    W[wk] ??= {};
    W[wk][id] ??= {};
    const e = (W[wk][id][day] ??= {});
    if (val == null || val === '') delete e[field]; else e[field] = val;
    if (e.type == null && e.min == null) delete W[wk][id][day];
    if (!Object.keys(W[wk][id]).length) delete W[wk][id];
    if (!Object.keys(W[wk]).length) delete W[wk];
  }
  const weekMinutes = (wk, id) => Object.values(S.workouts[wk]?.[id] || {}).reduce((a, e) => a + (e.min || 0), 0);
  const weekSessions = (wk, id) => Object.keys(S.workouts[wk]?.[id] || {}).length;

  function personHistory(id) {
    return Object.keys(S.weekly).sort()
      .map(wk => ({ wk, ...S.weekly[wk][id] }))
      .filter(e => e.w != null || e.hr != null);
  }

  function prevEntry(id, wk) {
    const keys = Object.keys(S.weekly).filter(k => k < wk).sort().reverse();
    let any = null, weight = null;
    for (const k of keys) {
      const e = S.weekly[k][id];
      if (!e) continue;
      if (!any) any = { wk: k, ...e };
      if (weight == null && e.w != null) weight = e.w;
      if (any && weight != null) break;
    }
    return { any, weight };
  }

  function stats(id) {
    const h = personHistory(id);
    const ws = h.filter(e => e.w != null);
    const hrs = h.filter(e => e.hr != null).map(e => e.hr);
    const first = ws[0]?.w ?? null, latest = ws.at(-1)?.w ?? null;
    return {
      hist: h, first, latest,
      change: ws.length > 1 ? round1(latest - first) : null,
      medianHr: hrs.length ? median(hrs) : null,
      checkins: h.length,
    };
  }

  function allWorkouts(id) {
    const out = [];
    for (const wk of Object.keys(S.workouts)) {
      const days = S.workouts[wk][id];
      if (!days) continue;
      for (const d of Object.keys(days)) out.push({ date: toKey(addDays(fromKey(wk), +d)), wk, day: +d, ...days[d] });
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }

  function removePeople(ids) {
    const set = new Set(ids);
    S.people = S.people.filter(p => !set.has(p.id));
    for (const store of [S.weekly, S.workouts]) {
      for (const wk of Object.keys(store)) {
        for (const id of set) delete store[wk][id];
        if (!Object.keys(store[wk]).length) delete store[wk];
      }
    }
  }

  /* ============================================================
     UI state
     ============================================================ */
  const UI = {
    tab: 'dashboard',
    week: thisWeek(),
    day: Math.min(todayIdx(), 4),
    overview: false,
    profileSearch: '', profileSort: 'name',
    weeklySearch: '', workoutSearch: '',
  };

  /* ---------- toast + saved indicator ---------- */
  let toastTimer;
  function toast(msg, { undo: canUndo = false, ms } = {}) {
    const t = $('#toast');
    t.innerHTML = `<span>${esc(msg)}</span>` + (canUndo ? '<button type="button" class="link" id="undoBtn">Undo</button>' : '');
    if (canUndo) $('#undoBtn').onclick = () => { t.classList.remove('show'); undo(); };
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || (canUndo ? 8000 : 3000));
  }

  const saveState = document.createElement('span');
  saveState.className = 'save-state';
  saveState.textContent = '✓ Saved';
  $('.topbar').appendChild(saveState);
  let savedTimer;
  function flashSaved() {
    saveState.classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => saveState.classList.remove('show'), 1500);
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const progressBar = (done, total) =>
    `<div class="progress" title="${done} of ${total}"><span style="width:${total ? Math.round(done / total * 100) : 0}%"></span></div>`;

  const emptyState = (emoji, title, body, actions = '') =>
    `<div class="empty"><span class="emoji">${emoji}</span><h3>${title}</h3><p>${body}</p>${actions}</div>`;

  const noPeopleState = () => emptyState('👥', 'No people yet',
    'Add the people in your fitness room first. It only takes a minute.',
    `<button class="primary" data-action="add-person">➕ Add one person</button>
     <button data-action="bulk-add">📋 Paste a list</button>`);

  /* ============================================================
     Tabs
     ============================================================ */
  function showTab(name) {
    if (!TABS.includes(name)) name = 'dashboard';
    UI.tab = name;
    $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    render(name);
  }

  function render(name = UI.tab) {
    ({
      dashboard: renderDashboard,
      profiles: renderProfiles,
      weekly: renderWeekly,
      workouts: renderWorkouts,
      data: renderData,
    })[name]?.();
  }

  function renderAll() {
    renderWeekPickers();
    renderDatalist();
    renderData();
    render();
  }

  /* ---------- week picker (shared by Weekly + Workouts) ---------- */
  function renderWeekPickers() {
    const mon = fromKey(UI.week), fri = addDays(mon, 4);
    const now = thisWeek();
    const tag = UI.week === now ? '<span class="pill">This week</span>'
      : UI.week < now ? '<span class="pill past">Past week</span>' : '<span class="pill past">Future week</span>';
    const html = `
      <button type="button" data-wk="-1" title="Previous week">◀</button>
      <span class="week-label"><b>${fmtShort(mon)} – ${fmtShort(fri)}</b><small>${fri.getFullYear()}</small>${tag}</span>
      <button type="button" data-wk="1" title="Next week">▶</button>
      ${UI.week === now ? '' : '<button type="button" class="small" data-wk="0">This week</button>'}`;
    $$('.week-picker').forEach(el => { el.innerHTML = html; });
  }

  function changeWeek(dir) {
    UI.week = dir === 0 ? thisWeek() : toKey(addDays(fromKey(UI.week), 7 * dir));
    if (dir === 0) UI.day = Math.min(todayIdx(), 4);
    renderWeekPickers();
    render();
  }

  function renderDatalist() {
    const counts = new Map();
    for (const wk of Object.values(S.workouts))
      for (const p of Object.values(wk))
        for (const e of Object.values(p))
          if (e.type) counts.set(e.type, (counts.get(e.type) || 0) + 1);
    const used = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    const seen = new Set(used.map(t => t.toLowerCase()));
    const all = [...used, ...DEFAULT_TYPES.filter(t => !seen.has(t.toLowerCase()))];
    $('#workoutTypes').innerHTML = all.map(t => `<option value="${esc(t)}">`).join('');
  }

  /* ============================================================
     Dashboard
     ============================================================ */
  function renderDashboard() {
    const el = $('#tab-dashboard');
    const n = S.people.length;
    if (!n) {
      el.innerHTML = `
        <div class="card welcome">
          <h1>👋 Welcome to Fitness Room Tracker</h1>
          <p>Track weight, resting heart rate and daily workouts for everyone in your fitness room.
             Everything saves automatically in this browser — there is no Save button to remember.</p>
          <h3>Step 1: add your people</h3>
          <div class="big-actions">
            <button class="primary big" data-action="add-person">➕ Add one person</button>
            <button class="big" data-action="bulk-add">📋 Paste a list of names</button>
            <button class="big" data-action="go" data-go="data">📥 Import a spreadsheet</button>
            <button class="big" data-action="sample">🧪 Just exploring? Load sample data</button>
          </div>
          <p class="muted">Then do a <b>⚖️ Weekly Check-In</b> once a week and log <b>🏃 Daily Workouts</b> Mon–Fri.
             The <button class="link" data-action="go" data-go="help">❓ Help</button> tab has a 2-minute guide.</p>
        </div>`;
      return;
    }

    const wk = thisWeek(), ti = todayIdx(), mon = fromKey(wk);
    const people = sortedPeople();
    const checked = people.filter(p => weeklyEntry(wk, p.id)).length;
    const missing = people.filter(p => !weeklyEntry(wk, p.id));
    const logged = ti < 5 ? people.filter(p => getWorkout(wk, p.id, ti)).length : 0;
    let mins = 0, active = 0;
    people.forEach(p => { mins += weekMinutes(wk, p.id); if (weekSessions(wk, p.id)) active++; });
    const st = people.map(p => ({ p, s: stats(p.id) }));
    const meds = st.map(r => r.s.medianHr).filter(v => v != null);
    const movers = st.filter(r => r.s.change).sort((a, b) => Math.abs(b.s.change) - Math.abs(a.s.change)).slice(0, 6);

    // Birthdays falling in this Mon–Sun week
    const weekMD = Array.from({ length: 7 }, (_, i) => toKey(addDays(mon, i)).slice(5));
    const bdays = people.filter(p => p.birthday && weekMD.includes(p.birthday.slice(5)));

    const hr = new Date().getHours();
    const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';

    let backup = '';
    const daysSince = S.lastBackup ? Math.floor((Date.now() - new Date(S.lastBackup)) / 864e5) : null;
    if (daysSince == null || daysSince >= 7) {
      backup = `<div class="banner"><span>💾 ${daysSince == null ? "You haven't downloaded a backup yet." : `Your last backup was ${daysSince} days ago.`}
        Your data lives only in this browser — a backup file keeps it safe.</span>
        <button class="primary small" data-action="backup">Download backup now</button></div>`;
    }

    el.innerHTML = `
      <div class="dash-head">
        <div><h1>${greet}! 👋</h1>
          <p class="muted">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · ${n} ${n === 1 ? 'person' : 'people'}</p></div>
        <button data-action="add-person">➕ Add person</button>
      </div>
      ${backup}
      <div class="dash-grid">
        <div class="card stat-card">
          <div class="stat-label">⚖️ This week's check-in</div>
          <div class="stat-big">${checked}<small> / ${n} done</small></div>
          ${progressBar(checked, n)}
          <button class="primary" data-action="start-checkin">${checked === n ? 'Review check-in' : checked ? 'Continue check-in' : 'Start check-in'} →</button>
        </div>
        <div class="card stat-card">
          <div class="stat-label">🏃 Today's workouts</div>
          ${ti < 5 ? `
            <div class="stat-big">${logged}<small> / ${n} logged</small></div>
            ${progressBar(logged, n)}
            <button class="primary" data-action="log-day" data-day="${ti}">Log ${DAY_NAMES[ti]} →</button>` : `
            <div class="stat-big">🎉</div>
            <p class="muted">It's the weekend — nothing to log today.</p>
            <button data-action="log-day" data-day="4">Review Friday →</button>`}
        </div>
        <div class="card stat-card">
          <div class="stat-label">⏱️ Workout minutes this week</div>
          <div class="stat-big">${mins.toLocaleString()}</div>
          <p class="muted">${active} of ${n} worked out · average ${Math.round(mins / n)} min per person</p>
        </div>
        <div class="card stat-card">
          <div class="stat-label">❤️ Typical resting heart rate</div>
          <div class="stat-big">${meds.length ? Math.round(median(meds)) : '—'}<small> bpm</small></div>
          <p class="muted">The middle of everyone's personal median heart rate</p>
        </div>
      </div>
      <div class="dash-cols">
        <div class="card">
          <h3>Still need this week's check-in (${missing.length})</h3>
          ${missing.length ? `<p class="muted">Click a name to jump straight to their row.</p>
            <div class="chips">${missing.slice(0, 40).map(p =>
              `<button class="chip" data-action="checkin-person" data-id="${p.id}">${esc(p.name)}</button>`).join('')}
            ${missing.length > 40 ? `<span class="muted">…and ${missing.length - 40} more</span>` : ''}</div>`
          : '<p>✅ Everyone is checked in this week. Nice work!</p>'}
        </div>
        <div class="card">
          <h3>Biggest weight changes (since first check-in)</h3>
          ${movers.length ? `<table><tbody>${movers.map(({ p, s }) => `
            <tr><td><button class="link" data-action="open-person" data-id="${p.id}">${esc(p.name)}</button></td>
            <td class="num muted">${fmtNum(s.first)} → ${fmtNum(s.latest)} ${S.unit}</td>
            <td class="num change ${changeClass(s.change)}">${fmtChange(s.change)}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted">Changes appear once people have two or more weigh-ins.</p>'}
          ${bdays.length ? `<h3 style="margin-top:1rem">🎂 Birthdays this week</h3><p>${bdays.map(p =>
            `${esc(p.name)} <span class="muted">(${fmtShort(fromKey(p.birthday))})</span>`).join(', ')}</p>` : ''}
        </div>
      </div>`;
  }

  /* ============================================================
     Profiles
     ============================================================ */
  function renderProfiles() {
    const el = $('#profilesTable');
    if (!S.people.length) { el.innerHTML = noPeopleState(); return; }
    const wk = thisWeek();
    let rows = S.people.filter(p => matches(p, UI.profileSearch))
      .map(p => ({ p, s: stats(p.id), age: ageOf(p.birthday), mins: weekMinutes(wk, p.id) }));
    const last = v => v == null ? Infinity : v;
    const byName = (a, b) => a.p.name.localeCompare(b.p.name, undefined, { sensitivity: 'base' });
    const sorts = {
      name: byName,
      age: (a, b) => last(a.age) - last(b.age) || byName(a, b),
      weight: (a, b) => last(-a.s.latest) - last(-b.s.latest) || byName(a, b),
      hr: (a, b) => last(a.s.medianHr) - last(b.s.medianHr) || byName(a, b),
    };
    rows.sort(sorts[UI.profileSort] || byName);

    if (!rows.length) {
      el.innerHTML = emptyState('🔍', 'No matches', `Nobody's name contains “${esc(UI.profileSearch)}”.`);
      return;
    }

    el.innerHTML = `
      <div class="table-caption"><span>Showing <b>${rows.length}</b> of ${S.people.length} people.
        <span class="muted">Click a name to see their progress charts.</span></span></div>
      <table>
        <thead><tr>
          <th>Name</th><th class="num">Age</th><th class="num">Latest weight</th>
          <th class="num hide-sm">Change</th><th class="num">Median HR</th>
          <th class="num hide-sm">Check-ins</th><th class="num hide-sm">Minutes this week</th><th></th>
        </tr></thead>
        <tbody>${rows.map(({ p, s, age, mins }) => `
          <tr data-id="${p.id}">
            <td><button class="link" data-action="open-person" data-id="${p.id}">${esc(p.name)}</button>
              ${p.notes ? `<span title="${esc(p.notes)}">📝</span>` : ''}</td>
            <td class="num">${age ?? '<span class="muted">—</span>'}</td>
            <td class="num">${s.latest == null ? '<span class="muted">—</span>' : fmtNum(s.latest) + ' ' + S.unit}</td>
            <td class="num hide-sm change ${changeClass(s.change)}">${fmtChange(s.change)}</td>
            <td class="num">${s.medianHr == null ? '<span class="muted">—</span>' : Math.round(s.medianHr) + ' bpm'}</td>
            <td class="num hide-sm">${s.checkins}</td>
            <td class="num hide-sm">${mins || '<span class="muted">0</span>'}</td>
            <td class="actions">
              <button class="icon" title="Edit ${esc(p.name)}" data-action="edit-person" data-id="${p.id}">✏️</button>
              <button class="icon" title="Delete ${esc(p.name)}" data-action="delete-person" data-id="${p.id}">🗑️</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  /* ---------- Add / edit one person ---------- */
  const profileDialog = $('#profileDialog');
  const profileForm = $('#profileForm');
  const F = name => profileForm.elements.namedItem(name);
  let editingId = null, returnToDetail = null;

  // "Save & add another" lives next to Save (only shown when adding).
  const againBtn = document.createElement('button');
  againBtn.value = 'again';
  againBtn.textContent = 'Save & add another';
  $('#profileSaveBtn').before(againBtn);

  function openProfileDialog(id = null) {
    editingId = id;
    const p = id && personById(id);
    profileForm.reset();
    profileDialog.returnValue = '';
    $('#profileDialogTitle').textContent = p ? `Edit ${p.name}` : 'Add Person';
    F('name').value = p?.name || '';
    F('birthday').value = p?.birthday || '';
    F('notes').value = p?.notes || '';
    F('weight').closest('label').firstChild.nodeValue = `Starting weight in ${S.unit} (optional)`;
    F('weight').closest('label').hidden = !!p;
    F('hr').closest('label').hidden = !!p;
    againBtn.hidden = !!p;
    profileDialog.showModal();
    F('name').focus();
  }

  profileForm.addEventListener('submit', e => {
    e.preventDefault();
    const name = F('name').value.trim().replace(/\s+/g, ' ');
    if (!name) { F('name').focus(); return; }
    const birthday = F('birthday').value;
    const notes = F('notes').value.trim();

    if (editingId) {
      Object.assign(personById(editingId), { name, birthday, notes });
      toast(`✅ Saved changes to ${name}`);
    } else {
      const dup = S.people.find(p => p.name.toLowerCase() === name.toLowerCase());
      if (dup && !confirm(`There is already someone named “${dup.name}”.\n\nAdd another person with the same name?`)) return;
      const p = { id: uid(), name, birthday, notes, created: toKey(new Date()) };
      S.people.push(p);
      const w = num(F('weight').value), hr = num(F('hr').value);
      if (w != null && w > 0) setWeekly(thisWeek(), p.id, 'w', round1(w));
      if (hr != null && hr > 0) setWeekly(thisWeek(), p.id, 'hr', Math.round(hr));
      toast(`✅ Added ${name}`);
    }
    save();
    const again = e.submitter?.value === 'again';
    profileDialog.close('save');
    renderAll();
    if (again) openProfileDialog();
  });

  profileDialog.addEventListener('close', () => {
    const r = returnToDetail;
    returnToDetail = null;
    if (r && personById(r)) openDetail(r);
  });

  function deletePerson(id) {
    const p = personById(id);
    if (!p) return;
    if (!confirm(`Delete ${p.name}?\n\nThis removes their profile, check-ins and workouts.`)) return;
    snapshot();
    removePeople([id]);
    save(true);
    if ($('#detailDialog').open) $('#detailDialog').close();
    renderAll();
    toast(`🗑️ Deleted ${p.name}`, { undo: true });
  }

  /* ---------- Add many ---------- */
  function openBulk() {
    $('#bulkForm').reset();
    $('#bulkDialog').showModal();
    $('#bulkForm textarea').focus();
  }

  $('#bulkForm').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('#bulkForm textarea').value;
    const existing = new Set(S.people.map(p => p.name.toLowerCase()));
    const toAdd = [];
    let dups = 0, badDates = 0;
    for (let line of text.split(/\r?\n/)) {
      line = line.trim();
      if (!line) continue;
      const parts = (line.includes('\t') ? line.split('\t') : line.split(',')).map(s => s.trim()).filter(Boolean);
      if (!parts.length || /^(full\s*)?name$/i.test(parts[0])) continue; // empty or a pasted header row
      let name = parts.join(' '), birthday = '';
      if (parts.length > 1) {
        const d = parseDate(parts.at(-1));
        if (d) { birthday = d; name = parts.slice(0, -1).join(', '); }
        else if (/\d/.test(parts.at(-1))) { badDates++; name = parts.slice(0, -1).join(', '); }
      }
      name = name.replace(/\s+/g, ' ');
      if (existing.has(name.toLowerCase())) { dups++; continue; }
      existing.add(name.toLowerCase());
      toAdd.push({ id: uid(), name, birthday, notes: '', created: toKey(new Date()) });
    }
    if (!toAdd.length) {
      toast(dups ? `Everyone in that list is already added (${dups}).` : 'Paste or type at least one name first.');
      return;
    }
    snapshot();
    S.people.push(...toAdd);
    save(true);
    $('#bulkDialog').close('save');
    renderAll();
    let msg = `✅ Added ${toAdd.length} ${toAdd.length === 1 ? 'person' : 'people'}`;
    if (dups) msg += ` · skipped ${dups} already in the list`;
    if (badDates) msg += ` · ${badDates} birthdays not understood (left blank)`;
    toast(msg, { undo: true });
  });

  /* ---------- Person detail ---------- */
  function lineChart(pts, { unit = '', color = 'var(--accent)', label = '' } = {}) {
    if (pts.length < 2) {
      return `<div class="chart-empty">${pts.length
        ? `Only one ${label} so far (${fmtNum(pts[0].y)} ${unit}). The chart appears after the second.`
        : `No ${label} yet.`}</div>`;
    }
    const W = 560, H = 190, P = { l: 42, r: 14, t: 12, b: 26 };
    const ys = pts.map(p => p.y);
    let min = Math.min(...ys), max = Math.max(...ys);
    if (max - min < 2) { min -= 1; max += 1; }
    const padY = (max - min) * 0.12; min -= padY; max += padY;
    const t0 = fromKey(pts[0].x).getTime(), t1 = fromKey(pts.at(-1).x).getTime();
    const X = k => P.l + (fromKey(k).getTime() - t0) / ((t1 - t0) || 1) * (W - P.l - P.r);
    const Y = v => P.t + (max - v) / (max - min) * (H - P.t - P.b);
    const ticks = [min + padY, (min + max) / 2, max - padY];
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} chart">
      ${ticks.map(t => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${Y(t)}" y2="${Y(t)}"/>
        <text class="axis" x="${P.l - 6}" y="${Y(t) + 4}" text-anchor="end">${Math.round(t)}</text>`).join('')}
      <text class="axis" x="${P.l}" y="${H - 6}">${fmtShort(fromKey(pts[0].x))}</text>
      <text class="axis" x="${W - P.r}" y="${H - 6}" text-anchor="end">${fmtShort(fromKey(pts.at(-1).x))}</text>
      <path class="line" d="${d}" stroke="${color}"/>
      ${pts.map(p => `<circle class="dot" cx="${X(p.x)}" cy="${Y(p.y)}" r="4.5" fill="${color}">
        <title>Week of ${fmtShort(fromKey(p.x))}: ${fmtNum(p.y)} ${unit}</title></circle>`).join('')}
    </svg>`;
  }

  function openDetail(id) {
    const p = personById(id);
    if (!p) return;
    const s = stats(id), age = ageOf(p.birthday);
    const works = allWorkouts(id);
    const totalMin = works.reduce((a, w) => a + (w.min || 0), 0);
    const wPts = s.hist.filter(e => e.w != null).map(e => ({ x: e.wk, y: e.w }));
    const hPts = s.hist.filter(e => e.hr != null).map(e => ({ x: e.wk, y: e.hr }));
    let prevW = null;
    const histRows = s.hist.map(e => {
      const c = e.w != null && prevW != null ? round1(e.w - prevW) : null;
      if (e.w != null) prevW = e.w;
      return { ...e, c };
    }).reverse();

    $('#detailBody').innerHTML = `
      <div class="detail-head">
        <div>
          <h2>${esc(p.name)}</h2>
          <div class="muted">${age != null ? `${age} years old · born ${fmtLong(fromKey(p.birthday))}` : 'No birthday saved'}</div>
          ${p.notes ? `<p class="notes">📝 ${esc(p.notes)}</p>` : ''}
        </div>
        <div class="head-actions">
          <button data-action="edit-person" data-id="${p.id}" data-from="detail">✏️ Edit</button>
          <button class="danger" data-action="delete-person" data-id="${p.id}">🗑️ Delete</button>
        </div>
      </div>
      <div class="stat-row">
        <div class="stat-tile"><div class="label">Latest weight</div><div class="value">${s.latest == null ? '—' : fmtNum(s.latest) + ' ' + S.unit}</div></div>
        <div class="stat-tile"><div class="label">Change since first</div><div class="value change ${changeClass(s.change)}">${fmtChange(s.change)}</div></div>
        <div class="stat-tile"><div class="label">Median resting HR</div><div class="value">${s.medianHr == null ? '—' : Math.round(s.medianHr) + ' bpm'}</div></div>
        <div class="stat-tile"><div class="label">Check-ins</div><div class="value">${s.checkins}</div></div>
        <div class="stat-tile"><div class="label">Workouts</div><div class="value">${works.length} <small class="muted">· ${totalMin.toLocaleString()} min</small></div></div>
      </div>
      <div class="charts">
        <div class="chart-card"><h3>Weight (${S.unit})</h3>${lineChart(wPts, { unit: S.unit, label: 'weigh-in' })}</div>
        <div class="chart-card"><h3>Resting heart rate (bpm)</h3>${lineChart(hPts, { unit: 'bpm', color: 'var(--danger)', label: 'heart-rate reading' })}</div>
      </div>
      <div class="detail-cols">
        <div><h3>Weekly check-ins</h3>
          ${histRows.length ? `<div class="scroll"><table>
            <thead><tr><th>Week of</th><th class="num">Weight</th><th class="num">Change</th><th class="num">Heart rate</th></tr></thead>
            <tbody>${histRows.map(e => `<tr><td>${fmtLong(fromKey(e.wk))}</td>
              <td class="num">${e.w == null ? '—' : fmtNum(e.w)}</td>
              <td class="num change ${changeClass(e.c)}">${e.c == null ? '' : fmtChange(e.c)}</td>
              <td class="num">${e.hr ?? '—'}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">No check-ins yet. Add them in ⚖️ Weekly Check-In.</p>'}
        </div>
        <div><h3>Recent workouts</h3>
          ${works.length ? `<div class="scroll"><table>
            <thead><tr><th>Date</th><th>Workout</th><th class="num">Minutes</th></tr></thead>
            <tbody>${works.slice(0, 60).map(w => `<tr>
              <td>${DAYS[w.day]} ${fmtShort(fromKey(w.date))}</td><td>${esc(w.type || '—')}</td>
              <td class="num">${w.min ?? '—'}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">No workouts logged yet. Add them in 🏃 Daily Workouts.</p>'}
        </div>
      </div>`;
    if (!$('#detailDialog').open) $('#detailDialog').showModal();
  }

  $('#detailClose').addEventListener('click', () => $('#detailDialog').close());
  // Click outside a dialog's box to close it
  $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close('cancel'); }));
  // Cancel buttons shouldn't be the form's default (Enter) button
  $$('dialog button[value="cancel"]').forEach(b => {
    b.type = 'button';
    b.addEventListener('click', () => b.closest('dialog').close('cancel'));
  });

  /* ============================================================
     Weekly check-in
     ============================================================ */
  function weightRange() { return S.unit === 'kg' ? [20, 250] : [45, 550]; }

  function renderWeekly() {
    const el = $('#weeklyTable');
    if (!S.people.length) { el.innerHTML = noPeopleState(); return; }
    const wk = UI.week;
    const people = sortedPeople().filter(p => matches(p, UI.weeklySearch));
    if (!people.length) {
      el.innerHTML = emptyState('🔍', 'No matches', `Nobody's name contains “${esc(UI.weeklySearch)}”.`);
      return;
    }
    el.innerHTML = `
      <div class="table-caption" id="weeklyProgress"></div>
      <table>
        <thead><tr><th>#</th><th>Name</th><th>Weight (${S.unit})</th><th>Resting HR (bpm)</th>
          <th class="hide-sm">Previous check-in</th><th class="num">Change</th></tr></thead>
        <tbody>${people.map((p, i) => {
          const e = weeklyEntry(wk, p.id) || {};
          const prev = prevEntry(p.id, wk);
          return `<tr data-id="${p.id}" class="${weeklyEntry(wk, p.id) ? 'done' : ''}">
            <td class="idx">${i + 1}</td>
            <td><button class="link" data-action="open-person" data-id="${p.id}">${esc(p.name)}</button></td>
            <td><input data-field="w" inputmode="decimal" autocomplete="off" value="${e.w ?? ''}"
              placeholder="${prev.weight != null ? fmtNum(prev.weight) : S.unit}" aria-label="${esc(p.name)} weight"></td>
            <td><input data-field="hr" inputmode="numeric" autocomplete="off" value="${e.hr ?? ''}"
              placeholder="bpm" aria-label="${esc(p.name)} heart rate"></td>
            <td class="muted hide-sm">${prev.any
              ? `${prev.any.w != null ? fmtNum(prev.any.w) + ' ' + S.unit : '—'} · ${prev.any.hr != null ? prev.any.hr + ' bpm' : '—'}
                 <small>(${fmtShort(fromKey(prev.any.wk))})</small>` : 'First check-in'}</td>
            <td class="num change"></td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    $$('tbody tr', el).forEach(tr => updateWeeklyRow(tr, tr.dataset.id));
    updateWeeklyProgress();
  }

  function updateWeeklyRow(tr, id) {
    const e = weeklyEntry(UI.week, id);
    tr.classList.toggle('done', !!e);
    const prevW = prevEntry(id, UI.week).weight;
    const c = e?.w != null && prevW != null ? round1(e.w - prevW) : null;
    const cell = $('.change', tr);
    cell.className = 'num change ' + changeClass(c);
    cell.textContent = c == null ? '' : `${fmtChange(c)} ${S.unit}`;
  }

  function updateWeeklyProgress() {
    const box = $('#weeklyProgress');
    if (!box) return;
    const n = S.people.length;
    const done = S.people.filter(p => weeklyEntry(UI.week, p.id)).length;
    box.innerHTML = `<b>${done} of ${n}</b> checked in for this week ${progressBar(done, n)}
      <span class="muted">${done === n ? '🎉 All done!' : 'Grey placeholders show last weight.'}</span>`;
  }

  $('#weeklyTable').addEventListener('input', e => {
    const inp = e.target.closest('input[data-field]');
    if (!inp) return;
    const tr = inp.closest('tr'), id = tr.dataset.id, f = inp.dataset.field;
    const raw = inp.value.trim();
    inp.classList.remove('invalid', 'warn');
    inp.title = '';
    let v = null;
    if (raw !== '') {
      const n = num(raw);
      if (n == null || n <= 0) { inp.classList.add('invalid'); inp.title = 'Please type a number'; return; }
      v = f === 'hr' ? Math.round(n) : round1(n);
      const [lo, hi] = f === 'hr' ? [30, 220] : weightRange();
      if (n < lo || n > hi) { inp.classList.add('warn'); inp.title = 'That looks unusual — please double-check'; }
    }
    setWeekly(UI.week, id, f, v);
    save();
    updateWeeklyRow(tr, id);
    updateWeeklyProgress();
  });

  /* ============================================================
     Daily workouts
     ============================================================ */
  function renderDayTabs() {
    const wk = UI.week, mon = fromKey(wk), today = toKey(new Date());
    $('#dayTabs').innerHTML = DAYS.map((d, i) => {
      const date = addDays(mon, i), isToday = toKey(date) === today;
      const c = S.people.filter(p => getWorkout(wk, p.id, i)).length;
      return `<button type="button" data-day="${i}" class="${i === UI.day && !UI.overview ? 'active' : ''} ${isToday ? 'today' : ''}"
        title="${DAY_NAMES[i]}, ${fmtLong(date)}${isToday ? ' (today)' : ''}${c ? ` — ${c} logged` : ''}">
        <b>${isToday ? 'Today' : d}</b><small>${fmtShort(date)}</small>${c ? `<span class="count">${c}</span>` : ''}</button>`;
    }).join('');
    $('.fill-all strong').textContent = `Quick fill everyone shown for ${DAY_NAMES[UI.day]}:`;
    $('#fillBtn').disabled = UI.overview;
    $('#fillBtn').title = UI.overview ? 'Turn off the week overview to quick fill a day' : '';
  }

  function renderWorkouts() {
    $('#weekOverview').checked = UI.overview;
    renderDayTabs();
    const el = $('#workoutTable');
    if (!S.people.length) { el.innerHTML = noPeopleState(); return; }
    const wk = UI.week;
    const people = sortedPeople().filter(p => matches(p, UI.workoutSearch));
    if (!people.length) {
      el.innerHTML = emptyState('🔍', 'No matches', `Nobody's name contains “${esc(UI.workoutSearch)}”.`);
      return;
    }

    if (UI.overview) {
      el.innerHTML = `
        <div class="table-caption"><span>Whole week at a glance. <span class="muted">Click any box to edit that day.</span></span></div>
        <table class="overview">
          <thead><tr><th>Name</th>${DAYS.map((d, i) => `<th>${d} ${fmtShort(addDays(fromKey(wk), i))}</th>`).join('')}<th class="num">Total min</th></tr></thead>
          <tbody>${people.map(p => `<tr>
            <td><button class="link" data-action="open-person" data-id="${p.id}">${esc(p.name)}</button></td>
            ${DAYS.map((_, i) => {
              const w = getWorkout(wk, p.id, i);
              return `<td><button class="cell-btn ${w ? 'filled' : ''}" data-action="goto-day" data-day="${i}" data-id="${p.id}">
                ${w ? `${esc(w.type || '?')}${w.min != null ? ` · ${w.min}` : ''}` : '+'}</button></td>`;
            }).join('')}
            <td class="num"><b>${weekMinutes(wk, p.id)}</b></td></tr>`).join('')}
          </tbody>
        </table>`;
      return;
    }

    el.innerHTML = `
      <div class="table-caption" id="workoutProgress"></div>
      <table>
        <thead><tr><th>#</th><th>Name</th><th>Workout</th><th>Minutes</th><th class="num hide-sm">Week total</th><th></th></tr></thead>
        <tbody>${people.map((p, i) => {
          const w = getWorkout(wk, p.id, UI.day) || {};
          return `<tr data-id="${p.id}" class="${getWorkout(wk, p.id, UI.day) ? 'done' : ''}">
            <td class="idx">${i + 1}</td>
            <td><button class="link" data-action="open-person" data-id="${p.id}">${esc(p.name)}</button></td>
            <td><input class="wide" data-field="type" list="workoutTypes" autocomplete="off" value="${esc(w.type ?? '')}"
              placeholder="e.g. Circuit" aria-label="${esc(p.name)} workout"></td>
            <td><input data-field="min" inputmode="numeric" autocomplete="off" value="${w.min ?? ''}"
              placeholder="min" aria-label="${esc(p.name)} minutes"></td>
            <td class="num hide-sm total">${weekMinutes(wk, p.id)}</td>
            <td class="actions"><button class="icon" title="Clear this entry" data-action="clear-workout" data-id="${p.id}">✖</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    updateWorkoutProgress();
  }

  function prevLoggedDay() {
    for (let d = UI.day - 1; d >= 0; d--)
      if (S.people.some(p => getWorkout(UI.week, p.id, d))) return d;
    return -1;
  }

  function updateWorkoutProgress() {
    const box = $('#workoutProgress');
    if (!box) return;
    const n = S.people.length;
    const done = S.people.filter(p => getWorkout(UI.week, p.id, UI.day)).length;
    const date = addDays(fromKey(UI.week), UI.day);
    const pd = prevLoggedDay();
    box.innerHTML = `<b>${DAY_NAMES[UI.day]}, ${fmtShort(date)}:</b> ${done} of ${n} logged ${progressBar(done, n)}
      ${pd >= 0 ? `<button class="small" data-action="copy-day" data-day="${pd}"
        title="Fill empty rows with what each person did on ${DAY_NAMES[pd]}">📋 Copy from ${DAY_NAMES[pd]}</button>` : ''}`;
  }

  function updateWorkoutRow(tr, id) {
    tr.classList.toggle('done', !!getWorkout(UI.week, id, UI.day));
    const t = $('.total', tr);
    if (t) t.textContent = weekMinutes(UI.week, id);
    updateWorkoutProgress();
    renderDayTabs();
  }

  $('#workoutTable').addEventListener('input', e => {
    const inp = e.target.closest('input[data-field]');
    if (!inp) return;
    const tr = inp.closest('tr'), id = tr.dataset.id, f = inp.dataset.field;
    let v = null;
    inp.classList.remove('invalid', 'warn');
    inp.title = '';
    if (f === 'min') {
      const raw = inp.value.trim();
      if (raw !== '') {
        const n = num(raw);
        if (n == null || n < 0) { inp.classList.add('invalid'); inp.title = 'Minutes must be a number'; return; }
        v = Math.round(n);
        if (n > 300) { inp.classList.add('warn'); inp.title = 'That is more than 5 hours — please double-check'; }
      }
    } else {
      v = inp.value.trim().replace(/\s+/g, ' ') || null;
    }
    setWorkout(UI.week, id, UI.day, f, v);
    save();
    updateWorkoutRow(tr, id);
  });
  $('#workoutTable').addEventListener('change', e => { if (e.target.dataset.field === 'type') renderDatalist(); });

  function quickFill() {
    const type = $('#fillType').value.trim().replace(/\s+/g, ' ');
    const min = num($('#fillMinutes').value);
    if (!type && min == null) { toast('Type a workout and/or minutes first, then click Apply.'); $('#fillType').focus(); return; }
    if (min != null && min < 0) { toast('Minutes must be a positive number.'); return; }
    const people = S.people.filter(p => matches(p, UI.workoutSearch));
    if (!people.length) return;
    snapshot();
    for (const p of people) {
      if (type) setWorkout(UI.week, p.id, UI.day, 'type', type);
      if (min != null) setWorkout(UI.week, p.id, UI.day, 'min', Math.round(min));
    }
    save(true);
    renderDatalist();
    renderWorkouts();
    const what = [type, min != null ? `${Math.round(min)} min` : ''].filter(Boolean).join(', ');
    toast(`✅ Filled ${people.length} people for ${DAY_NAMES[UI.day]} (${what}). Change anyone who was different.`, { undo: true });
  }

  function copyDay(from) {
    const people = S.people.filter(p => matches(p, UI.workoutSearch));
    snapshot();
    let k = 0;
    for (const p of people) {
      const src = getWorkout(UI.week, p.id, from);
      if (!src || getWorkout(UI.week, p.id, UI.day)) continue;
      if (src.type) setWorkout(UI.week, p.id, UI.day, 'type', src.type);
      if (src.min != null) setWorkout(UI.week, p.id, UI.day, 'min', src.min);
      k++;
    }
    if (!k) { undoSnap = null; toast('Nothing to copy — those rows are already filled in.'); return; }
    save(true);
    renderWorkouts();
    toast(`📋 Copied ${DAY_NAMES[from]} into ${k} empty rows`, { undo: true });
  }

  /* ---------- keyboard: Enter / ↑ ↓ move between rows ---------- */
  function gridNav(e) {
    const inp = e.target;
    if (!inp.matches('td input[data-field]')) return;
    let dir = 0;
    if (e.key === 'Enter') dir = e.shiftKey ? -1 : 1;
    else if (e.key === 'ArrowDown' && !inp.hasAttribute('list')) dir = 1;
    else if (e.key === 'ArrowUp' && !inp.hasAttribute('list')) dir = -1;
    else return;
    e.preventDefault();
    const inputs = $$(`td input[data-field="${inp.dataset.field}"]`, inp.closest('table'));
    const next = inputs[inputs.indexOf(inp) + dir];
    if (next) { next.focus(); next.select(); }
    else if (dir > 0) { inp.blur(); toast('🎉 That was the last person on the list.'); }
  }
  ['#weeklyTable', '#workoutTable'].forEach(sel => {
    $(sel).addEventListener('keydown', gridNav);
    $(sel).addEventListener('focusin', e => { if (e.target.matches('td input')) e.target.select(); });
  });

  /* ============================================================
     Import / Export
     ============================================================ */
  function renderData() {
    $('#unitSelect').value = S.unit;
    const hasSample = S.people.some(p => p.sample);
    $('#sampleBtn').textContent = hasSample ? '🧹 Remove the sample people' : '🧪 Load 120 sample people (to try it out)';
  }

  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c !== '\r') f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.some(x => x.trim()));
  }

  const COLS = {
    name: ['name', 'fullname', 'student', 'studentname', 'person', 'member'],
    birthday: ['birthday', 'birthdate', 'dob', 'dateofbirth', 'bday', 'born'],
    weight: ['weight', 'wt', 'lbs', 'lb', 'kg'],
    hr: ['heartrate', 'hr', 'restinghr', 'restingheartrate', 'bpm', 'pulse', 'rhr'],
    first: ['firstname', 'first', 'givenname'],
    last: ['lastname', 'last', 'surname', 'familyname'],
  };
  const normHeader = h => h.toLowerCase().replace(/[^a-z]/g, '');
  const colIndex = (header, key) =>
    header.findIndex(h => COLS[key].some(c => h === c || (c.length >= 5 && h.startsWith(c))));

  async function importCSV(file) {
    const rows = parseCSV(await file.text());
    if (!rows.length) { toast('That file looks empty.'); return; }
    const header = rows[0].map(normHeader);
    let map = Object.fromEntries(Object.keys(COLS).map(k => [k, colIndex(header, k)]));
    let body = rows.slice(1);
    if (Object.values(map).every(i => i < 0)) {
      // No header row — assume name, birthday, weight, heartrate
      map = { name: 0, birthday: 1, weight: 2, hr: 3, first: -1, last: -1 };
      body = rows;
    }
    if (map.name < 0 && map.first < 0) {
      toast('⚠️ Could not find a "name" column. Check the first row of the file (see the example above).', { ms: 7000 });
      return;
    }
    snapshot();
    const wk = thisWeek();
    const byName = new Map(S.people.map(p => [p.name.toLowerCase(), p]));
    let added = 0, existed = 0, skipped = 0, badDates = 0, readings = 0;
    for (const r of body) {
      const g = i => i >= 0 ? String(r[i] ?? '').trim() : '';
      const name = (map.name >= 0 ? g(map.name) : [g(map.first), g(map.last)].filter(Boolean).join(' ')).replace(/\s+/g, ' ');
      if (!name) { skipped++; continue; }
      let bd = parseDate(g(map.birthday));
      if (bd === null) { badDates++; bd = ''; }
      const w = num(g(map.weight)), hr = num(g(map.hr));
      let p = byName.get(name.toLowerCase());
      if (p) { if (bd && !p.birthday) p.birthday = bd; existed++; }
      else {
        p = { id: uid(), name, birthday: bd, notes: '', created: toKey(new Date()) };
        S.people.push(p); byName.set(name.toLowerCase(), p); added++;
      }
      if (w != null && w > 0) { setWeekly(wk, p.id, 'w', round1(w)); readings++; }
      if (hr != null && hr > 0) { setWeekly(wk, p.id, 'hr', Math.round(hr)); readings++; }
    }
    save(true);
    renderAll();
    let msg = `📥 Imported: ${added} new ${added === 1 ? 'person' : 'people'}`;
    if (existed) msg += `, ${existed} already existed`;
    if (readings) msg += `, ${readings} readings saved to this week`;
    if (badDates) msg += `, ${badDates} birthdays not understood (left blank)`;
    toast(msg + '.', { undo: true, ms: 10000 });
  }

  const csvCell = v => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const toCSV = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  const stamp = () => toKey(new Date());

  function exportProfilesCSV() {
    const rows = [['Name', 'Birthday', 'Age', `First weight (${S.unit})`, `Latest weight (${S.unit})`, `Change (${S.unit})`,
      'Median resting HR (bpm)', 'Check-ins', 'Workout sessions', 'Total workout minutes', 'Notes']];
    for (const p of sortedPeople()) {
      const s = stats(p.id), w = allWorkouts(p.id);
      rows.push([p.name, p.birthday, ageOf(p.birthday) ?? '', s.first ?? '', s.latest ?? '', s.change ?? '',
        s.medianHr == null ? '' : round1(s.medianHr), s.checkins, w.length, w.reduce((a, x) => a + (x.min || 0), 0), p.notes]);
    }
    download(`fitness-profiles-${stamp()}.csv`, toCSV(rows), 'text/csv');
  }

  function exportWeeklyCSV() {
    const rows = [['Week of (Monday)', 'Name', `Weight (${S.unit})`, 'Resting HR (bpm)']];
    const names = new Map(S.people.map(p => [p.id, p.name]));
    for (const wk of Object.keys(S.weekly).sort()) {
      const list = Object.entries(S.weekly[wk]).filter(([id]) => names.has(id))
        .sort((a, b) => names.get(a[0]).localeCompare(names.get(b[0])));
      for (const [id, e] of list) rows.push([wk, names.get(id), e.w ?? '', e.hr ?? '']);
    }
    if (rows.length === 1) { toast('No weekly check-ins to export yet.'); return; }
    download(`fitness-weekly-${stamp()}.csv`, toCSV(rows), 'text/csv');
  }

  function exportWorkoutsCSV() {
    const rows = [['Date', 'Day', 'Name', 'Workout', 'Minutes']];
    const names = new Map(S.people.map(p => [p.id, p.name]));
    const out = [];
    for (const wk of Object.keys(S.workouts))
      for (const [id, days] of Object.entries(S.workouts[wk]))
        if (names.has(id))
          for (const [d, e] of Object.entries(days))
            out.push([toKey(addDays(fromKey(wk), +d)), DAY_NAMES[+d], names.get(id), e.type ?? '', e.min ?? '']);
    out.sort((a, b) => a[0].localeCompare(b[0]) || a[2].localeCompare(b[2]));
    if (!out.length) { toast('No workouts to export yet.'); return; }
    download(`fitness-workouts-${stamp()}.csv`, toCSV(rows.concat(out)), 'text/csv');
  }

  function exportJSON() {
    S.lastBackup = new Date().toISOString();
    download(`fitness-room-backup-${stamp()}.json`, JSON.stringify(S, null, 1), 'application/json');
    save(true);
    toast('💾 Backup downloaded. Keep the file somewhere safe (e.g. a USB stick or cloud drive).', { ms: 5000 });
    if (UI.tab === 'dashboard') renderDashboard();
  }

  async function importJSON(file) {
    let d;
    try { d = normalize(JSON.parse(await file.text())); }
    catch { toast('⚠️ That file is not a Fitness Room Tracker backup (.json).', { ms: 6000 }); return; }
    if (!confirm(`Restore this backup?\n\nIt has ${d.people.length} people.\nIt will REPLACE what's in the app now (${S.people.length} people).`)) return;
    snapshot();
    S = d;
    save(true);
    renderAll();
    toast(`⬆️ Restored backup with ${d.people.length} people.`, { undo: true });
  }

  function changeUnit(to) {
    const from = S.unit;
    if (to === from) return;
    const hasWeights = Object.values(S.weekly).some(w => Object.values(w).some(e => e.w != null));
    if (hasWeights && confirm(`Convert all saved weights from ${from} to ${to}?\n\nOK = convert the numbers (e.g. 150 lb → 68 kg)\nCancel = keep the numbers, just change the label`)) {
      snapshot();
      const f = to === 'kg' ? 0.45359237 : 1 / 0.45359237;
      for (const wk of Object.values(S.weekly))
        for (const e of Object.values(wk))
          if (e.w != null) e.w = round1(e.w * f);
      S.unit = to;
      save(true); renderAll();
      toast(`⚖️ Weights converted to ${to}.`, { undo: true });
      return;
    }
    S.unit = to;
    save(true); renderAll();
    toast(`⚖️ Weights are now shown in ${to}.`);
  }

  function toggleSample() {
    const samples = S.people.filter(p => p.sample);
    if (samples.length) {
      if (!confirm(`Remove the ${samples.length} sample people and their data?\n\nPeople you added yourself are kept.`)) return;
      snapshot();
      removePeople(samples.map(p => p.id));
      save(true); renderAll();
      toast('🧹 Sample people removed.', { undo: true });
      return;
    }
    snapshot();
    const firsts = ['Ava', 'Liam', 'Mia', 'Noah', 'Emma', 'Elijah', 'Sofia', 'Lucas', 'Aria', 'Mateo', 'Zoe', 'Ethan', 'Layla',
      'Jayden', 'Chloe', 'Aiden', 'Nora', 'Caleb', 'Riley', 'Owen', 'Maya', 'Isaac', 'Leah', 'Diego', 'Grace', 'Kai',
      'Hannah', 'Malik', 'Priya', 'Jordan', 'Sam', 'Taylor', 'Imani', 'Ryan', 'Lucia', 'Omar', 'Ella', 'Wyatt', 'Nina', 'Theo'];
    const lasts = ['Smith', 'Johnson', 'Lee', 'Garcia', 'Brown', 'Nguyen', 'Patel', 'Martinez', 'Davis', 'Kim', 'Lopez',
      'Wilson', 'Anderson', 'Thomas', 'Moore', 'Jackson', 'Clark', 'Lewis', 'Walker', 'Young', 'Hall', 'Allen', 'Khan',
      'Wright', 'Scott', 'Torres', 'Hill', 'Green', 'Adams', 'Baker', 'Rivera', 'Campbell', 'Mitchell', 'Carter', 'Roberts',
      'Chen', 'Singh', 'Okafor', 'Murphy', 'Reed'];
    const types = ['Circuit', 'Cardio', 'Strength', 'Running', 'Stretching', 'Sports', 'HIIT', 'Walking'];
    const used = new Set(S.people.map(p => p.name.toLowerCase()));
    const nowWk = thisWeek(), today = new Date(), todayKey = toKey(today);
    const weeks = Array.from({ length: 8 }, (_, i) => toKey(addDays(fromKey(nowWk), -7 * (7 - i))));
    const plan = Object.fromEntries(weeks.map(wk => [wk, DAYS.map(() => ({ type: pick(types), min: pick([20, 25, 30, 35, 40, 45]) }))]));
    for (let i = 0; i < 120; i++) {
      let name;
      do { name = `${pick(firsts)} ${pick(lasts)}`; } while (used.has(name.toLowerCase()));
      used.add(name.toLowerCase());
      const age = rand(13, 17);
      const p = { id: uid(), name, birthday: toKey(new Date(today.getFullYear() - age, rand(0, 11), rand(1, 28))),
        notes: '', created: weeks[0], sample: true };
      S.people.push(p);
      let w = rand(95, 200) + Math.random();
      const trend = (Math.random() - 0.6) * 0.8, baseHr = rand(58, 84);
      weeks.forEach((wk, wi) => {
        const skip = wk === nowWk ? Math.random() < 0.4 : Math.random() < 0.08;
        if (!skip) {
          w += trend + (Math.random() - 0.5) * 1.5;
          setWeekly(wk, p.id, 'w', round1(S.unit === 'kg' ? w * 0.45359237 : w));
          setWeekly(wk, p.id, 'hr', Math.round(baseHr - wi * 0.3 + (Math.random() - 0.5) * 8));
        }
        DAYS.forEach((_, d) => {
          const date = toKey(addDays(fromKey(wk), d));
          if (date >= todayKey || Math.random() < 0.08) return; // leave today blank so you can try it
          const pl = plan[wk][d];
          setWorkout(wk, p.id, d, 'type', pl.type);
          setWorkout(wk, p.id, d, 'min', Math.random() < 0.15 ? Math.max(10, pl.min - 10) : pl.min);
        });
      });
    }
    save(true); renderAll();
    toast('🧪 Added 120 sample people with 8 weeks of history. Remove them anytime from 💾 Import / Export.', { undo: true, ms: 8000 });
  }

  function eraseAll() {
    const ans = prompt('This erases ALL people, check-ins and workouts from this browser.\n\nTip: download a backup first.\n\nType ERASE to confirm:');
    if (ans == null) return;
    if (ans.trim().toUpperCase() !== 'ERASE') { toast('Nothing was erased (you need to type ERASE).'); return; }
    snapshot();
    S = { ...blank(), unit: S.unit };
    save(true); renderAll();
    toast('🗑️ All data erased.', { undo: true, ms: 10000 });
  }

  /* ============================================================
     Wiring
     ============================================================ */
  $$('#tabs button').forEach((b, i) => {
    b.title = `Shortcut: Alt+${i + 1}`;
    b.addEventListener('click', () => showTab(b.dataset.tab));
  });
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

  // Week picker arrows (both tabs)
  document.addEventListener('click', e => {
    const b = e.target.closest('.week-picker button[data-wk]');
    if (b) changeWeek(+b.dataset.wk);
  });

  $('#dayTabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-day]');
    if (!b) return;
    UI.day = +b.dataset.day;
    UI.overview = false;
    renderWorkouts();
  });

  $('#weekOverview').addEventListener('change', e => { UI.overview = e.target.checked; renderWorkouts(); });
  $('#fillBtn').addEventListener('click', quickFill);
  [$('#fillType'), $('#fillMinutes')].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') quickFill(); }));

  // Search boxes
  [['#profileSearch', 'profileSearch', renderProfiles],
   ['#weeklySearch', 'weeklySearch', renderWeekly],
   ['#workoutSearch', 'workoutSearch', renderWorkouts]].forEach(([sel, key, fn]) => {
    $(sel).addEventListener('input', e => { UI[key] = e.target.value; fn(); });
  });
  $('#profileSort').addEventListener('change', e => { UI.profileSort = e.target.value; renderProfiles(); });

  $('#addProfileBtn').addEventListener('click', () => openProfileDialog());
  $('#bulkAddBtn').addEventListener('click', openBulk);

  // Data tab
  $('#csvFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importCSV(f); e.target.value = ''; });
  $('#importJson').addEventListener('change', e => { const f = e.target.files[0]; if (f) importJSON(f); e.target.value = ''; });
  $('#templateBtn').addEventListener('click', () =>
    download('fitness-import-template.csv', toCSV([['name', 'birthday', 'weight', 'heartrate'], ['Jordan Smith', '2009-04-12', '142', '68']]), 'text/csv'));
  $('#exportJsonBtn').addEventListener('click', exportJSON);
  $('#exportProfilesCsv').addEventListener('click', exportProfilesCSV);
  $('#exportWeeklyCsv').addEventListener('click', exportWeeklyCSV);
  $('#exportWorkoutsCsv').addEventListener('click', exportWorkoutsCSV);
  $('#unitSelect').addEventListener('change', e => changeUnit(e.target.value));
  $('#sampleBtn').addEventListener('click', toggleSample);
  $('#resetBtn').addEventListener('click', eraseAll);

  // Buttons rendered by JS use data-action
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.action) {
      case 'add-person': openProfileDialog(); break;
      case 'bulk-add': openBulk(); break;
      case 'go': showTab(b.dataset.go); break;
      case 'sample': toggleSample(); break;
      case 'backup': exportJSON(); break;
      case 'open-person': openDetail(id); break;
      case 'edit-person':
        if (b.dataset.from === 'detail') { returnToDetail = id; $('#detailDialog').close(); }
        openProfileDialog(id);
        break;
      case 'delete-person': deletePerson(id); break;
      case 'start-checkin':
        UI.week = thisWeek(); UI.weeklySearch = ''; $('#weeklySearch').value = '';
        renderWeekPickers(); showTab('weekly');
        focusFirstEmpty('#weeklyTable', 'w');
        break;
      case 'checkin-person':
        UI.week = thisWeek(); UI.weeklySearch = ''; $('#weeklySearch').value = '';
        renderWeekPickers(); showTab('weekly');
        focusRow('#weeklyTable', id, 'w');
        break;
      case 'log-day':
        UI.week = thisWeek(); UI.day = +b.dataset.day; UI.overview = false;
        renderWeekPickers(); showTab('workouts');
        focusFirstEmpty('#workoutTable', 'type');
        break;
      case 'goto-day':
        UI.day = +b.dataset.day; UI.overview = false;
        renderWorkouts();
        focusRow('#workoutTable', id, 'type');
        break;
      case 'clear-workout': {
        const tr = b.closest('tr');
        setWorkout(UI.week, id, UI.day, 'type', null);
        setWorkout(UI.week, id, UI.day, 'min', null);
        $$('input', tr).forEach(i => { i.value = ''; i.classList.remove('invalid', 'warn'); });
        save();
        updateWorkoutRow(tr, id);
        break;
      }
      case 'copy-day': copyDay(+b.dataset.day); break;
    }
  });

  function focusRow(sel, id, field) {
    const inp = $(`${sel} tr[data-id="${id}"] input[data-field="${field}"]`);
    if (inp) { inp.scrollIntoView({ block: 'center' }); inp.focus(); }
  }
  function focusFirstEmpty(sel, field) {
    const inputs = $$(`${sel} input[data-field="${field}"]`);
    const inp = inputs.find(i => !i.value) || inputs[0];
    if (inp) { inp.scrollIntoView({ block: 'center' }); inp.focus(); }
  }

  // Global shortcuts: Alt+1…6 switch tabs, "/" jumps to search, Esc clears search
  document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]')) return;
    const m = e.code.match(/^Digit([1-6])$/);
    if (e.altKey && m) { e.preventDefault(); showTab(TABS[+m[1] - 1]); return; }
    const typing = e.target.matches('input, textarea, select');
    if (!typing && e.key === '/') {
      const s = $(`#tab-${UI.tab} input[type="search"]`);
      if (s) { e.preventDefault(); s.focus(); s.select(); }
    }
    if (e.key === 'Escape' && e.target.matches('input[type="search"]') && e.target.value) {
      e.target.value = '';
      e.target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  /* ---------- start ---------- */
  renderWeekPickers();
  renderDatalist();
  renderData();
  showTab(location.hash.slice(1) || 'dashboard');
})();
