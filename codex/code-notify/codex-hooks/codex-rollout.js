'use strict';
// Best-effort read-only Codex rollout telemetry; no transcript text is transmitted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const MAX_TAIL_BYTES = 16 * 1024 * 1024;
const TOKEN_KEYS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const ID_RE = /^[a-f0-9-]{32,40}$/i;

function findRollout(event, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const id = event.session_id || event['thread-id'];
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const root = path.resolve(home, 'sessions');
  // Hook metadata, when present, must identify the expected session rollout under Codex home.
  const supplied = event.transcript_path;
  if (typeof supplied === 'string') {
    const p = path.resolve(supplied);
    if (p.startsWith(root + path.sep) && path.basename(p).startsWith('rollout-') &&
        path.basename(p).toLowerCase().endsWith(id.toLowerCase() + '.jsonl') && fs.existsSync(p)) return p;
  }
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  let visited = 0;
  while (stack.length && visited < 25000) {
    const dir = stack.pop();
    let items;
    try { items = fs.readdirSync(dir, {withFileTypes: true}); } catch (_) { continue; }
    for (const item of items) {
      if (++visited > 25000) break;
      if (item.isDirectory()) stack.push(path.join(dir, item.name));
      else if (item.isFile() && item.name.toLowerCase().startsWith('rollout-') &&
               item.name.toLowerCase().endsWith(id.toLowerCase() + '.jsonl'))
        return path.join(dir, item.name);
    }
  }
  return null;
}

function readTail(file, maxBytes = MAX_TAIL_BYTES) {
  const f = fs.openSync(file, 'r');
  let size, offset, buf;
  try {
    size = fs.fstatSync(f).size;
    offset = Math.max(0, size - maxBytes);
    buf = Buffer.alloc(size - offset);
    const n = fs.readSync(f, buf, 0, buf.length, offset);
    buf = buf.subarray(0, n);
  } finally { fs.closeSync(f); }
  let raw = buf.toString('utf8');
  if (offset) {
    const nl = raw.indexOf('\n');
    raw = nl < 0 ? '' : raw.slice(nl + 1);
  }
  const lines = raw.split('\n');
  if (lines[lines.length - 1].trim()) lines.pop(); // Ignore possibly incomplete tail record.
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j && typeof j === 'object') events.push(j);
    } catch (_) { /* corrupt or partial line; skip */ }
  }
  return {events, complete: offset === 0};
}

function numbers(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const r = {};
  for (const k of TOKEN_KEYS) if (Number.isFinite(obj[k]) && obj[k] >= 0) r[k] = obj[k];
  return Object.keys(r).length ? r : null;
}
function timestamp(s) { const t = typeof s === 'string' ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; }
function eventKind(r) { return r?.type === 'event_msg' ? r.payload?.type : null; }

function collectTurn(rows, allowActive = false) {
  // Always use the *latest* task_start: a prior task_complete belongs to its own turn.
  let start = -1, finish = -1;
  for (let i=0; i<rows.length; i++) {
    if (eventKind(rows[i]) === 'task_started') {start=i;finish=-1;}
    else if (eventKind(rows[i]) === 'task_complete' && start >= 0) finish=i;
  }
  if (start < 0 || (finish < 0 && !allowActive)) return null;
  return {start, finish, end:finish < 0 ? rows.length - 1 : finish, active:finish < 0};
}

function modelForTurn(rows, start, end) {
  let latest = '';
  for (let i=start; i<=end; i++) {
    const r=rows[i], p=r?.payload;
    if (r?.type === 'turn_context' && typeof p?.model === 'string' && p.model.trim()) latest=p.model.trim();
  }
  // Some Codex versions write turn_context just before task_started. Fall back to
  // the preceding model only if the current turn has not recorded one yet.
  if (!latest) for (let i=start-1; i>=0; i--) {
    const r=rows[i], p=r?.payload;
    if (r?.type === 'turn_context' && typeof p?.model === 'string' && p.model.trim()) {latest=p.model.trim();break;}
  }
  return latest;
}

// Turn context records contain the *effective* mode and effort (not merely config defaults).
// Fall back to the last context before this task if Codex did not write one inside it.
function settingsForTurn(rows, start, end) {
  let context=null;
  for (let i=start; i<=end; i++) if (rows[i]?.type==='turn_context') context=rows[i].payload;
  if (!context) for (let i=start-1; i>=0; i--) {
    if (rows[i]?.type==='turn_context') {context=rows[i].payload;break;}
  }
  if (!context || typeof context!=='object') return {};
  const result={};
  const effort=context.effort || context.collaboration_mode?.settings?.reasoning_effort;
  const mode=context.collaboration_mode?.mode;
  if (typeof effort==='string' && /^[a-z0-9_-]{1,24}$/i.test(effort)) result.reasoning_effort=effort;
  if (typeof mode==='string' && /^[a-z0-9_-]{1,32}$/i.test(mode)) result.mode=mode;
  return result;
}

function summarize(rows, complete = true, expectedTurnId = null, opts = {}) {
  const turn=collectTurn(rows, Boolean(opts.allowActive));
  if (!turn) return {};
  const {start, finish, end, active}=turn;
  // A different completed turn must never be attributed to the Stop hook.
  if (!active) {
    const taskId=rows[finish]?.payload?.turn_id || rows[finish]?.payload?.id;
    if (taskId && expectedTurnId && taskId !== expectedTurnId) return {};
  }
  if (active) {
    const taskId=rows[start]?.payload?.turn_id || rows[start]?.payload?.id;
    if (taskId && expectedTurnId && taskId !== expectedTurnId) return {};
  }
  const result={};
  const model=modelForTurn(rows,start,end);
  if (model) result.model=model;
  Object.assign(result, settingsForTurn(rows,start,end));
  const begun=timestamp(rows[start]?.timestamp);
  // Active Stop hook means this turn is ending, even if task_complete has not
  // yet reached the JSONL writer. Use wall-clock time, flagged approximate.
  const now=opts.nowMs === undefined ? Date.now() : opts.nowMs;
  const stopped=active ? now : timestamp(rows[finish]?.timestamp);
  if (begun !== null && Number.isFinite(stopped) && stopped >= begun) {
    result.duration_seconds=Math.round((stopped-begun)/1000);
    if (active) result.duration_approximate=true;
  }
  let previous=null, current=null, limits=null;
  for (let i=0; i<=end; i++) {
    const e=rows[i];
    if (eventKind(e)!=='token_count') continue;
    const info=e.payload?.info || {};
    const total=numbers(info.total_token_usage);
    if (total) {
      const snap={total,last:numbers(info.last_token_usage),ctx:info.model_context_window};
      if (i<start) previous=snap; else current=snap;
    }
    // Avoid taking quota information from a different turn.
    if (i>=start && e.payload?.rate_limits && typeof e.payload.rate_limits==='object') limits=e.payload.rate_limits;
  }
  if (current) {
    // A full rollout with the first ever task can safely use zero baseline.
    const firstStart=rows.findIndex(r=>eventKind(r)==='task_started');
    const baseline=previous ? previous.total : (complete && start===firstStart ? Object.fromEntries(TOKEN_KEYS.map(k=>[k,0])) : null);
    if (baseline) {
      const delta={};
      for (const k of TOKEN_KEYS) if (k in current.total && k in baseline && current.total[k]>=baseline[k]) delta[k]=current.total[k]-baseline[k];
      if (Object.keys(delta).length) result.turn_tokens=delta;
    }
    result.session_tokens=current.total;
    if (Number.isFinite(current.ctx) && current.ctx>0 && current.last && Number.isFinite(current.last.input_tokens)) {
      // Model input is a useful indicator, not the exact working-context footprint.
      const pct=100*current.last.input_tokens/current.ctx;
      if (pct>=0 && pct<=100) {
        result.context_percent_approx=Math.round(pct*10)/10;
        result.context_window=current.ctx;
        result.context_remaining_approx=Math.max(0,current.ctx-current.last.input_tokens);
      }
    }
  }
  for (const field of ['primary','secondary']) {
    const bucket=limits?.[field];
    const used=bucket?.used_percent;
    if (Number.isFinite(used) && used>=0 && used<=100) {
      if (!result.rate_limit_used_percent) result.rate_limit_used_percent={};
      result.rate_limit_used_percent[field]=Math.round(used*10)/10;
      const minutes=bucket.window_minutes;
      if (Number.isFinite(minutes)) {
        if (!result.rate_limit_window_minutes) result.rate_limit_window_minutes={};
        result.rate_limit_window_minutes[field]=minutes;
      }
      // Codex records reset instants as Unix epoch seconds, not durations.
      // Never extrapolate a reset from the 5-hour/weekly window length.
      const reset=bucket.resets_at;
      if (Number.isSafeInteger(reset) && reset >= 1577836800 && reset < 4102444800) {
        if (!result.rate_limit_resets_at) result.rate_limit_resets_at={};
        result.rate_limit_resets_at[field]=reset;
      }
    }
  }
  return result;
}

function lastAssistantText(rows, allowActive=false) {
  const turn=collectTurn(rows,allowActive);
  if (!turn) return '';
  for (let i=turn.end; i>=turn.start; i--) {
    const r=rows[i],p=r.payload;
    if (r.type!=='response_item' || p?.type!=='message' || p.role!=='assistant' || p.phase!=='final') continue;
    const c=p.content;
    if (typeof c==='string') return c;
    if (Array.isArray(c)) return c.filter(x=>x?.type==='output_text' && typeof x.text==='string').map(x=>x.text).join('\n');
  }
  return '';
}
function maybeQuestion(text) {
  if (typeof text!=='string' || !text.trim()) return false;
  const last=text.trim().split(/\n\s*\n/).at(-1).trim();
  return last.length>0 && last.length<500 && !last.includes('```') && /\?\s*$/.test(last);
}
function shortSummary(text) {
  // Send transcript excerpts ONLY when user expressly enables the opt-in.
  if (typeof text!=='string') return '';
  const first=text.split(/\n/).map(s=>s.trim()).filter(s=>s && !/^#{1,6}\s/.test(s) && !/^```/.test(s))[0] || '';
  const clean=first.replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim();
  return clean.length>180 ? clean.slice(0,177)+'...' : clean;
}
// Discord embeds allow 4096 UTF-16 code units in a description. Leave headroom
// for the truncation indicator and avoid splitting surrogate pairs or fenced code.
const MAX_FINAL_REPLY = 3750;
function prepareFinalReply(text, maxLength = MAX_FINAL_REPLY) {
  if (typeof text !== 'string') return '';
  const clean=text.replace(/\r\n?/g,'\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').trim();
  if (!clean || maxLength<80) return '';
  if (clean.length<=maxLength) return clean;
  const suffix='\n\n… *(response truncated for Discord)*';
  // Reserve space for a possible closing Markdown code fence.
  const cap=maxLength-suffix.length-8;
  let cut=clean.slice(0,cap);
  // Do not leave a broken UTF-16 surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut=cut.slice(0,-1);
  const breakAt=cut.lastIndexOf('\n');
  if (breakAt>cap*0.8) cut=cut.slice(0,breakAt);
  // If truncation falls inside a fenced code block, close that fence.
  const fenceLines=cut.split('\n').filter(line=>/^\s*```/.test(line)).length;
  const closing=fenceLines%2===1 ? '\n```' : '';
  return cut.trimEnd()+closing+suffix;
}
function getMetrics(event) {
  const hookText=typeof event.last_assistant_message==='string' ? event.last_assistant_message : '';
  const file=findRollout(event);
  if (!file) return {metrics:{},pendingQuestion:maybeQuestion(hookText),finalReply:hookText,found:false,reason:'rollout_not_found'};
  try {
    const {events,complete}=readTail(file);
    const metrics=summarize(events,complete,event.turn_id,{allowActive:true});
    const message=hookText || lastAssistantText(events,true);
    // The full final reply is separate from the telemetry, and is never
    // included in local logs. Only final assistant text is forwarded.
    if (process.env.CODE_NOTIFY_CODEX_INCLUDE_SUMMARY==='1' && process.env.CODE_NOTIFY_CODEX_INCLUDE_REPLY==='0') {
      const summary=shortSummary(message);
      if (summary) metrics.reply_excerpt=summary;
    }
    return {metrics,pendingQuestion:maybeQuestion(message),finalReply:message,found:true,reason:Object.keys(metrics).length?'ok':'no_current_turn_telemetry'};
  } catch (_) {return {metrics:{},pendingQuestion:maybeQuestion(hookText),finalReply:hookText,found:false,reason:'rollout_read_error'};}
}

module.exports = {findRollout, readTail, summarize, lastAssistantText, maybeQuestion, shortSummary, settingsForTurn, prepareFinalReply, getMetrics};
