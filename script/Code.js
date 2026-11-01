/**
 * Mytodo script: the "mailbox" between Mytodo and your Google account.
 * It runs as you, so it never needs Google's sign-in window.
 *
 * What it can do (nothing else):
 *   - read / write ONE file: <NAME>/mytodo-data.json in your Google Drive
 *   - read / change tasks in ONE Google Tasks list: <NAME>
 * Every request must carry the secret key. The key is kept in the script's
 * settings (Script properties), never in this code.
 *
 * Setup: run setupTest() (test copy) or setupReal() (your real tasks) once
 * in the Apps Script editor, then copy the key from the log.
 */

const FILE_NAME = 'mytodo-data.json';
const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

function setupTest() { setup_('Mytodo-test'); }
function setupReal() { setup_('Mytodo'); }

// Saves the name (folder + Tasks list) and makes a key if there is none yet
function setup_(name) {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty('NAME') !== name) p.deleteProperty('FILE_ID'), p.deleteProperty('LIST_ID');
  p.setProperty('NAME', name);
  if (!p.getProperty('KEY')) p.setProperty('KEY', makeKey_());
  console.log('Ready for "' + name + '". Your secret key (copy it into your password manager):\n' + p.getProperty('KEY'));
}

// Run this if a key was lost: the old key stops working at once
function newKey() {
  const p = PropertiesService.getScriptProperties();
  p.setProperty('KEY', makeKey_());
  console.log('New secret key:\n' + p.getProperty('KEY'));
}

// Checks Drive and Tasks and writes the results to the log (never shows the key)
function selfTest() {
  const p = PropertiesService.getScriptProperties(), name = p.getProperty('NAME');
  const step = (label, fn) => { try { console.log(label + ': ' + JSON.stringify(fn()).slice(0, 400)); } catch (e) { console.log(label + ' FAILED: ' + e); } };
  step('Name', () => name);
  step('Drive search', () => api_('get', DRIVE_API + '?pageSize=1&fields=files(id)'));
  step('Folder', () => folderId_(name));
  step('Read data', () => readData_(p));
  step('Tasks list', () => tasksList_(p, name));
}

function makeKey_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

// Mytodo sends: { key, op, ... }  ->  answers { status, body }
function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    const p = PropertiesService.getScriptProperties();
    const key = p.getProperty('KEY');
    if (!key || !p.getProperty('NAME')) out = { status: 503, error: 'Script is not set up yet' };
    else if (typeof req.key !== 'string' || !sameText_(req.key, key)) out = { status: 403, error: 'Wrong key' };
    else out = handle_(req, p);
  } catch (err) {
    out = { status: 500, error: String(err && err.message || err) };
  }
  if (out.status >= 400 && out.status !== 403) console.error('Mytodo request failed: ' + out.status + ' ' + (out.error || ''));
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req, p) {
  const name = p.getProperty('NAME');
  if (req.op === 'hello') return { status: 200, body: { email: Session.getEffectiveUser().getEmail(), name: name } };
  if (req.op === 'read') return readData_(p);
  if (req.op === 'write') return writeData_(p, name, String(req.body || ''));
  if (req.op === 'list') return { status: 200, body: tasksList_(p, name) };
  if (req.op === 'tasks') return tasksCall_(p, name, req);
  return { status: 400, error: 'Unknown op' };
}

/* ---------- Drive: one file in one folder ---------- */
function readData_(p) {
  const id = p.getProperty('FILE_ID');
  if (!id) return { status: 200, body: null };
  const r = api_('get', DRIVE_API + '/' + id + '?alt=media');
  if (r.status === 404) { p.deleteProperty('FILE_ID'); return { status: 200, body: null }; }
  if (r.status !== 200) return r;
  return { status: 200, body: r.text ? JSON.parse(r.text) : null };
}

function writeData_(p, name, text) {
  JSON.parse(text);   // only valid data is saved
  const id = p.getProperty('FILE_ID');
  if (id) {
    const r = api_('patch', UPLOAD_API + '/' + id + '?uploadType=media', text);
    if (r.status !== 404) return { status: r.status, body: null };
    p.deleteProperty('FILE_ID');   // the file was deleted: make a new one
  }
  const folderId = folderId_(name);
  if (!folderId) return { status: 500, error: 'Could not make the folder' };
  const b = 'mytodo' + Date.now();
  const multipart = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify({ name: FILE_NAME, parents: [folderId] }) +
    '\r\n--' + b + '\r\nContent-Type: application/json\r\n\r\n' + text + '\r\n--' + b + '--';
  const r = api_('post', UPLOAD_API + '?uploadType=multipart&fields=id', multipart, 'multipart/related; boundary=' + b);
  if (r.status !== 200) return r;
  p.setProperty('FILE_ID', JSON.parse(r.text).id);
  return { status: 200, body: null };
}

// The folder <NAME> that this script made before, or a new one
function folderId_(name) {
  const q = encodeURIComponent("name='" + name.replace(/'/g, "\\'") + "' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const found = api_('get', DRIVE_API + '?q=' + q + '&fields=files(id)');
  const files = found.status === 200 ? JSON.parse(found.text).files || [] : [];
  if (files.length) return files[0].id;
  const r = api_('post', DRIVE_API + '?fields=id', JSON.stringify({ name: name, mimeType: 'application/vnd.google-apps.folder' }));
  return r.status === 200 ? JSON.parse(r.text).id : null;
}

/* ---------- Google Tasks: one list ---------- */
function tasksList_(p, name) {
  const id = p.getProperty('LIST_ID');
  if (id) {
    const r = api_('get', TASKS_API + '/users/@me/lists/' + id);
    if (r.status === 200) return JSON.parse(r.text);
  }
  const all = JSON.parse(api_('get', TASKS_API + '/users/@me/lists?maxResults=100').text).items || [];
  let list = all.find(l => l.title === name);
  if (!list) list = JSON.parse(api_('post', TASKS_API + '/users/@me/lists', JSON.stringify({ title: name })).text);
  p.setProperty('LIST_ID', list.id);
  return list;
}

// Only tasks inside the one list: /lists/<LIST_ID>/tasks[/<taskId>][?query]
function tasksCall_(p, name, req) {
  const listId = tasksList_(p, name).id;
  const method = String(req.method || 'GET').toLowerCase();
  if (['get', 'post', 'patch', 'delete'].indexOf(method) < 0) return { status: 400, error: 'Bad method' };
  const path = String(req.path || '');
  const prefix = '/lists/' + listId + '/tasks';
  if (path.indexOf(prefix) !== 0 || !/^(\/[\w-]+)?(\?[\w=&%.-]*)?$/.test(path.slice(prefix.length)))
    return { status: 400, error: 'Not allowed' };
  const r = api_(method, TASKS_API + path, req.body || null);
  return { status: r.status, body: r.text ? JSON.parse(r.text) : null };
}

/* ---------- Helpers ---------- */
function api_(method, url, payload, contentType) {
  const opts = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } };
  if (payload != null) { opts.payload = payload; opts.contentType = contentType || 'application/json'; }
  const r = UrlFetchApp.fetch(url, opts);
  return { status: r.getResponseCode(), text: r.getContentText() };
}

// Compares the key without stopping at the first wrong letter
function sameText_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
