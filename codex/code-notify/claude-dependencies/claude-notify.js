'use strict';
// Claude Code -> existing Code-Notify Discord backend.
// Hook:        node claude-notify.js --hook
// Status line: node claude-notify.js --statusline
// Requires Node.js and Windows PowerShell; does not send transcript text by default.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const HOME = os.homedir();
const BACKEND = path.join(HOME, '.claude', 'notifications', 'notify.ps1');
const CONFIG = path.join(HOME, '.config', 'code-notify');
const STATUS = path.join(CONFIG, 'claude-status');
const LOG = path.join(CONFIG, 'claude-hook.log');
const ID_RE = /^[a-zA-Z0-9_-]{6,100}$/;
const MAX_TAIL_BYTES = 16 * 1024 * 1024;

function log(s) {
  try {
    fs.mkdirSync(CONFIG, {recursive: true});
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`, 'utf8');
  } catch (_) {}
}
function readJsonStdin() { return JSON.parse(fs.readFileSync(0, 'utf8')); }
function validId(id) { return typeof id === 'string' && ID_RE.test(id); }
function validNumber(n) { return typeof n === 'number' && Number.isFinite(n) && n >= 0; }
function basename(p) { return typeof p === 'string' ? (path.win32.basename(p.replace(/[\\/]+$/, '')) || path.posix.basename(p.replace(/[\\/]+$/, ''))) : ''; }

function writeStatus(e) {
  if (!e || !validId(e.session_id)) return;
  const entry = {
    captured_at: Date.now(),
    session_id: e.session_id,
    model: e.model?.id || e.model?.display_name || null,
    reasoning_effort: e.effort?.level || null,
    mode: e.fast_mode === true ? 'fast' : null,
    context_percent_approx: validNumber(e.context_window?.used_percentage) ? e.context_window.used_percentage : null,
    context_window: validNumber(e.context_window?.context_window_size) ? e.context_window.context_window_size : null,
    rate_limits: e.rate_limits || null
  };
  try {
    fs.mkdirSync(STATUS, {recursive: true});
    const dest = path.join(STATUS, `${e.session_id}.json`);
    const tmp = path.join(STATUS, `${e.session_id}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(entry), {encoding:'utf8', mode:0o600});
    fs.renameSync(tmp, dest);
  } catch (_) { /* status line must still render */ }
  // Status line must print a useful visual row. It is not a notification.
  const model = e.model?.display_name || e.model?.id || 'Claude';
  const dir = basename(e.workspace?.project_dir || e.cwd) || 'project';
  const ctx = entry.context_percent_approx;
  process.stdout.write(`${dir} | ${model}${ctx == null ? '' : ` | ${Math.round(ctx)}% context`}\n`);
}

function readStatus(id, notBeforeMs) {
  if (!validId(id)) return null;
  try {
    const snapshot = JSON.parse(fs.readFileSync(path.join(STATUS, `${id}.json`), 'utf8'));
    // Never import the previous turn's state as if it were the current turn.
    if (snapshot.session_id !== id || !validNumber(snapshot.captured_at)) return null;
    if (Date.now() - snapshot.captured_at > 120000 || snapshot.captured_at > Date.now() + 5000) return null;
    if (Number.isFinite(notBeforeMs) && snapshot.captured_at < notBeforeMs) return null;
    return snapshot;
  } catch (_) { return null; }
}

function readTranscriptTail(file, sessionId) {
  if (typeof file !== 'string' || !file) return [];
  // Only ever read a transcript under the local Claude Code projects directory.
  const root = path.resolve(HOME, '.claude', 'projects');
  const resolved = path.resolve(file);
  if (!resolved.startsWith(root + path.sep) || !resolved.endsWith('.jsonl')) return [];
  if (validId(sessionId) && path.basename(resolved) !== `${sessionId}.jsonl`) return [];
  let fd;
  try {
    fd = fs.openSync(resolved, 'r');
    const len = fs.fstatSync(fd).size;
    const offset = Math.max(0, len - MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(len - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    let str = buffer.toString('utf8');
    if (offset) str = str.slice(str.indexOf('\n') + 1);
    // Incomplete last line can be skipped; completed lines still contribute.
    if (str && !str.endsWith('\n')) str = str.slice(0, str.lastIndexOf('\n') + 1);
    const rows = [];
    for (const line of str.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch (_) {}
    }
    return rows;
  } catch (_) { return []; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
}

function isHumanPrompt(r) {
  if (r?.type !== 'user' || r.isSidechain === true || r.isMeta === true) return false;
  const c = r.message?.content;
  if (typeof c === 'string') return Boolean(c.trim());
  if (!Array.isArray(c)) return false;
  return c.some(x => x && x.type !== 'tool_result' && (x.type === 'text' || x.type === 'image'));
}
function transcriptMetrics(rows, now = Date.now()) {
  const result = {};
  let start = -1;
  for (let i = 0; i < rows.length; i++) if (isHumanPrompt(rows[i])) start = i;
  if (start < 0) return {metrics:result, startMs:null};
  const started = Date.parse(rows[start]?.timestamp || '');
  const startMs = Number.isFinite(started) ? started : null;
  if (startMs !== null && now >= startMs) {
    result.duration_seconds = Math.round((now - startMs) / 1000);
    result.duration_approximate = true; // includes user approval waits
  }
  const calls = new Map();
  let lastModel = null;
  for (let i = start + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r?.type !== 'assistant' || r.isSidechain === true) continue;
    const msg = r.message;
    if (typeof msg?.model === 'string' && msg.model !== '<synthetic>') lastModel = msg.model;
    if (!msg?.usage || typeof msg?.id !== 'string') continue;
    const u = msg.usage;
    const values = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
    if (!values.every(k => validNumber(u[k]))) continue;
    const score = u.output_tokens * 1e9 + u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
    const prev = calls.get(msg.id);
    if (!prev || score > prev.score) calls.set(msg.id, {score, usage:u});
  }
  if (lastModel) result.model = lastModel;
  if (calls.size) {
    const t = {input_tokens:0, output_tokens:0};
    for (const {usage:u} of calls.values()) {
      // Cached tokens still count as processed input, though at different cost.
      t.input_tokens += u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
      t.output_tokens += u.output_tokens;
    }
    result.turn_tokens = t;
  }
  return {metrics:result, startMs};
}
function mergeStatus(metrics, snapshot) {
  if (!snapshot) return metrics;
  if (snapshot.model) metrics.model = snapshot.model;
  if (snapshot.reasoning_effort) metrics.reasoning_effort = snapshot.reasoning_effort;
  if (snapshot.mode) metrics.mode = snapshot.mode;
  if (validNumber(snapshot.context_percent_approx)) metrics.context_percent_approx = snapshot.context_percent_approx;
  if (validNumber(snapshot.context_window)) metrics.context_window = snapshot.context_window;
  const limits = snapshot.rate_limits;
  const mapping = [['five_hour','primary',300],['seven_day','secondary',10080]];
  for (const [from, to, minutes] of mapping) {
    const limit = limits?.[from];
    if (!validNumber(limit?.used_percentage) || limit.used_percentage > 100) continue;
    const resetsAt = limit.resets_at;
    // Expired windows should not be represented as current quota.
    if (validNumber(resetsAt) && resetsAt <= Math.floor(Date.now() / 1000)) continue;
    (metrics.rate_limit_used_percent ||= {})[to] = limit.used_percentage;
    (metrics.rate_limit_window_minutes ||= {})[to] = minutes;
    if (validNumber(resetsAt)) (metrics.rate_limit_resets_at ||= {})[to] = Math.floor(resetsAt);
  }
  return metrics;
}
function mayNeedReply(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const last = text.trim().split(/\n\s*\n/).at(-1).trim();
  return last.length > 0 && last.length < 500 && !last.includes('```') && /\?\s*$/.test(last);
}
function deliver(e, opts = {}) {
  if (!e || !validId(e.session_id)) return {status:'skipped', reason:'missing_session_id'};
  const hook = e.hook_event_name;
  if (!['Stop','Notification'].includes(hook)) return {status:'skipped', reason:'unsupported_event'};
  if (hook === 'Stop' && e.stop_hook_active === true) return {status:'skipped', reason:'stop_hook_active'};
  if (hook === 'Notification' && !['permission_prompt','idle_prompt','agent_needs_input','elicitation_dialog'].includes(e.notification_type))
    return {status:'skipped', reason:'non_actionable_notification'};
  const project = basename(e.cwd) || 'Claude Code';
  const isQuestion = hook === 'Notification' || (hook === 'Stop' && process.env.CODE_NOTIFY_CLAUDE_QUESTION_HEURISTIC !== '0' && mayNeedReply(e.last_assistant_message));
  const rows = hook === 'Stop' ? readTranscriptTail(e.transcript_path, e.session_id) : [];
  const {metrics, startMs} = transcriptMetrics(rows);
  const human = rows.filter(isHumanPrompt).at(-1);
  const turnId = typeof human?.uuid === 'string' && /^[A-Za-z0-9_-]{6,100}$/.test(human.uuid) ? human.uuid : null;
  if (hook === 'Stop') {
    mergeStatus(metrics, readStatus(e.session_id, startMs));
    if (!metrics.mode && typeof e.permission_mode === 'string') metrics.mode = e.permission_mode;
  }
  const payload = {
    session_id:e.session_id, claude_turn_id:turnId, cwd:e.cwd,
    transcript_path:e.transcript_path,
    hook_event_name:hook, notification_type:e.notification_type || null,
    claude_notify:{kind:hook === 'Stop' && isQuestion ? 'possible_question' : isQuestion ? 'input_required' : 'complete', metrics}
  };
  if (opts.dryRun) return {status:'dry-run',project,kind:payload.claude_notify.kind,metrics};
  if (!fs.existsSync(BACKEND)) {log('ERROR backend missing');return {status:'missing-backend'};}
  const proc = cp.spawnSync('powershell.exe', [
    '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',BACKEND,
    isQuestion ? 'notification' : 'stop','claude',project
  ], {input:JSON.stringify(payload), encoding:'utf8', windowsHide:true, timeout:20000, maxBuffer:1024*1024});
  const status = proc.error ? (proc.error.code || 'spawn-error') : proc.status;
  log(`event=${hook} project=${JSON.stringify(project)} metrics=${Object.keys(metrics).join(',') || 'none'} status=${status}`);
  return {status, project};
}
if (require.main === module) {
  try {
    const e = readJsonStdin();
    if (process.argv.includes('--statusline')) writeStatus(e);
    else {
      const r = deliver(e, {dryRun:process.argv.includes('--dry-run')});
      if (process.argv.includes('--dry-run')) process.stderr.write(JSON.stringify(r)+'\n');
    }
  } catch (err) {log(`ERROR ${err.name || 'Error'}`);}
  // No hook decision: never interrupt Claude Code or leak notification details to Claude.
}
module.exports = {isHumanPrompt, transcriptMetrics, mergeStatus, readTranscriptTail, writeStatus, mayNeedReply, deliver};
