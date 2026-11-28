/**
 * Project Dashboard — Apps Script backend
 * Paste this into Extensions → Apps Script of the Master Project Tracker sheet.
 *
 * It does three things for the dashboard:
 *   GET  ?action=read&token=…      → projects (Tab 1), recent log (Tab 2), voice-note list
 *   GET  ?action=audio&id=…&token=… → one voice note's audio (base64) for in-app playback
 *   POST {action:'status', …}      → writes ONLY column E (Current Status) of one project row
 *   POST {action:'voice', …}       → saves an audio file to Drive:
 *                                    Al-Marfat/Project Voice Notes/<Project Name>/
 *   POST {action:'subReminder', …} → sets the Reminder Date of one subscription and syncs its
 *                                    Google Calendar reminder
 *
 * MOMENTUM DEFERRAL (run setupMomentumDeferral() once from the editor):
 *   A "momentum day" is a day on which one project got 2× or more of its Daily Goal (60+ min on a
 *   30-min goal). On that day, every project you did NOT touch is deferred instead of neglected:
 *   Today's Goal Status shows "⏸ Deferred" instead of "🔴 Pending", and the day is not added to its
 *   Days Since Logged (so Priority Score, Today's Pick and ⚠ NEGLECTED don't jump). Next day, normal
 *   tracking resumes. Honesty limits, built into the formulas:
 *     • Same project 2× two days in a row: only the first day counts. A streak is not momentum.
 *     • Due dates are never deferred: a project due today or overdue keeps 🔴 Pending / 🚨 OVERDUE.
 *     • Projects you touched (but under goal) stay ⏳ Partial; deferral is only for untouched ones.
 *     • It starts on the day you first run it (kept in Script property MOMENTUM_START); history isn't rewritten.
 *   It adds a formula column "Momentum Day" (⚡) to the Daily Voice Log and rewrites the formulas in
 *   Days Since Logged, Today's Goal Status and Reminder Alert on Active Projects. Nothing else changes.
 *
 * SUBSCRIPTIONS ("Subscription Dashboard" tab):
 *   Run setupSubscriptionDashboard() once from the editor. It adds the tab (if missing) with its
 *   headers and dropdowns, and installs two triggers: a daily sync and an on-edit sync. Whenever a
 *   row has a Reminder Date, a Google Calendar event is created in the calendar of the account that
 *   owns this script, at 9:00 AM Riyadh time on that date, with a pop-up and an email reminder.
 *   The event id is kept in the hidden "Calendar Event ID" column, so reminders are never duplicated:
 *   changing the date moves the event, clearing it deletes the event.
 *
 * Columns are found by their header text, so new sheet columns (Priority Score, Days Since Logged,
 * Today's Pick, Voice Log Link, Claude Location, Tech Stack & Links) are picked up automatically. Only the Current Status cell is written;
 * formula columns and the Daily Voice Log are never written.
 *
 * SETUP: Project Settings (gear icon) → Script properties → add
 *   DASHBOARD_TOKEN = a passcode you choose (you'll type the same one in the dashboard)
 */

const PROJECTS_TAB = 'Active Projects';
const LOG_TAB = 'Daily Voice Log';
const FIRST_DATA_ROW = 3;          // row 1 = summary banner, row 2 = headers
const STATUS_COL = 5;              // column E: fallback if the "Current Status" header isn't found
const TZ = 'Asia/Riyadh';
const LOG_DAYS = 30;               // how much log history to send to the dashboard
const VOICE_ROOT = ['Al-Marfat', 'Project Voice Notes'];
const ALLOWED_STATUSES = ['Active - Daily', 'Waiting on External', 'On Hold', 'Completed'];

const SUBS_TAB = 'Subscription Dashboard';
const SUBS_HEADERS = ['Service', 'Nature', 'Account / Email', 'Start Date', 'End Date', 'Amount Paid',
  'Action on Expiry', 'Reminder Date', 'Calendar Reminder', 'Action Taken', 'Status', 'Notes', 'Calendar Event ID'];
const SUBS_NATURES = ['Paid', 'Trial', 'Free', 'Complimentary'];
const SUBS_ACTIONS = ['Renew', 'Cancel', 'Downgrade', 'Upgrade', 'Switch to free', 'Decide'];
const SUBS_STATUSES = ['Active', 'Expired', 'Cancelled', 'Renewed'];
const REMINDER_HOUR = 9;           // Calendar reminders sit at 9:00 AM Riyadh time on the Reminder Date

function doGet(e) {
  return handle_(() => {
    checkToken_(e.parameter.token);
    const action = e.parameter.action || 'read';
    if (action === 'read') return read_();
    if (action === 'ping') return { ok: true };
    if (action === 'audio') return audio_(e.parameter.id);
    throw new Error('Unknown action: ' + action);
  });
}

function doPost(e) {
  return handle_(() => {
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    checkToken_(body.token);
    if (body.action === 'status') return setStatus_(body.project, body.status);
    if (body.action === 'voice') return saveVoice_(body.project, body.mime, body.data);
    if (body.action === 'subReminder') return setSubReminder_(body.row, body.service, body.date);
    throw new Error('Unknown action: ' + body.action);
  });
}

// ---------- read ----------

// Tab 1 columns are found by their header text (row 2), so the sheet can gain, lose or reorder
// columns without breaking the dashboard. The numbers are the old fixed positions, used only
// when a header can't be found. -1 = no fallback (column is optional).
const P_COLS = {
  id:            [/^(project )?id$/i, 0],
  name:          [/project name|^name$/i, 1],
  category:      [/category/i, 2],
  priority:      [/^priority$/i, 3],
  status:        [/status/i, 4, /goal status/i],
  goal:          [/daily goal/i, -1],
  priorityScore: [/priority score|score/i, -1],
  daysSince:     [/days since/i, -1],
  slot:          [/time slot|slot/i, -1],
  minsToday:     [/minutes logged|mins today|minutes today/i, -1],
  goalStatus:    [/goal status/i, -1],
  lastAction:    [/last action/i, 9],
  nextAction:    [/next action/i, 10],
  due:           [/due|follow.?up date/i, 11],
  alert:         [/reminder|alert/i, -1],
  todayPick:     [/today'?s pick|pick/i, -1],
  voiceLink:     [/voice/i, -1],
  claudeLocation:[/claude location|where.*claude/i, -1],
  techStack:     [/tech stack|stack/i, -1],
};
const L_COLS = {
  date:      [/^date$/i, 0],
  project:   [/project/i, 1],
  minutes:   [/minute/i, 2],
  work:      [/work completed|work/i, 3],
  next:      [/next/i, 4],
  notes:     [/note|blocker/i, 5, /voice/i],
  voiceLink: [/voice/i, -1],
  momentum:  [/momentum/i, -1],
};

function colMap_(headers, spec) {
  const h = headers.map(x => String(x || '').trim());
  const used = {};
  const out = {};
  Object.keys(spec).forEach(k => {
    const [re, fallback, not] = spec[k];
    let i = h.findIndex((x, j) => x && re.test(x) && !(not && not.test(x)) && !used[j]);
    if (i === -1 && fallback >= 0 && fallback < h.length && !h[fallback]) i = fallback; // blank header: trust the old position
    if (i === -1 && fallback >= 0 && !h.some(Boolean)) i = fallback;
    out[k] = i;
    if (i >= 0 && k !== 'voiceLink') used[i] = true;
  });
  return out;
}

// A link cell may hold a HYPERLINK() formula, rich-text link, or a bare URL.
function linkOf_(display, formula, rich) {
  const f = String(formula || '');
  const m = f.match(/HYPERLINK\(\s*"([^"]+)"/i);
  if (m) return m[1];
  if (rich) {
    const u = rich.getLinkUrl && rich.getLinkUrl();
    if (u) return u;
    const runs = rich.getRuns ? rich.getRuns() : [];
    for (const r of runs) { const ru = r.getLinkUrl(); if (ru) return ru; }
  }
  const t = String(display || '').trim();
  return /^https?:\/\//i.test(t) ? t : '';
}

function read_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(PROJECTS_TAB);
  const last = sh.getLastRow();
  const width = Math.max(13, sh.getLastColumn());
  const projects = [];
  if (last >= FIRST_DATA_ROW) {
    const n = last - FIRST_DATA_ROW + 1;
    const c = colMap_(sh.getRange(FIRST_DATA_ROW - 1, 1, 1, width).getDisplayValues()[0], P_COLS);
    const rng = sh.getRange(FIRST_DATA_ROW, 1, n, width);
    const display = rng.getDisplayValues();
    const raw = rng.getValues();
    const vCol = c.voiceLink;
    const vForm = vCol >= 0 ? sh.getRange(FIRST_DATA_ROW, vCol + 1, n, 1).getFormulas() : null;
    const vRich = vCol >= 0 ? sh.getRange(FIRST_DATA_ROW, vCol + 1, n, 1).getRichTextValues() : null;
    const d = (r, k) => (c[k] >= 0 ? r[c[k]] : '');
    const num = (i, k) => { if (c[k] < 0) return null; const v = raw[i][c[k]]; return v === '' || v == null || isNaN(Number(v)) ? null : Number(v); };
    display.forEach((r, i) => {
      if (!d(r, 'name')) return;
      const dueRaw = c.due >= 0 ? raw[i][c.due] : '';
      projects.push({
        row: FIRST_DATA_ROW + i,
        id: d(r, 'id'),
        name: d(r, 'name'),
        category: d(r, 'category'),
        priority: d(r, 'priority'),
        status: d(r, 'status'),
        goal: num(i, 'goal') || 0,
        slot: d(r, 'slot'),
        priorityScore: num(i, 'priorityScore'),    // formula column (read only)
        daysSince: num(i, 'daysSince'),            // formula column (read only)
        minsTodaySheet: num(i, 'minsToday') || 0,  // formula column (read only)
        goalStatusSheet: d(r, 'goalStatus'),        // formula column (read only)
        lastAction: d(r, 'lastAction'),
        nextAction: d(r, 'nextAction'),
        due: dueRaw instanceof Date ? fmt_(dueRaw) : '',
        alertSheet: d(r, 'alert'),                  // formula column (read only)
        todayPick: d(r, 'todayPick'),               // formula column (read only)
        voiceLink: vCol >= 0 ? linkOf_(r[vCol], vForm[i][0], vRich[i][0]) : '',
        claudeLocation: d(r, 'claudeLocation'),     // free text, may contain a claude.ai link
        techStack: d(r, 'techStack'),               // free text: repo, hosting, account, domain
      });
    });
  }

  const log = [];
  const lg = ss.getSheetByName(LOG_TAB);
  const lastLog = lg.getLastRow();
  if (lastLog >= 2) {
    const lw = Math.max(6, lg.getLastColumn());
    const c = colMap_(lg.getRange(1, 1, 1, lw).getDisplayValues()[0], L_COLS);
    const cutoff = new Date(Date.now() - LOG_DAYS * 864e5);
    const rng = lg.getRange(2, 1, lastLog - 1, lw);
    const vals = rng.getValues();
    const vCol = c.voiceLink;
    const vDisp = vCol >= 0 ? lg.getRange(2, vCol + 1, lastLog - 1, 1).getDisplayValues() : null;
    const vForm = vCol >= 0 ? lg.getRange(2, vCol + 1, lastLog - 1, 1).getFormulas() : null;
    const vRich = vCol >= 0 ? lg.getRange(2, vCol + 1, lastLog - 1, 1).getRichTextValues() : null;
    const g = (r, k) => (c[k] >= 0 ? r[c[k]] : '');
    vals.forEach((r, i) => {
      const date = g(r, 'date');
      if (!(date instanceof Date) || !g(r, 'project') || date < cutoff) return;
      log.push({ date: fmt_(date), project: String(g(r, 'project')), minutes: Number(g(r, 'minutes')) || 0,
                 work: String(g(r, 'work') || ''), next: String(g(r, 'next') || ''), notes: String(g(r, 'notes') || ''),
                 voiceLink: vCol >= 0 ? linkOf_(vDisp[i][0], vForm[i][0], vRich[i][0]) : '',
                 momentum: c.momentum >= 0 && String(r[c.momentum]).indexOf('⚡') >= 0 });
    });
  }

  const subs = readSubs_();
  const momentumToday = log.some(l => l.momentum && l.date === fmt_(new Date()));
  return { ok: true, version: 4, momentumToday, generatedAt: new Date().toISOString(), projects, log, voiceNotes: listVoiceNotes_(),
           subscriptions: subs.rows, subsTab: subs.exists };
}

function listVoiceNotes_() {
  const out = {};
  const root = findFolder_(VOICE_ROOT, false);
  if (!root) return out;
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    const files = [];
    const it = f.getFiles();
    while (it.hasNext()) {
      const file = it.next();
      files.push({ id: file.getId(), name: file.getName(), url: file.getUrl(), mime: file.getMimeType(), created: file.getDateCreated().toISOString() });
    }
    files.sort((a, b) => b.created.localeCompare(a.created));
    if (files.length) out[f.getName()] = files.slice(0, 10);
  }
  return out;
}

// ---------- write: status ----------

function setStatus_(project, status) {
  if (ALLOWED_STATUSES.indexOf(status) === -1) throw new Error('Status not allowed: ' + status);
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PROJECTS_TAB);
    const last = sh.getLastRow();
    const c = colMap_(sh.getRange(FIRST_DATA_ROW - 1, 1, 1, Math.max(13, sh.getLastColumn())).getDisplayValues()[0], P_COLS);
    const statusCol = c.status >= 0 ? c.status + 1 : STATUS_COL;
    const nameCol = c.name >= 0 ? c.name + 1 : 2;
    const names = sh.getRange(FIRST_DATA_ROW, nameCol, last - FIRST_DATA_ROW + 1, 1).getDisplayValues();
    const idx = names.findIndex(r => r[0] === project);
    if (idx === -1) throw new Error('Project not found: ' + project);
    sh.getRange(FIRST_DATA_ROW + idx, statusCol).setValue(status);   // the Current Status column only
    return { ok: true, project, status };
  } finally {
    lock.releaseLock();
  }
}

// ---------- momentum deferral ----------

const MOMENTUM_HEADER = 'Momentum Day';
const MOMENTUM_MARK = '⚡';

function colLetter_(i) { // 0-based index → A1 letters
  let n = i + 1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * Run once from the editor (safe to run again). Adds the "Momentum Day" column to the Daily Voice Log
 * and rewrites three formula columns on Active Projects so momentum days defer untouched projects.
 */
function setupMomentumDeferral() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lg = ss.getSheetByName(LOG_TAB);
  const sh = ss.getSheetByName(PROJECTS_TAB);
  const L = "'" + LOG_TAB + "'!";
  const P = "'" + PROJECTS_TAB + "'!";

  // 1) Daily Voice Log: one array formula in the header cell marks ⚡ on every log row of a momentum day.
  const lw = Math.max(7, lg.getLastColumn());
  const lc = colMap_(lg.getRange(1, 1, 1, lw).getDisplayValues()[0], L_COLS);
  ['date', 'project', 'minutes'].forEach(k => { if (lc[k] < 0) throw new Error('Daily Voice Log: column not found: ' + k); });
  let mCol = lc.momentum;
  if (mCol < 0) {
    const heads = lg.getRange(1, 1, 1, lw).getDisplayValues()[0];
    let lastHead = -1; heads.forEach((h, i) => { if (String(h).trim()) lastHead = i; });
    mCol = lastHead + 1;
  }
  // The ⚡ marks spill down from the header cell, so nothing else may be typed below it.
  const below = lg.getRange(2, mCol + 1, Math.max(1, lg.getMaxRows() - 1), 1);
  const typed = below.getFormulas().some(r => r[0]) ||
    below.getValues().some(r => r[0] !== '' && (lc.momentum < 0 || String(r[0]) !== MOMENTUM_MARK));
  if (typed) throw new Error('Daily Voice Log column ' + colLetter_(mCol) + ' has entries below the header. Clear them, then run again.');
  const A = colLetter_(lc.date), B = colLetter_(lc.project), C = colLetter_(lc.minutes);
  // Deferral starts on the day this is first switched on; past days are not rewritten.
  const props = PropertiesService.getScriptProperties();
  let start = props.getProperty('MOMENTUM_START');
  if (!start) { start = fmt_(new Date()); props.setProperty('MOMENTUM_START', start); }
  const [sy, sm, sd] = start.split('-').map(Number);
  // MAP walks the log row by row: d = that row's date, p = its project.
  const col2 = x => x + '2:' + x;
  const momentum =
    '={"' + MOMENTUM_HEADER + '";MAP(' + col2(A) + ',' + col2(B) + ',LAMBDA(d,p,IF(OR(d="",d<DATE(' + sy + ',' + sm + ',' + sd + ')),"",LET(' +
      'g,IFERROR(VLOOKUP(p,' + P + 'B3:F,5,FALSE)*1,0),' +
      't,SUMIFS(' + col2(C) + ',' + col2(A) + ',d,' + col2(B) + ',p),' +
      'y,SUMIFS(' + col2(C) + ',' + col2(A) + ',d-1,' + col2(B) + ',p),' +
      'IF((g>0)*(t>=2*g)*(y<2*g),"' + MOMENTUM_MARK + '","")))))}';
  // Active Projects B and F are referenced by letter in the formula above; check they're still there.
  const pc = colMap_(sh.getRange(FIRST_DATA_ROW - 1, 1, 1, Math.max(13, sh.getLastColumn())).getDisplayValues()[0], P_COLS);
  const pHeads = sh.getRange(FIRST_DATA_ROW - 1, 1, 1, 6).getDisplayValues()[0];
  if (!/name/i.test(pHeads[1]) || !/goal/i.test(pHeads[5])) throw new Error('Active Projects: expected Project Name in B and Daily Goal in F.');
  lg.getRange(1, mCol + 1).setFormula(momentum)
    .setNote('Formula column. ⚡ = a momentum day: one project got 2× its daily goal (and did not also get 2× the day before). ' +
             'On ⚡ days, projects you did not touch are deferred, not neglected. Never type in this column.');
  lg.getRange(1, mCol + 1).setFontWeight('bold');

  // 2) Active Projects: rewrite the three formula columns, row by row (relative references).
  ['daysSince', 'goalStatus', 'alert', 'minsToday', 'status', 'due'].forEach(k => {
    if (pc[k] < 0) throw new Error('Active Projects: column not found: ' + k);
  });
  const col = k => colLetter_(pc[k]);
  const M = L + colLetter_(mCol) + ':' + colLetter_(mCol);
  const LA = L + A + ':' + A, LB = L + B + ':' + B;
  const mDay = 'COUNTIFS(' + LA + ',TODAY(),' + M + ',"' + MOMENTUM_MARK + '")>0';
  const lastRow = sh.getMaxRows();   // every data row, filled or empty, like the existing formulas
  const n = lastRow - FIRST_DATA_ROW + 1;
  const days = [], status = [], alert = [];
  for (let r = FIRST_DATA_ROW; r <= lastRow; r++) {
    const b = 'B' + r, e = col('status') + r, f = 'F' + r, g = col('daysSince') + r, h = col('minsToday') + r, l = col('due') + r;
    // Days Since Logged = calendar days since last log, minus momentum days since then (up to today).
    // Never-logged projects count from when the tracker started (2026-11-14) instead of a 999 placeholder.
    days.push(['=IF(' + b + '="","",IF(COUNTIF(' + LB + ',' + b + ')=0,TODAY()-DATE(2026,11,14),LET(last,MAXIFS(' + LA + ',' + LB + ',' + b + '),' +
      'TODAY()-last-COUNTUNIQUEIFS(' + LA + ',' + M + ',"' + MOMENTUM_MARK + '",' + LA + ',">"&last,' + LA + ',"<="&TODAY()))))']);
    // Today's Goal Status: untouched + momentum day + not due/overdue → ⏸ Deferred.
    status.push(['=IF(' + b + '="","",IF(' + e + '<>"Active - Daily","—",IF(' + h + '>=' + f + ',"✅ Done",IF(' + h + '>0,"⏳ Partial",' +
      'IF(AND(' + mDay + ',OR(' + l + '="",' + l + '>TODAY())),"⏸ Deferred","🔴 Pending")))))']);
    // Reminder Alert: same as before, but "neglected" now reads the momentum-aware Days Since Logged.
    alert.push(['=IF(' + b + '="","",IF(' + e + '="Completed","Archived",IF(AND(' + l + '<>"",' + l + '<TODAY()),"🚨 OVERDUE",' +
      'IF(AND(' + l + '<>"",' + l + '=TODAY()),"⏰ DUE TODAY",IF(AND(' + e + '="Active - Daily",N(' + g + ')>=2),"⚠️ NEGLECTED (2+ Days)","🟢 On Track")))))']);
  }
  sh.getRange(FIRST_DATA_ROW, pc.daysSince + 1, n, 1).setFormulas(days);
  sh.getRange(FIRST_DATA_ROW, pc.goalStatus + 1, n, 1).setFormulas(status);
  sh.getRange(FIRST_DATA_ROW, pc.alert + 1, n, 1).setFormulas(alert);
  SpreadsheetApp.flush();
  return 'Momentum deferral is on';
}

// ---------- write: voice note ----------

function saveVoice_(project, mime, base64) {
  if (!project || !base64) throw new Error('Missing project or audio');
  const safe = String(project).replace(/[\\/:*?"<>|]/g, '-').trim();
  const folder = findFolder_(VOICE_ROOT.concat([safe]), true);
  // Drop codec parameters (e.g. "audio/mp4;codecs=mp4a.40.2"): Drive and iPhone players choke on them.
  const base = String(mime || 'audio/webm').split(';')[0].trim().toLowerCase();
  const isMp4 = /mp4|m4a|aac/.test(base);
  const type = isMp4 ? 'audio/mp4' : /ogg/.test(base) ? 'audio/ogg' : 'audio/webm';
  const ext = isMp4 ? 'm4a' : /ogg/.test(base) ? 'ogg' : 'webm';
  const name = safe + ' — ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HHmm') + '.' + ext;
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), type, name);
  const file = folder.createFile(blob);
  return { ok: true, id: file.getId(), name: file.getName(), url: file.getUrl(), mime: type, created: file.getDateCreated().toISOString() };
}

// ---------- read: one voice note ----------

function audio_(id) {
  if (!id) throw new Error('Missing file id');
  const file = DriveApp.getFileById(id);
  // Only serve files that live in Al-Marfat/Project Voice Notes/<Project>/
  const parents = file.getParents();
  let allowed = false;
  while (parents.hasNext()) {
    const p = parents.next();
    const gp = p.getParents();
    while (gp.hasNext()) if (gp.next().getName() === VOICE_ROOT[VOICE_ROOT.length - 1]) allowed = true;
  }
  if (!allowed) throw new Error('Not a project voice note');
  const blob = file.getBlob();
  let mime = String(blob.getContentType() || '').split(';')[0];
  if (/\.m4a$/i.test(file.getName())) mime = 'audio/mp4';
  return { ok: true, mime: mime || 'audio/webm', data: Utilities.base64Encode(blob.getBytes()) };
}

// ---------- subscriptions ----------

const S_COLS = {
  service:  [/service|subscription/i, 0],
  nature:   [/nature|type|kind/i, 1],
  account:  [/account|email/i, 2],
  start:    [/start/i, 3],
  end:      [/^end|expir|renewal/i, 4, /action/i],
  amount:   [/amount|paid|price|cost/i, 5],
  onExpiry: [/action on expiry|on expiry/i, 6],
  reminder: [/reminder date/i, 7],
  calendar: [/calendar reminder/i, 8],
  taken:    [/action taken|done at expiry/i, 9],
  status:   [/status/i, 10],
  notes:    [/note/i, 11],
  eventId:  [/event id/i, 12],
};

function subsSheet_() { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SUBS_TAB); }
function subsCols_(sh) { return colMap_(sh.getRange(1, 1, 1, Math.max(SUBS_HEADERS.length, sh.getLastColumn())).getDisplayValues()[0], S_COLS); }

function readSubs_() {
  const sh = subsSheet_();
  if (!sh) return { exists: false, rows: [] };
  const last = sh.getLastRow();
  if (last < 2) return { exists: true, rows: [] };
  const c = subsCols_(sh);
  const width = Math.max(SUBS_HEADERS.length, sh.getLastColumn());
  const rng = sh.getRange(2, 1, last - 1, width);
  const raw = rng.getValues(), disp = rng.getDisplayValues();
  const rows = [];
  disp.forEach((r, i) => {
    const g = k => (c[k] >= 0 ? r[c[k]] : '');
    const dt = k => { const v = c[k] >= 0 ? raw[i][c[k]] : ''; return v instanceof Date ? fmt_(v) : ''; };
    if (!String(g('service')).trim()) return;
    rows.push({
      row: i + 2, service: g('service'), nature: g('nature'), account: g('account'),
      start: dt('start'), end: dt('end'), amount: g('amount'), onExpiry: g('onExpiry'),
      reminder: dt('reminder'), calendar: g('calendar'), calendarSet: !!(c.eventId >= 0 && r[c.eventId]),
      taken: g('taken'), status: g('status'), notes: g('notes'),
    });
  });
  return { exists: true, rows };
}

/** Run once from the editor: adds the Subscription Dashboard tab (if missing) and installs the triggers. */
function setupSubscriptionDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SUBS_TAB);
  if (!sh) {
    sh = ss.insertSheet(SUBS_TAB);
    sh.getRange(1, 1, 1, SUBS_HEADERS.length).setValues([SUBS_HEADERS]).setFontWeight('bold').setBackground('#1a1a1f').setFontColor('#ededf0');
    sh.setFrozenRows(1);
    const rows = 200;
    const list = (col, values) => sh.getRange(2, col, rows, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build());
    list(2, SUBS_NATURES); list(7, SUBS_ACTIONS); list(11, SUBS_STATUSES);
    [4, 5, 8].forEach(col => sh.getRange(2, col, rows, 1).setNumberFormat('yyyy-mm-dd')
      .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build()));
    sh.getRange(1, 9).setNote('Filled in by the script. Do not type here.');
    sh.getRange(1, 1).setNote('One row per subscription. Set a Reminder Date and a Google Calendar reminder is created at 9:00 AM that day.');
    [180, 120, 200, 110, 110, 110, 140, 120, 190, 200, 100, 240, 120].forEach((w, i) => sh.setColumnWidth(i + 1, w));
    sh.hideColumns(13);
  }
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['subsDailySync', 'subsOnEdit'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('subsDailySync').timeBased().everyDays(1).atHour(7).inTimezone(TZ).create();
  ScriptApp.newTrigger('subsOnEdit').forSpreadsheet(ss).onEdit().create();
  syncSubscriptionReminders();
  return 'Subscription Dashboard ready';
}

/** Adds a "Subscriptions" menu to the sheet. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Subscriptions')
    .addItem('Sync calendar reminders now', 'syncSubscriptionReminders')
    .addItem('Set up the Subscription Dashboard tab', 'setupSubscriptionDashboard')
    .addItem('Turn on momentum deferral', 'setupMomentumDeferral')
    .addToUi();
}

/** Daily trigger. */
function subsDailySync() { syncSubscriptionReminders(); }

/** Installable on-edit trigger: re-syncs the edited rows of the Subscription Dashboard tab. */
function subsOnEdit(e) {
  const r = e && e.range;
  if (!r || r.getSheet().getName() !== SUBS_TAB || r.getLastRow() < 2) return;
  const sh = r.getSheet();
  const c = subsCols_(sh);
  if (r.getColumn() === c.calendar + 1 && r.getNumColumns() === 1) return; // our own writes
  for (let row = Math.max(2, r.getRow()); row <= r.getLastRow(); row++) syncSubRow_(sh, c, row);
}

/** Creates, moves or removes the Calendar reminder for every row. Safe to run any time. */
function syncSubscriptionReminders() {
  const sh = subsSheet_();
  if (!sh || sh.getLastRow() < 2) return 0;
  const c = subsCols_(sh);
  let n = 0;
  for (let row = 2; row <= sh.getLastRow(); row++) if (syncSubRow_(sh, c, row)) n++;
  return n;
}

function syncSubRow_(sh, c, row) {
  if (c.reminder < 0 || c.eventId < 0) return false;
  const width = Math.max(SUBS_HEADERS.length, sh.getLastColumn());
  const vals = sh.getRange(row, 1, 1, width).getValues()[0];
  const disp = sh.getRange(row, 1, 1, width).getDisplayValues()[0];
  const g = k => (c[k] >= 0 ? disp[c[k]] : '');
  const service = String(g('service')).trim();
  const when = vals[c.reminder];
  const eventId = String(vals[c.eventId] || '');
  const cal = CalendarApp.getDefaultCalendar();
  let ev = null;
  if (eventId) { try { ev = cal.getEventById(eventId); } catch (err) { ev = null; } }
  const setCell = (k, v) => { if (c[k] >= 0 && String(vals[c[k]]) !== String(v)) sh.getRange(row, c[k] + 1).setValue(v); };

  if (!service || !(when instanceof Date)) {
    if (ev) ev.deleteEvent();
    setCell('eventId', ''); setCell('calendar', '');
    return false;
  }
  const day = fmt_(when);
  const start = new Date(day + 'T' + ('0' + REMINDER_HOUR).slice(-2) + ':00:00+03:00');
  const end = new Date(start.getTime() + 15 * 60000);
  const action = String(g('onExpiry') || 'Decide').trim();
  const endDay = c.end >= 0 && vals[c.end] instanceof Date ? fmt_(vals[c.end]) : '';
  const title = '🔔 ' + service + ': ' + action + (endDay ? ' (ends ' + endDay + ')' : '');
  const desc = [
    'Subscription reminder from the Master Project Tracker.',
    'Service: ' + service,
    g('nature') ? 'Nature: ' + g('nature') : '',
    g('account') ? 'Account: ' + g('account') : '',
    endDay ? 'Ends: ' + endDay : '',
    g('amount') ? 'Amount paid: ' + g('amount') : '',
    'Action on expiry: ' + action,
    g('notes') ? 'Notes: ' + g('notes') : '',
    '',
    'When done, fill in "Action Taken" and "Status" in the sheet: ' + SpreadsheetApp.getActiveSpreadsheet().getUrl() + '#gid=' + sh.getSheetId(),
  ].filter(x => x !== '').join('\n');

  if (ev) {
    if (ev.getStartTime().getTime() !== start.getTime()) ev.setTime(start, end);
    if (ev.getTitle() !== title) ev.setTitle(title);
    if (ev.getDescription() !== desc) ev.setDescription(desc);
  } else {
    if (start.getTime() < Date.now() - 864e5) { setCell('calendar', 'Date has passed, no reminder'); return false; }
    ev = cal.createEvent(title, start, end, { description: desc });
    ev.removeAllReminders();
    ev.addPopupReminder(0);
    ev.addPopupReminder(24 * 60);
    ev.addEmailReminder(0);
    setCell('eventId', ev.getId());
  }
  setCell('calendar', '✅ ' + Utilities.formatDate(start, TZ, 'd MMM yyyy, h:mm a'));
  return true;
}

/** Dashboard write: sets only the Reminder Date of one subscription row, then syncs its Calendar event. */
function setSubReminder_(row, service, date) {
  row = Number(row);
  if (!row || row < 2) throw new Error('Missing subscription row');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('Reminder date must look like 2026-12-01');
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const sh = subsSheet_();
    if (!sh) throw new Error('The Subscription Dashboard tab does not exist yet. Run setupSubscriptionDashboard() in Apps Script.');
    const c = subsCols_(sh);
    if (String(sh.getRange(row, c.service + 1).getDisplayValue()).trim() !== String(service || '').trim()) {
      throw new Error('The sheet changed. Refresh and try again.');
    }
    const cell = sh.getRange(row, c.reminder + 1);
    if (date) { const [y, m, d] = date.split('-').map(Number); cell.setValue(new Date(y, m - 1, d)); }
    else cell.clearContent();
    SpreadsheetApp.flush();
    syncSubRow_(sh, c, row);
    const sub = readSubs_().rows.find(s => s.row === row);
    return { ok: true, sub };
  } finally {
    lock.releaseLock();
  }
}

// ---------- helpers ----------

function findFolder_(path, create) {
  let folder = DriveApp.getRootFolder();
  for (const part of path) {
    const it = folder.getFoldersByName(part);
    if (it.hasNext()) folder = it.next();
    else if (create) folder = folder.createFolder(part);
    else return null;
  }
  return folder;
}

function checkToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('DASHBOARD_TOKEN');
  if (!expected) throw new Error('DASHBOARD_TOKEN is not set in Script properties');
  if (token !== expected) throw new Error('Wrong passcode');
}

function fmt_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }

function handle_(fn) {
  let out;
  try { out = fn(); } catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
