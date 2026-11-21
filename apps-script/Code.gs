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
 * Formula columns H, I, M (and every other column) are never written.
 *
 * SETUP: Project Settings (gear icon) → Script properties → add
 *   DASHBOARD_TOKEN = a passcode you choose (you'll type the same one in the dashboard)
 */

const PROJECTS_TAB = 'Active Projects';
const LOG_TAB = 'Daily Voice Log';
const FIRST_DATA_ROW = 3;          // row 1 = summary banner, row 2 = headers
const STATUS_COL = 5;              // column E — the only column this script writes on Tab 1
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

function read_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(PROJECTS_TAB);
  const last = sh.getLastRow();
  const projects = [];
  if (last >= FIRST_DATA_ROW) {
    const n = last - FIRST_DATA_ROW + 1;
    const display = sh.getRange(FIRST_DATA_ROW, 1, n, 13).getDisplayValues();
    const raw = sh.getRange(FIRST_DATA_ROW, 1, n, 13).getValues();
    display.forEach((r, i) => {
      if (!r[1]) return;
      const dueRaw = raw[i][11];
      projects.push({
        row: FIRST_DATA_ROW + i,
        id: r[0],
        name: r[1],
        category: r[2],
        priority: r[3],
        status: r[4],
        goal: Number(raw[i][5]) || 0,
        slot: r[6],
        minsTodaySheet: Number(raw[i][7]) || 0,   // formula column H (read only)
        goalStatusSheet: r[8],                     // formula column I (read only)
        lastAction: r[9],
        nextAction: r[10],
        due: dueRaw instanceof Date ? fmt_(dueRaw) : '',
        alertSheet: r[12],                         // formula column M (read only)
      });
    });
  }

  const log = [];
  const lg = ss.getSheetByName(LOG_TAB);
  const lastLog = lg.getLastRow();
  if (lastLog >= 2) {
    const cutoff = new Date(Date.now() - LOG_DAYS * 864e5);
    lg.getRange(2, 1, lastLog - 1, 6).getValues().forEach(r => {
      if (!(r[0] instanceof Date) || !r[1] || r[0] < cutoff) return;
      log.push({ date: fmt_(r[0]), project: String(r[1]), minutes: Number(r[2]) || 0,
                 work: String(r[3] || ''), next: String(r[4] || ''), notes: String(r[5] || '') });
    });
  }

  return { ok: true, generatedAt: new Date().toISOString(), projects, log, voiceNotes: listVoiceNotes_() };
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
    const names = sh.getRange(FIRST_DATA_ROW, 2, last - FIRST_DATA_ROW + 1, 1).getDisplayValues();
    const idx = names.findIndex(r => r[0] === project);
    if (idx === -1) throw new Error('Project not found: ' + project);
    sh.getRange(FIRST_DATA_ROW + idx, STATUS_COL).setValue(status);   // column E only
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
