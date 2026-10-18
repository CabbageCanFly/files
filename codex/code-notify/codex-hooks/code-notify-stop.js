'use strict';
// Universal Codex Stop -> existing Discord-only Code-Notify backend.
// Does not alter save-final.py or notify-toast.py. No session IDs hardcoded.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const {getMetrics, prepareFinalReply} = require('./codex-rollout');

const home = os.homedir();
const backend = path.join(home, '.claude', 'notifications', 'notify.ps1');
const logPath = path.join(home, '.config', 'code-notify', 'codex-stop.log');
function log(message) {
  try { fs.mkdirSync(path.dirname(logPath), {recursive:true}); fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`); }
  catch (_) { /* never interrupt Codex */ }
}
function run(event, opts = {}) {
  if (!event || event.stop_hook_active || !event.session_id || !event.turn_id) return {status:'skipped'};
  const cwd = typeof event.cwd === 'string' && event.cwd.trim() ? event.cwd : process.cwd();
  const project = path.basename(path.normalize(cwd)) || 'Codex';
  const {metrics, pendingQuestion, finalReply, found, reason} = opts.metrics || getMetrics(event);
  const isQuestion = pendingQuestion && process.env.CODE_NOTIFY_CODEX_QUESTION_HEURISTIC !== '0';
  const payload = {
    type: isQuestion ? 'codex-input-question' : 'agent-turn-complete',
    'thread-id': event.session_id,
    'turn-id': event.turn_id,
    cwd,
    'input-messages': [],
    'last-assistant-message': 'Codex response ready',
    codex_notify: {kind: isQuestion ? 'possible_question' : 'complete', metrics,
      final_reply: process.env.CODE_NOTIFY_CODEX_INCLUDE_REPLY === '0' ? '' : prepareFinalReply(finalReply)}
  };
  if (opts.dryRun) return {status:'dry-run', project, kind:payload.codex_notify.kind, metrics, found, reply_chars:payload.codex_notify.final_reply.length};
  if (!fs.existsSync(backend)) {log('ERROR backend missing');return {status:'missing-backend'};}
  const response = cp.spawnSync('powershell.exe', [
    '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',backend,
    isQuestion ? 'notification' : 'stop', 'codex', project
  ], {input:JSON.stringify(payload), encoding:'utf8', windowsHide:true, timeout:20000, maxBuffer:1024*1024});
  const status = response.error ? response.error.code || 'spawn-error' : response.status;
  log(`kind=${payload.codex_notify.kind} project=${JSON.stringify(project)} rollout=${found} metrics=${Object.keys(metrics || {}).join(",") || "none"} reason=${reason || "n/a"} reply_chars=${payload.codex_notify.final_reply.length} status=${status}`);
  return {status, project, kind:payload.codex_notify.kind};
}
if (require.main === module) {
  try {
    const event = JSON.parse(fs.readFileSync(0, 'utf8'));
    const result = run(event, {dryRun:process.argv.includes('--dry-run')});
    if (process.argv.includes('--dry-run')) process.stderr.write(JSON.stringify(result)+'\n');
  } catch (err) {log('ERROR ' + err.message);}
  // Hook success, regardless of notification failures. No stdout debug text.
  process.stdout.write('{}');
}
module.exports = {run};
