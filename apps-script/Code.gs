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
 *
 * Columns are found by their header text, so new sheet columns (Priority Score, Days Since Logged,
 * Today's Pick, Voice Log Link) are picked up automatically. Only the Current Status cell is written;
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
};
const L_COLS = {
  date:      [/^date$/i, 0],
  project:   [/project/i, 1],
  minutes:   [/minute/i, 2],
  work:      [/work completed|work/i, 3],
  next:      [/next/i, 4],
  notes:     [/note|blocker/i, 5, /voice/i],
  voiceLink: [/voice/i, -1],
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
                 voiceLink: vCol >= 0 ? linkOf_(vDisp[i][0], vForm[i][0], vRich[i][0]) : '' });
    });
  }

  return { ok: true, version: 2, generatedAt: new Date().toISOString(), projects, log, voiceNotes: listVoiceNotes_() };
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
