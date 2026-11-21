// Project Dashboard — reads the Master Project Tracker through an Apps Script web app.
const TZ = 'Asia/Riyadh';
// The Apps Script web app for the Master Project Tracker. Not secret: every request also needs the passcode.
const DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbzbjQXeJdfpKUuH4poh_AZ90A0awVHxe58Lc_jLUgoeuwiO1oDN6sK6cRNZNMDAuUgg/exec';
const REFRESH_MS = 5 * 60 * 1000;
const MAX_REC_MS = 5 * 60 * 1000;
const STATUSES = [
  { key: 'active', value: 'Active - Daily', label: 'Active daily', color: 'green' },
  { key: 'waiting', value: 'Waiting on External', label: 'Waiting', color: 'blue' },
  { key: 'hold', value: 'On Hold', label: 'On hold', color: 'amber' },
  { key: 'done', value: 'Completed', label: 'Completed', color: 'grey' },
];
const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };

// ---------- storage (never trusted to exist) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('pd.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pd.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('pd.' + k); } catch {} },
};

const state = {
  data: null,
  loading: false,
  lastSync: null,
  error: null,
  view: store.get('view', 'board'),
  filters: Object.assign({ q: '', category: '', priority: [], today: false, completed: false, sort: 'priority' }, store.get('filters', {}), { q: '' }),
  settings: Object.assign({ url: DEFAULT_URL, token: '', auto: true }, store.get('settings', {})),
  focus: null,
  group: null,       // overview → group drill-down (hash #g=active)
  audio: {},         // file id → { url, status: 'loading'|'ready'|'error', msg }
  playing: null,     // file id currently shown in the player
  rec: null,
  saving: new Set(),
};
const mock = window.__PD_MOCK__ || null; // local testing only; never shipped with data

// ---------- utilities ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attr = esc;

function nowRiyadh() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, mins: Number(parts.hour) * 60 + Number(parts.minute) };
}
const toUTC = d => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
const addDays = (d, n) => new Date(toUTC(d) + n * 864e5).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((toUTC(a) - toUTC(b)) / 864e5);
const fmtDate = (d, opts) => new Date(toUTC(d)).toLocaleDateString('en-GB', Object.assign({ timeZone: 'UTC' }, opts));
const safeFolder = name => String(name).replace(/[\\/:*?"<>|]/g, '-').trim();

function slotStart(slot) {
  const m = String(slot || '').match(/(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = Number(m[1]); const ap = (m[5] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + Number(m[2]);
}
const fmtClock = mins => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
function slotLabel(slot) {
  const s = slotStart(slot);
  return s == null ? '' : `${fmtClock(s)}–${fmtClock(s + 30)}`;
}
function statusOf(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.startsWith('complete') || s === 'archived') return STATUSES[3];
  if (s.includes('wait')) return STATUSES[1];
  if (s.includes('hold') || s.includes('pause')) return STATUSES[2];
  return STATUSES[0];
}

// ---------- derived data ----------
function derive() {
  const { date: today } = nowRiyadh();
  const d = state.data || { projects: [], log: [], voiceNotes: {} };
  const byProject = {};
  for (const e of d.log || []) (byProject[e.project] ||= []).push(e);
  const weekStart = addDays(today, -6);
  return d.projects.map(p => {
    const st = statusOf(p.status);
    const entries = (byProject[p.name] || []).slice().sort((a, b) => b.date.localeCompare(a.date));
    const daily = st.key === 'active';
    const goal = daily ? (Number(p.goal) || 30) : 0;
    const minsToday = entries.filter(e => e.date === today).reduce((s, e) => s + e.minutes, 0);
    const week = entries.filter(e => e.date >= weekStart).reduce((s, e) => s + e.minutes, 0);
    const dueIn = p.due ? diffDays(p.due, today) : null;
    return Object.assign({}, p, {
      st, daily, goal, minsToday, week, weekGoal: goal * 7, entries, dueIn,
      overdue: dueIn != null && dueIn < 0 && st.key !== 'done',
      start: daily ? slotStart(p.slot) : null,
      ring: !daily ? null : minsToday >= goal ? 'green' : minsToday > 0 ? 'amber' : 'red',
      voice: (d.voiceNotes || {})[safeFolder(p.name)] || [],
    });
  });
}

function applyFilters(list, { ignoreCompleted = false } = {}) {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return list.filter(p => {
    if (q && !p.name.toLowerCase().includes(q)) return false;
    if (f.category && p.category !== f.category) return false;
    if (f.priority.length && !f.priority.includes(p.priority)) return false;
    if (f.today && !(p.daily && p.start != null)) return false;
    if (!ignoreCompleted && !f.completed && p.st.key === 'done') return false;
    return true;
  });
}

function sortList(list, by = state.filters.sort) {
  const pr = p => PRIORITY_RANK[p.priority] ?? 3;
  const due = p => p.dueIn ?? 1e6;
  const slot = p => p.start ?? 1e6;
  const keys = { priority: [pr, due, slot], due: [due, pr, slot], slot: [slot, pr, due] }[by] || [pr];
  return list.slice().sort((a, b) => {
    for (const k of keys) { const d = k(a) - k(b); if (d) return d; }
    return a.name.localeCompare(b.name);
  });
}

// ---------- components ----------
function ring(p, size = '') {
  if (!p.daily) return '';
  const r = 18, c = 2 * Math.PI * r, pct = Math.min(1, p.minsToday / (p.goal || 30));
  const label = size === 'lg' ? `${p.minsToday}<small>of ${p.goal} min</small>` : `${p.minsToday}`;
  return `<div class="ring ${p.ring} ${size}" role="img" aria-label="${p.minsToday} of ${p.goal} minutes today">
    <svg viewBox="0 0 44 44"><circle class="track" cx="22" cy="22" r="${r}"/><circle class="val" cx="22" cy="22" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}" stroke-linecap="round"/></svg>
    <span>${label}</span></div>`;
}

const icons = {
  clock: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.5 1.5"/></svg>',
  flag: '<svg viewBox="0 0 20 20"><path d="M5 17V3.5M5 4h9l-2 3.5 2 3.5H5"/></svg>',
  cal: '<svg viewBox="0 0 20 20"><rect x="3.5" y="4.5" width="13" height="12" rx="2"/><path d="M3.5 8.5h13M7 3v3M13 3v3"/></svg>',
  mic: '<svg viewBox="0 0 20 20"><rect x="7.5" y="3" width="5" height="9" rx="2.5"/><path d="M5 9.5a5 5 0 0 0 10 0M10 14.5V17"/></svg>',
  stop: '<svg viewBox="0 0 20 20"><rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/></svg>',
  play: '<svg viewBox="0 0 20 20"><path d="M7 5.5v9l7-4.5-7-4.5Z"/></svg>',
  close: '<svg viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"/></svg>',
  check: '<svg viewBox="0 0 20 20"><path d="m5 10.5 3 3 7-7"/></svg>',
  dots: '<svg viewBox="0 0 20 20"><circle cx="5" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.3" fill="currentColor" stroke="none"/></svg>',
  back: '<svg viewBox="0 0 20 20"><path d="M12 15 7 10l5-5"/></svg>',
  chev: '<svg viewBox="0 0 20 20"><path d="m8 5 5 5-5 5"/></svg>',
};

function statusChip(p) {
  return `<span class="chip ${p.st.color === 'grey' ? '' : p.st.color}"><i class="status-dot"></i>${esc(p.st.label)}</span>`;
}
function dueChip(p) {
  if (p.dueIn == null || p.st.key === 'done') return '';
  const n = p.dueIn;
  if (n < 0) return `<span class="chip red">${icons.flag}${-n}d overdue</span>`;
  if (n === 0) return `<span class="chip amber">${icons.cal}Due today</span>`;
  if (n === 1) return `<span class="chip amber">${icons.cal}Due tomorrow</span>`;
  return `<span class="chip ${n <= 3 ? 'amber' : 'outline'}">${icons.cal}Due in ${n}d</span>`;
}
function slotChip(p) {
  const l = slotLabel(p.slot);
  return l ? `<span class="chip outline tnum">${icons.clock}${l}</span>` : '';
}
function micButton(p, big = false) {
  const rec = state.rec && state.rec.project === p.name;
  const busy = state.saving.has('voice:' + p.name);
  const label = rec ? `Stop recording for ${p.name}` : `Record a voice note for ${p.name}`;
  const btn = `<button class="mic ${rec ? 'rec' : ''} ${busy ? 'busy' : ''}" data-mic="${attr(p.name)}" aria-label="${attr(label)}" title="${rec ? 'Stop and save to Drive' : 'Record voice note'}">${rec ? icons.stop : icons.mic}</button>`;
  const time = rec ? `<span class="rec-time" data-rec-time>${recElapsed()}</span>` : busy ? `<span class="rec-time" style="color:var(--text-3)">Saving…</span>` : '';
  return big ? `<div class="focus-record">${btn}${time || '<span class="hint">Record a voice note. It saves to Drive and links here.</span>'}</div>` : `${time}${btn}`;
}
function latestVoice(p) {
  const v = p.voice[0];
  if (!v) return '';
  return `<button class="voice-link" data-play-latest="${attr(p.name)}" title="Play the latest voice note">${icons.play}Note${p.voice.length > 1 ? ` · ${p.voice.length}` : ''}</button>`;
}

function menuButton(p) {
  return `<button class="icon-btn card-menu" data-menu="${attr(p.name)}" aria-label="${attr('Actions for ' + p.name)}" aria-haspopup="menu" title="Move or other actions">${icons.dots}</button>`;
}
function card(p, { draggable = false, compact = false } = {}) {
  const weekPct = p.weekGoal ? Math.min(100, (p.week / p.weekGoal) * 100) : 0;
  const nextEmpty = !p.nextAction || p.nextAction === '—';
  return `<article class="card ${p.overdue ? 'overdue' : ''}" data-open="${attr(p.name)}" tabindex="0" ${draggable ? 'draggable="true"' : ''} aria-label="${attr(p.name)}">
    <div class="card-head">
      <div class="card-title">
        <h3>${esc(p.name)}</h3>
        <div class="card-meta"><span>${esc(p.category || 'Uncategorised')}</span><span class="dot">${esc(p.priority || '—')}</span></div>
      </div>
      ${ring(p)}
      ${menuButton(p)}
    </div>
    <div class="chips">${statusChip(p)}${slotChip(p)}${dueChip(p)}</div>
    <div class="actions-block">
      <div><div class="act-label">Next</div><div class="act-text next ${nextEmpty ? 'empty' : ''}">${nextEmpty ? 'No next action set' : esc(p.nextAction)}</div></div>
      ${p.lastAction && !compact ? `<div><div class="act-label">Last done</div><div class="act-text">${esc(p.lastAction)}</div></div>` : ''}
    </div>
    <div class="card-foot">
      ${p.daily ? `<span class="tile-mins ${p.ring}">${p.minsToday}/${p.goal}m</span>` : ''}
      ${p.daily ? `<div class="week"><div class="week-head"><span>This week</span><span class="tnum">${p.week} / ${p.weekGoal} min</span></div><div class="bar ${weekPct >= 100 ? 'green' : ''}"><i style="width:${weekPct}%"></i></div></div>` : '<div class="week"></div>'}
      ${latestVoice(p)}
      ${micButton(p)}
    </div>
  </article>`;
}

// ---------- views ----------
const GROUPS = [
  { key: 'active', label: 'Active daily', color: 'green', match: p => p.st.key === 'active' },
  { key: 'overdue', label: 'Overdue', color: 'red', match: p => p.overdue },
  { key: 'waiting', label: 'Waiting', color: 'blue', match: p => p.st.key === 'waiting' },
  { key: 'hold', label: 'On hold', color: 'amber', match: p => p.st.key === 'hold' },
  { key: 'done', label: 'Completed', color: 'grey', match: p => p.st.key === 'done' },
];

function viewBoard(list) {
  const all = applyFilters(list, { ignoreCompleted: true });
  const g = GROUPS.find(x => x.key === state.group);
  if (g) {
    const items = sortList(all.filter(g.match), state.filters.sort);
    return `<div class="group-head">
        <button class="btn ghost back" data-group="">${icons.back}Overview</button>
        <h2><i class="status-dot ${g.color}"></i>${g.label}<span class="count tnum">${items.length}</span></h2>
      </div>
      ${items.length ? `<div class="tiles">${items.map(p => card(p, { compact: true })).join('')}</div>`
        : `<div class="empty"><h2>Nothing here</h2><p>${state.filters.q || state.filters.category || state.filters.priority.length || state.filters.today ? 'No projects in this group match your filters.' : 'No projects are in this group right now.'}</p></div>`}`;
  }
  return `<div class="overview">${GROUPS.map(g => {
    const items = sortList(all.filter(g.match), 'priority');
    const daily = g.key === 'active' ? items : [];
    const goal = daily.reduce((s, p) => s + p.goal, 0), got = daily.reduce((s, p) => s + Math.min(p.minsToday, p.goal), 0);
    const doneToday = daily.filter(p => p.minsToday >= p.goal).length;
    const sub = g.key === 'active' ? `${doneToday} of ${items.length} done today`
      : g.key === 'overdue' ? (items.length ? 'Past their due date' : 'Nothing overdue')
      : g.key === 'done' ? 'Archived' : g.key === 'waiting' ? 'Blocked on someone else' : 'Paused';
    return `<button class="group-tile g-${g.key}" data-group="${g.key}" aria-label="${attr(`${g.label}, ${items.length} projects`)}">
      <div class="gt-top"><span class="gt-label"><i class="status-dot ${g.color}"></i>${g.label}</span>${icons.chev}</div>
      <div class="gt-count tnum ${g.key === 'overdue' && items.length ? 'red' : ''}">${items.length}</div>
      <div class="gt-sub">${sub}</div>
      ${g.key === 'active' && goal ? `<div class="bar ${got >= goal ? 'green' : ''}"><i style="width:${(got / goal) * 100}%"></i></div>` : ''}
      <ul class="gt-list">${items.slice(0, 4).map(p => `<li>${p.ring ? `<i class="mini-dot ${p.ring}"></i>` : ''}<span>${esc(p.name)}</span></li>`).join('')}${items.length > 4 ? `<li class="more">+${items.length - 4} more</li>` : ''}</ul>
    </button>`;
  }).join('')}</div>`;
}

function setGroup(key) {
  state.group = key || null;
  const h = key ? '#g=' + key : '';
  if (location.hash !== h) history.pushState(null, '', h || location.pathname + location.search);
  render();
  window.scrollTo(0, 0);
}
function groupFromHash() { const m = location.hash.match(/g=(\w+)/); return m && GROUPS.some(g => g.key === m[1]) ? m[1] : null; }

function viewGrid(list) {
  const items = sortList(applyFilters(list));
  return items.length ? `<div class="grid">${items.map(p => card(p)).join('')}</div>` : emptyFiltered();
}

function viewSchedule(list) {
  const { mins } = nowRiyadh();
  const items = applyFilters(list).filter(p => p.daily);
  const slotted = items.filter(p => p.start != null);
  const rows = [];
  for (let h = 6; h < 16; h++) {
    const start = h * 60, end = start + 60;
    const here = slotted.filter(p => p.start >= start && p.start < end);
    const isNow = mins >= start && mins < end;
    const nowLine = isNow ? `<div class="now-line" style="top:${((mins - start) / 60) * 100}%"></div>` : '';
    rows.push(`<div class="slot ${isNow ? 'now' : ''} ${mins >= end ? 'past' : ''}">
      <div class="slot-time">${fmtClock(start)}</div>
      <div class="slot-body">${here.length ? here.map(p => `<div class="slot-item" data-open="${attr(p.name)}" tabindex="0">
        ${ring(p)}<div class="grow"><h3>${esc(p.name)}</h3><p>${esc(p.nextAction && p.nextAction !== '—' ? p.nextAction : 'No next action set')}</p></div>
        <span class="chip outline tnum">${slotLabel(p.slot)}</span>${micButton(p)}</div>`).join('') : '<span class="slot-free">Free</span>'}</div>
      ${nowLine}</div>`);
  }
  const unslotted = sortList(items.filter(p => p.start == null), 'priority');
  const other = slotted.filter(p => p.start < 360 || p.start >= 960);
  const rest = unslotted.concat(other);
  return `<div class="schedule">${rows.join('')}</div>
    ${rest.length ? `<h3 class="section-title">Daily projects without a slot in 06:00–16:00 · ${rest.length}</h3>
    <div class="unslotted">${rest.map(p => `<div class="mini" data-open="${attr(p.name)}" tabindex="0">${ring(p)}<div class="grow"><b>${esc(p.name)}</b><small>${esc(p.priority)} · ${p.minsToday}/${p.goal} min</small></div></div>`).join('')}</div>` : ''}`;
}

function viewTimeline(list) {
  const { date: today } = nowRiyadh();
  const items = applyFilters(list).filter(p => p.due && p.st.key !== 'done');
  const overdue = sortList(items.filter(p => p.dueIn < 0), 'due');
  const days = Array.from({ length: 21 }, (_, i) => addDays(today, i));
  const later = items.filter(p => p.dueIn >= 21);
  const noDue = applyFilters(list).filter(p => !p.due && p.st.key !== 'done').length;
  const pill = p => `<button class="tl-pill p-${attr(p.priority)} ${p.overdue ? 'overdue' : ''}" data-open="${attr(p.name)}">${esc(p.name)}<small>${p.overdue ? `${-p.dueIn}d overdue · ` : ''}${esc(p.priority)}</small></button>`;
  const cols = [];
  if (overdue.length) cols.push(`<div class="tl-day overdue-col"><div class="tl-day-head">Before today<b>Overdue</b></div><div class="tl-items">${overdue.map(pill).join('')}</div></div>`);
  for (const d of days) {
    const its = sortList(items.filter(p => p.due === d), 'priority');
    const dow = new Date(toUTC(d)).getUTCDay();
    cols.push(`<div class="tl-day ${d === today ? 'today' : ''} ${dow === 5 || dow === 6 ? 'weekend' : ''}">
      <div class="tl-day-head">${fmtDate(d, { weekday: 'short' })}<b class="tnum">${fmtDate(d, { day: 'numeric', month: 'short' })}</b></div>
      <div class="tl-items">${its.map(pill).join('')}</div></div>`);
  }
  if (later.length) cols.push(`<div class="tl-day"><div class="tl-day-head">After ${fmtDate(days[20], { day: 'numeric', month: 'short' })}<b>Later</b></div><div class="tl-items">${sortList(later, 'due').map(pill).join('')}</div></div>`);
  return `<div class="timeline"><div class="tl-grid">${cols.join('')}</div></div>
    <p class="hint" style="margin-top:12px">${noDue ? `${noDue} open project${noDue === 1 ? ' has' : 's have'} no due date and ${noDue === 1 ? 'is' : 'are'} not shown. Add one in column L of the sheet.` : ''}</p>`;
}

function emptyFiltered() {
  return `<div class="empty"><h2>No projects match these filters</h2><p>Try a different search or clear the filters.</p><button class="btn" data-clear-filters>Clear filters</button></div>`;
}

function viewLock() {
  const s = state.settings;
  const custom = s.url && s.url !== DEFAULT_URL;
  return `<div class="lock">
    <div><h2>Sign in</h2><p style="margin-top:6px">Enter your dashboard passcode. It's kept only in this browser until you sign out.</p></div>
    <form id="lock-form">
      <div class="field"><label for="l-token">Passcode</label><input id="l-token" type="password" required autocomplete="current-password" autofocus value="${attr(s.token)}"></div>
      <details class="adv" ${custom ? 'open' : ''}><summary>Use a different Apps Script URL</summary>
        <div class="field" style="margin-top:10px"><label for="l-url">Apps Script web app URL</label><input id="l-url" type="url" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec" value="${attr(s.url || DEFAULT_URL)}"></div></details>
      <p class="field-error" id="l-error" role="alert">${esc(state.error || '')}</p>
      <div><button class="btn primary" type="submit" ${state.loading ? 'disabled' : ''}>${state.loading ? 'Signing in…' : 'Sign in'}</button></div>
    </form></div>`;
}

// ---------- header ----------
function renderHeader(list) {
  const { date } = nowRiyadh();
  $('#today').textContent = fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const daily = list.filter(p => p.daily);
  const overdue = list.filter(p => p.overdue).length;
  const done = daily.filter(p => p.minsToday >= p.goal).length;
  const goalSum = daily.reduce((s, p) => s + p.goal, 0);
  const got = daily.reduce((s, p) => s + Math.min(p.minsToday, p.goal), 0);
  const pct = goalSum ? Math.round((got / goalSum) * 100) : 0;
  $('#stats').innerHTML = state.data ? `
    <div><div class="stat-label">Active daily</div><div class="stat-value tnum">${daily.length}</div></div>
    <div><div class="stat-label">Overdue</div><div class="stat-value tnum ${overdue ? 'red' : ''}">${overdue}</div></div>
    <div><div class="stat-label">Done today</div><div class="stat-value tnum">${done}<small>/ ${daily.length}</small></div></div>
    <div class="goal-progress"><div class="goal-progress-head"><span>30-min goals today</span><span class="tnum"><b>${got}</b> / ${goalSum} min · ${pct}%</span></div>
      <div class="bar ${pct >= 100 ? 'green' : pct > 0 ? '' : ''}"><i style="width:${pct}%"></i></div></div>` : '';
  const sync = $('#sync');
  sync.className = 'sync' + (state.error && state.data ? ' err' : state.lastSync ? ' live' : '');
  sync.textContent = state.loading ? 'Syncing…' : state.error && state.data ? 'Sync failed' : state.lastSync ? `Synced ${state.lastSync.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })}` : '';
  $('#btn-refresh').classList.toggle('spinning', state.loading);

  const cats = [...new Set((state.data?.projects || []).map(p => p.category).filter(Boolean))].sort();
  const sel = $('#f-category');
  const want = ['<option value="">All categories</option>'].concat(cats.map(c => `<option ${c === state.filters.category ? 'selected' : ''}>${esc(c)}</option>`)).join('');
  if (sel.dataset.sig !== cats.join('|') + state.filters.category) { sel.innerHTML = want; sel.dataset.sig = cats.join('|') + state.filters.category; }
  document.querySelectorAll('#f-priority button').forEach(b => b.setAttribute('aria-pressed', state.filters.priority.includes(b.dataset.p)));
  $('#f-today').checked = state.filters.today;
  $('#f-completed').checked = state.filters.completed;
  $('#f-sort').value = state.filters.sort;
  document.querySelectorAll('.views button').forEach(b => b.setAttribute('aria-selected', b.dataset.view === state.view));
  document.body.dataset.view = state.view;
}

// ---------- render ----------
function render() {
  const list = derive();
  renderHeader(list);
  const main = $('#main');
  const locked = !state.data;
  document.body.classList.toggle('locked', locked);
  $('.toolbar').hidden = locked;
  $('#btn-signout').hidden = locked; $('#btn-refresh').hidden = locked;
  $('#stats').hidden = locked;
  if (locked) {
    if (state.loading && state.settings.url && state.settings.token && !state.error) {
      main.innerHTML = `<div class="grid">${'<div class="skel"></div>'.repeat(6)}</div>`;
    } else if (!$('#lock-form')) {
      main.innerHTML = viewLock();
    } else {
      $('#l-error').textContent = state.error || '';
      const b = $('#lock-form button[type=submit]');
      b.disabled = state.loading; b.textContent = state.loading ? 'Signing in…' : 'Sign in';
    }
    return;
  }
  const scroll = main.querySelector('.board, .timeline');
  const sx = scroll ? scroll.scrollLeft : 0;
  main.innerHTML = ({ board: viewBoard, grid: viewGrid, schedule: viewSchedule, timeline: viewTimeline }[state.view] || viewBoard)(list);
  const sc = main.querySelector('.board, .timeline'); if (sc) sc.scrollLeft = sx;
  if (state.focus) renderFocus(list);
}

// ---------- focus mode ----------
function renderFocus(list = derive()) {
  const p = list.find(x => x.name === state.focus);
  const el = $('#focus');
  if (!p) { closeFocus(); return; }
  const { date: today } = nowRiyadh();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const maxBar = Math.max(p.goal || 30, ...days.map(d => p.entries.filter(e => e.date === d).reduce((s, e) => s + e.minutes, 0)));
  const chart = days.map(d => {
    const m = p.entries.filter(e => e.date === d).reduce((s, e) => s + e.minutes, 0);
    return `<div class="wc-col ${d === today ? 'today' : ''}" title="${m} min on ${fmtDate(d, { day: 'numeric', month: 'short' })}">
      <div class="wc-bar ${m ? 'has' : ''} ${p.goal && m >= p.goal ? 'full' : ''}" style="height:${(m / maxBar) * 100}%"></div>
      <small>${fmtDate(d, { weekday: 'narrow' })}</small></div>`;
  }).join('');
  const saving = state.saving.has('status:' + p.name);
  const isDone = p.st.key === 'done';
  const nextEmpty = !p.nextAction || p.nextAction === '—';
  const scrollTop = el.querySelector('.focus-body')?.scrollTop || 0;
  const liveAudio = el.querySelector('audio');
  if (liveAudio) liveAudio.remove();
  el.innerHTML = `
    <div class="focus-head"><span class="crumb">${esc(p.id || '')} · Focus</span>
      <button class="icon-btn" data-close-focus aria-label="Close focus mode" title="Close (Esc)">${icons.close}</button></div>
    <div class="focus-body">
      <div class="focus-hero">${ring(p, 'lg')}
        <div class="grow"><h2 id="focus-title">${esc(p.name)}</h2>
          <div class="chips">${statusChip(p)}<span class="chip outline">${esc(p.priority || '—')}</span><span class="chip outline">${esc(p.category || '')}</span>${slotChip(p)}${dueChip(p)}</div></div></div>
      <div class="move-row">
        <label for="move-select">Move to</label>
        <select id="move-select" data-move="${attr(p.name)}" ${saving ? 'disabled' : ''}>${STATUSES.map(s => `<option value="${attr(s.value)}" ${p.st.key === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
        <button class="btn ${isDone ? '' : 'primary'}" data-set-status="${isDone ? 'Active - Daily' : 'Completed'}" ${saving ? 'disabled' : ''}>${icons.check}${saving ? 'Saving…' : isDone ? 'Reopen' : 'Mark completed'}</button>
      </div>
      <div class="focus-next"><div class="act-label">Next action</div><p class="${nextEmpty ? 'act-text empty' : ''}">${nextEmpty ? 'No next action set' : esc(p.nextAction)}</p>
        ${p.lastAction ? `<div class="last"><div class="act-label">Last completed</div>${esc(p.lastAction)}</div>` : ''}</div>
      <section class="focus-sec" id="voice-sec"><h4>Voice notes <span>${p.voice.length || ''}</span></h4>
        ${micButton(p, true)}
        ${p.voice.length ? `<div class="voice-list" style="margin-top:12px">${p.voice.map(v => voiceRow(v)).join('')}</div>` : ''}</section>
      ${p.daily ? `<section class="focus-sec"><h4>Last 7 days <span class="tnum">${p.week} / ${p.weekGoal} min</span></h4><div class="week-chart">${chart}</div></section>` : ''}
      <section class="focus-sec"><h4>Recent log <span>${p.entries.length ? 'last 30 days' : ''}</span></h4>
        ${p.entries.length ? `<div class="log-list">${p.entries.slice(0, 10).map(e => `<div class="log-item"><time>${fmtDate(e.date, { day: 'numeric', month: 'short' })}</time><div><p>${esc(e.work || '—')}</p>${e.next ? `<p>Next: ${esc(e.next)}</p>` : ''}</div><span class="m">${e.minutes} min</span></div>`).join('')}</div>` : '<div class="muted-box">No log entries in the last 30 days.</div>'}</section>
    </div>`;
  el.querySelector('.focus-body').scrollTop = scrollTop;
  const slot = liveAudio && el.querySelector(`[data-player="${liveAudio.dataset.id}"]`);
  if (slot) slot.replaceChildren(liveAudio);
  else mountPlayer();
}

// ---------- in-app voice playback ----------
function fmtWhen(iso) { return new Date(iso).toLocaleString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function voiceRow(v) {
  const a = v.id ? state.audio[v.id] : null;
  const open = v.id && state.playing === v.id;
  const status = !v.id ? '' : a?.status === 'loading' ? '<small>Loading…</small>' : a?.status === 'error' ? `<small class="err">${esc(a.msg)}</small>` : '';
  return `<div class="voice-row ${open ? 'open' : ''}">
    <button class="voice-play" ${v.id ? `data-play="${attr(v.id)}"` : 'disabled'} aria-label="${attr('Play ' + v.name)}">${icons.play}<span class="vn">${esc(fmtWhen(v.created))}</span>${status}</button>
    <a class="voice-drive" href="${attr(v.url)}" target="_blank" rel="noopener" title="Open in Google Drive">Drive</a>
    ${open ? `<div class="voice-player" data-player="${attr(v.id)}"></div>` : ''}
  </div>`;
}
function mountPlayer() {
  const id = state.playing, a = id && state.audio[id];
  const slot = id && document.querySelector(`#focus [data-player="${id}"]`);
  if (!slot || !a || a.status !== 'ready' || slot.querySelector('audio')) return;
  const el = document.createElement('audio');
  el.controls = true; el.preload = 'auto'; el.dataset.id = id; el.src = a.url;
  el.onerror = () => { state.audio[id] = { status: 'error', msg: "This browser can't play this format. Open it in Drive on a computer." }; state.playing = null; renderFocus(); };
  slot.replaceChildren(el);
  el.play().catch(() => {}); // iPhone may need a tap on the player's own play button
}
async function playVoice(id) {
  if (state.playing === id && document.querySelector('#focus audio')) { const el = document.querySelector('#focus audio'); el.paused ? el.play().catch(() => {}) : el.pause(); return; }
  document.querySelector('#focus audio')?.pause();
  state.playing = id;
  if (!state.audio[id] || state.audio[id].status === 'error') {
    state.audio[id] = { status: 'loading' }; renderFocus();
    try {
      const { mime, data } = await apiAudio(id);
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      state.audio[id] = { status: 'ready', url: URL.createObjectURL(new Blob([bytes], { type: mime })) };
    } catch (e) {
      state.audio[id] = { status: 'error', msg: /Unknown action/.test(e.message) ? 'Update the Apps Script to play notes here (see setup guide).' : "Couldn't load this note." };
      state.playing = null;
    }
  }
  renderFocus();
}

let lastOpener = null;
function openFocus(name, opener) {
  state.focus = name;
  lastOpener = opener || document.activeElement;
  $('#scrim').hidden = false;
  $('#focus').hidden = false;
  renderFocus();
  $('#focus [data-close-focus]').focus();
}
function closeFocus() {
  state.focus = null;
  $('#focus').hidden = true;
  if ($('#settings').hidden) $('#scrim').hidden = true;
  lastOpener?.focus?.();
}
function openSettings() {
  lastOpener = document.activeElement;
  const s = state.settings;
  $('#s-url').value = s.url || DEFAULT_URL; $('#s-token').value = s.token; $('#s-auto').checked = s.auto; $('#s-error').textContent = '';
  $('#scrim').hidden = false; $('#settings').hidden = false;
  $('#s-auto').focus();
}
function closeSettings() {
  $('#settings').hidden = true;
  if ($('#focus').hidden) $('#scrim').hidden = true;
  lastOpener?.focus?.();
}

// ---------- API ----------
async function apiRead(settings = state.settings) {
  if (mock) return JSON.parse(JSON.stringify(mock));
  const url = `${settings.url}${settings.url.includes('?') ? '&' : '?'}action=read&token=${encodeURIComponent(settings.token)}`;
  let res;
  try { res = await fetch(url, { redirect: 'follow' }); } catch { throw new Error("Couldn't reach the Apps Script. Check the URL and that the deployment's access is set to Anyone."); }
  const json = await res.json().catch(() => { throw new Error("The Apps Script didn't return data. Check you copied the web app URL ending in /exec."); });
  if (!json.ok) throw new Error(json.error === 'Wrong passcode' ? "That passcode doesn't match DASHBOARD_TOKEN in Script properties." : json.error || 'Unknown error from Apps Script');
  return json;
}
async function apiAudio(id) {
  if (mock) throw new Error('No audio in sample mode');
  const s = state.settings;
  const res = await fetch(`${s.url}?action=audio&id=${encodeURIComponent(id)}&token=${encodeURIComponent(s.token)}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Could not load audio');
  return json;
}
async function apiPost(body) {
  if (mock) { await new Promise(r => setTimeout(r, 400)); return body.action === 'voice' ? { ok: true, id: 'mock' + Date.now(), name: `${body.project} — test.webm`, url: '#', created: new Date().toISOString() } : { ok: true }; }
  const res = await fetch(state.settings.url, { method: 'POST', body: JSON.stringify(Object.assign({ token: state.settings.token }, body)) });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Write failed');
  return json;
}

async function refresh({ quiet = false } = {}) {
  if (!mock && (!state.settings.url || !state.settings.token)) { render(); return; }
  if (state.loading) return;
  state.loading = true; if (!quiet) render();
  try {
    state.data = await apiRead();
    state.lastSync = new Date();
    state.error = null;
  } catch (e) {
    state.error = e.message;
    if (state.data) toast(`Refresh failed. ${e.message}`, { err: true });
  } finally {
    state.loading = false;
    render();
  }
}

let timer = null;
function schedule() {
  clearInterval(timer);
  if (state.settings.auto) timer = setInterval(() => { if (!document.hidden) refresh({ quiet: true }); }, REFRESH_MS);
}

// ---------- write-back: status ----------
async function setStatus(name, value, { undo = true } = {}) {
  const p = state.data.projects.find(x => x.name === name);
  if (!p || p.status === value) return;
  const prev = p.status;
  p.status = value;
  state.saving.add('status:' + name);
  render();
  try {
    await apiPost({ action: 'status', project: name, status: value });
    toast(`${name} moved to ${statusOf(value).label}.`, undo ? { action: 'Undo', onAction: () => setStatus(name, prev, { undo: false }) } : {});
  } catch (e) {
    p.status = prev;
    toast(`Couldn't update ${name}. ${e.message}`, { err: true });
  } finally {
    state.saving.delete('status:' + name);
    render();
  }
}

// ---------- voice notes ----------
function recElapsed() {
  if (!state.rec) return '0:00';
  const s = Math.floor((Date.now() - state.rec.started) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
async function toggleRecording(name) {
  if (state.rec) {
    const same = state.rec.project === name;
    state.rec.recorder.stop();
    if (same) return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast('This browser cannot record audio.', { err: true }); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { toast('Microphone access was blocked. Allow it in the browser address bar and try again.', { err: true }); return; }
  const mime = // AAC in MP4 first: it plays everywhere, including iPhone and Google Drive's previewer.
  ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported?.(t)) || '';
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(state.rec?.tick); clearTimeout(state.rec?.limit);
    state.rec = null;
    const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
    if (blob.size < 1000) { toast('Recording was too short to save.'); render(); return; }
    state.saving.add('voice:' + name); render();
    try {
      const data = await blobToBase64(blob);
      const file = await apiPost({ action: 'voice', project: name, mime: blob.type, data });
      const key = safeFolder(name);
      state.data.voiceNotes ||= {};
      (state.data.voiceNotes[key] ||= []).unshift({ id: file.id, name: file.name, url: file.url, created: file.created });
      if (file.id) state.audio[file.id] = { status: 'ready', url: URL.createObjectURL(blob) };
      toast(`Voice note saved for ${name}.`, file.id ? { action: 'Play', onAction: () => { if (state.focus !== name) openFocus(name); playVoice(file.id); } } : {});
    } catch (e) {
      toast(`Couldn't save the voice note. ${e.message}`, { err: true });
    } finally {
      state.saving.delete('voice:' + name); render();
    }
  };
  recorder.start(1000);
  state.rec = {
    project: name, recorder, started: Date.now(),
    tick: setInterval(() => document.querySelectorAll('[data-rec-time]').forEach(el => (el.textContent = recElapsed())), 500),
    limit: setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), MAX_REC_MS),
  };
  render();
}
const blobToBase64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(new Error('Could not read the recording'));
  r.readAsDataURL(blob);
});

// ---------- toasts ----------
function toast(msg, { err = false, action, onAction } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.setAttribute('role', err ? 'alert' : 'status');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.remove(); onAction(); };
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), err ? 7000 : 5000);
}

// ---------- theme ----------
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('pd.theme', next); } catch {}
}

// ---------- events ----------
function saveFilters() { store.set('filters', Object.assign({}, state.filters, { q: '' })); render(); }

function bind() {
  document.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('[data-stop]')) { e.stopPropagation(); return; }
    const mi = t.closest('#menu [data-menu-status]');
    if (mi) { const n = menuFor; closeMenu(); setStatus(n, mi.dataset.menuStatus); return; }
    const mo = t.closest('#menu [data-menu-open]');
    if (mo) { const n = menuFor; closeMenu(); openFocus(n); return; }
    const mr = t.closest('#menu [data-menu-rec]');
    if (mr) { const n = menuFor; closeMenu(); toggleRecording(n); return; }
    if (menuFor && !t.closest('#menu')) { const same = t.closest('[data-menu]')?.dataset.menu === menuFor; closeMenu(); if (same) return; }
    const mb = t.closest('[data-menu]');
    if (mb) { openMenu(mb.dataset.menu, mb); return; }
    const pl = t.closest('[data-play]');
    if (pl) { playVoice(pl.dataset.play); return; }
    const pll = t.closest('[data-play-latest]');
    if (pll) { const name = pll.dataset.playLatest; openFocus(name, pll); const v = derive().find(x => x.name === name)?.voice[0]; if (v?.id) playVoice(v.id); $('#voice-sec')?.scrollIntoView({ block: 'start' }); return; }
    const gb = t.closest('[data-group]');
    if (gb) { setGroup(gb.dataset.group); return; }
    const mic = t.closest('[data-mic]');
    if (mic) { e.stopPropagation(); toggleRecording(mic.dataset.mic); return; }
    const ss = t.closest('[data-set-status]');
    if (ss && state.focus) { setStatus(state.focus, ss.dataset.setStatus); return; }
    if (t.closest('[data-close-focus]')) { closeFocus(); return; }
    if (t.closest('#settings [data-close]')) { closeSettings(); return; }
    if (t.closest('[data-show-completed]')) { state.filters.completed = true; saveFilters(); return; }
    if (t.closest('[data-clear-filters]')) { Object.assign(state.filters, { q: '', category: '', priority: [], today: false }); $('#f-search').value = ''; saveFilters(); return; }
    const open = t.closest('[data-open]');
    if (open && !justDragged) { openFocus(open.dataset.open, open); return; }
    const v = t.closest('.views button');
    if (v) { state.view = v.dataset.view; store.set('view', state.view); if (v.dataset.view === 'board' && state.group) { setGroup(null); return; } render(); return; }
    const pb = t.closest('#f-priority button');
    if (pb) { const f = state.filters.priority; const i = f.indexOf(pb.dataset.p); i < 0 ? f.push(pb.dataset.p) : f.splice(i, 1); saveFilters(); }
  });
  document.addEventListener('change', e => { if (e.target.matches('#move-select')) setStatus(e.target.dataset.move, e.target.value); });
  window.addEventListener('popstate', () => { state.group = groupFromHash(); render(); });
  window.addEventListener('resize', closeMenu);
  document.addEventListener('scroll', closeMenu, true);
  $('#scrim').addEventListener('click', () => { if (!$('#settings').hidden) closeSettings(); else closeFocus(); });
  $('#btn-refresh').onclick = () => refresh();
  $('#btn-theme').onclick = toggleTheme;
  $('#btn-settings').onclick = openSettings;
  $('#f-search').addEventListener('input', e => { state.filters.q = e.target.value; render(); });
  $('#f-category').addEventListener('change', e => { state.filters.category = e.target.value; saveFilters(); });
  $('#f-today').addEventListener('change', e => { state.filters.today = e.target.checked; saveFilters(); });
  $('#f-completed').addEventListener('change', e => { state.filters.completed = e.target.checked; saveFilters(); });
  $('#f-sort').addEventListener('change', e => { state.filters.sort = e.target.value; saveFilters(); });

  const connect = async (url, token, errEl, auto) => {
    url = url.trim(); token = token.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { errEl.textContent = 'Paste the web app URL from Apps Script. It starts with https://script.google.com/macros/s/'; return false; }
    if (!token) { errEl.textContent = 'Enter your passcode.'; return false; }
    const settings = Object.assign({}, state.settings, { url, token }, auto == null ? {} : { auto });
    state.loading = true; state.error = null; render();
    try {
      state.data = await apiRead(settings);
      state.settings = settings; store.set('settings', settings);
      state.lastSync = new Date(); state.error = null; schedule();
      return true;
    } catch (e) { state.error = e.message; errEl.textContent = e.message; return false; }
    finally { state.loading = false; render(); }
  };
  document.addEventListener('submit', async e => {
    if (e.target.id === 'lock-form') { e.preventDefault(); await connect($('#l-url').value || DEFAULT_URL, $('#l-token').value, $('#l-error')); }
  });
  $('#settings-form').addEventListener('submit', async e => {
    e.preventDefault();
    const auto = $('#s-auto').checked;
    if ($('#s-url').value.trim() === state.settings.url && $('#s-token').value.trim() === state.settings.token && state.data) {
      state.settings.auto = auto; store.set('settings', state.settings); schedule(); closeSettings(); toast(auto ? 'Auto-refresh is on.' : 'Auto-refresh is off.'); return;
    }
    if (await connect($('#s-url').value, $('#s-token').value, $('#s-error'), auto)) { closeSettings(); toast('Signed in.'); }
  });
  $('#btn-signout').onclick = () => $('#s-signout').click();
  $('#s-signout').addEventListener('click', () => {
    state.settings = { url: DEFAULT_URL, token: '', auto: true }; store.del('settings'); state.data = null; state.error = null; state.lastSync = null;
    clearInterval(timer); closeSettings(); closeFocus(); $('#main').innerHTML = ''; render();
  });

  // Drag between Kanban columns → status write-back
  let dragName = null; var justDragged = false;
  document.addEventListener('dragstart', e => {
    const c = e.target.closest?.('.card[draggable]'); if (!c) return;
    dragName = c.dataset.open; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragName);
  });
  document.addEventListener('dragend', e => { e.target.classList?.remove('dragging'); document.querySelectorAll('.col.drop').forEach(c => c.classList.remove('drop')); justDragged = true; setTimeout(() => (justDragged = false), 50); });
  document.addEventListener('dragover', e => { const col = e.target.closest?.('.col'); if (col && dragName) { e.preventDefault(); document.querySelectorAll('.col.drop').forEach(c => c !== col && c.classList.remove('drop')); col.classList.add('drop'); } });
  document.addEventListener('drop', e => {
    const col = e.target.closest?.('.col'); if (!col || !dragName) return;
    e.preventDefault(); const name = dragName; dragName = null; setStatus(name, col.dataset.col);
  });

  // Keyboard
  document.addEventListener('keydown', e => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
    const overlay = !$('#focus').hidden ? $('#focus') : !$('#settings').hidden ? $('#settings') : null;
    if (e.key === 'Escape' && menuFor) { closeMenu(true); return; }
    if (e.key === 'Escape') { if (!$('#settings').hidden) closeSettings(); else if (state.focus) closeFocus(); else if (document.activeElement === $('#f-search')) $('#f-search').blur(); return; }
    if (e.key === 'Tab' && overlay) {
      const f = [...overlay.querySelectorAll('button:not([disabled]), a[href], input, select, [tabindex="0"]')].filter(x => x.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.matches?.('[data-open][tabindex]')) { e.preventDefault(); openFocus(document.activeElement.dataset.open, document.activeElement); return; }
    if (typing || overlay || e.metaKey || e.ctrlKey || e.altKey || !state.data) return;
    if (e.key === '/') { e.preventDefault(); $('#f-search').focus(); }
    else if (e.key === 'r') refresh();
    else if (e.key === 't') toggleTheme();
    else if (['1', '2', '3', '4'].includes(e.key)) { state.view = ['board', 'grid', 'schedule', 'timeline'][e.key - 1]; store.set('view', state.view); render(); }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.data && state.settings.auto && Date.now() - (state.lastSync || 0) > REFRESH_MS) refresh({ quiet: true });
  });
  setInterval(() => { if (state.data && !state.rec) render(); }, 60 * 1000); // keep "now" line and dates current
}

// ---------- card action menu ----------
let menuFor = null, menuOpener = null;
function openMenu(name, btn) {
  const p = derive().find(x => x.name === name); if (!p) return;
  menuFor = name; menuOpener = btn;
  const m = $('#menu');
  m.innerHTML = `<div class="menu-label">Move to</div>
    ${STATUSES.map(s => `<button role="menuitem" data-menu-status="${attr(s.value)}" ${p.st.key === s.key ? 'aria-current="true" disabled' : ''}><i class="status-dot ${s.color}"></i>${s.label}${p.st.key === s.key ? `<span class="cur">${icons.check}</span>` : ''}</button>`).join('')}
    <hr>
    <button role="menuitem" data-menu-rec>${icons.mic}${state.rec?.project === name ? 'Stop recording' : 'Record voice note'}</button>
    <button role="menuitem" data-menu-open>${icons.chev}Open details</button>`;
  m.hidden = false;
  const r = btn.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  let left = Math.min(Math.max(8, r.right - mw), innerWidth - mw - 8);
  let top = r.bottom + 6; if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  m.style.left = left + 'px'; m.style.top = top + 'px';
  btn.setAttribute('aria-expanded', 'true');
  m.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
}
function closeMenu(restore) {
  if (!menuFor) return;
  menuFor = null; $('#menu').hidden = true;
  menuOpener?.setAttribute('aria-expanded', 'false');
  if (restore === true) menuOpener?.focus();
}

state.group = groupFromHash();
bind();
schedule();
refresh();
