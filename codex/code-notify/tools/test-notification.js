'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {summarize, maybeQuestion, findRollout, getMetrics} = require('../codex-hooks/codex-rollout');
const {run} = require('../codex-hooks/code-notify-stop');
const ev = (time, type, extras={}) => ({type:'event_msg', timestamp:time, payload:{type,...extras}});
const info = (total,last) => ({total_token_usage:{input_tokens:total,cached_input_tokens:10,output_tokens:total/2,total_tokens:total*1.5},last_token_usage:{input_tokens:last},model_context_window:1000});
const t = '2026-10-17T22:00:00Z';
test('turn duration and cumulative deltas; duplicate usage does not multiply tokens', () => {
 const rows=[ev('2026-10-17T22:00:00Z','task_started'),ev('2026-10-17T22:00:05Z','token_count',{info:info(100,80)}),ev('2026-10-17T22:00:15Z','task_complete'),ev('2026-10-17T22:01:00Z','task_started'),ev('2026-10-17T22:01:20Z','token_count',{info:info(300,150),rate_limits:{primary:{used_percent:74}}}),ev('2026-10-17T22:01:21Z','token_count',{info:info(300,150)}),ev('2026-10-17T22:01:24Z','task_complete')];
 const s=summarize(rows,true);
 assert.equal(s.duration_seconds,24);
 assert.equal(s.turn_tokens.input_tokens,200);
 assert.equal(s.turn_tokens.total_tokens,300);
 assert.equal(s.context_percent_approx,15);
 assert.equal(s.rate_limit_used_percent.primary,74);
});
test('unknown prior baseline in partial tail omits per-turn tokens',()=>{
 const r=summarize([ev('2026-10-17T22:00:00Z','task_started'),ev('2026-10-17T22:00:03Z','token_count',{info:info(1000,600)}),ev('2026-10-17T22:00:04Z','task_complete')],false);
 assert.equal(r.turn_tokens,undefined);
});
test('short final question heuristic is narrow',()=>{
 assert.equal(maybeQuestion('Done.\n\nShould I proceed?'),true);
 assert.equal(maybeQuestion('Done; changes saved.'),false);
 assert.equal(maybeQuestion('Here is code:\n```js\nx?\n```'),false);
});
test('universal hook only runs for valid Stop and does not require hardcoded thread',()=>{
 assert.equal(run({session_id:'foo',turn_id:'bar',cwd:'C:/dev/test',stop_hook_active:false},{dryRun:true,metrics:{metrics:{},pendingQuestion:false,found:false}}).kind,'complete');
 assert.equal(run({session_id:'foo',turn_id:'bar',cwd:'C:/dev/test',stop_hook_active:false},{dryRun:true,metrics:{metrics:{},pendingQuestion:true,found:true}}).kind,'possible_question');
 assert.equal(run({session_id:'foo',turn_id:'bar',stop_hook_active:true},{dryRun:true}).status,'skipped');
});
test('does not infer duration from missing completion',()=>{
 assert.deepEqual(summarize([ev(t,'task_started'),ev(t,'token_count',{info:info(100,80)})],true),{});
});
test('finds the right rollout by session ID and classifies a real-style final answer', () => {
 const oldHome=process.env.CODEX_HOME;
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-hook-'));
 try {
  process.env.CODEX_HOME=tmp;
  const id='01a145c6-b117-7533-84e4-ae01bf98ea0a';
  const dir=path.join(tmp,'sessions','2026','10','17'); fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,`rollout-2026-10-17T22-00-00-${id}.jsonl`);
  const data=[ev('2026-10-17T22:00:00Z','task_started'),ev('2026-10-17T22:00:03Z','token_count',{info:info(100,80)}),
    {type:'response_item',timestamp:'2026-10-17T22:00:04Z',payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'Do you want to continue?'}]}},ev('2026-10-17T22:00:06Z','task_complete')];
  fs.writeFileSync(file,data.map(x=>JSON.stringify(x)).join('\n')+'\n');
  assert.equal(findRollout({session_id:id}),file);
  const m=getMetrics({session_id:id,turn_id:'turn'});
  assert.equal(m.found,true); assert.equal(m.metrics.duration_seconds,6); assert.equal(m.metrics.turn_tokens.input_tokens,100);assert.equal(m.pendingQuestion,true);
 } finally {
  if(oldHome===undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME=oldHome;
  fs.rmSync(tmp,{recursive:true,force:true});
 }
});

test('active Stop hook collects telemetry before task_complete exists, not previous task',()=>{
 const rows=[
   {type:'turn_context', timestamp:'2026-10-17T22:00:00Z',payload:{model:'gpt-5.6'}},
   ev('2026-10-17T22:00:00Z','task_started'),
   ev('2026-10-17T22:00:05Z','token_count',{info:info(100,80)}),
   ev('2026-10-17T22:00:15Z','task_complete'),
   ev('2026-10-17T22:01:00Z','task_started'),
   {type:'turn_context', timestamp:'2026-10-17T22:01:01Z',payload:{model:'gpt-6'}},
   ev('2026-10-17T22:01:20Z','token_count',{info:info(300,150),rate_limits:{primary:{used_percent:64,window_minutes:300,resets_at:1792362600},secondary:{used_percent:12,window_minutes:10080,resets_at:1792929600}}}),
   {type:'response_item',timestamp:'2026-10-17T22:01:23Z',payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'Should I continue?'}]}}
 ];
 const s=summarize(rows,true,'turn-new',{allowActive:true,nowMs:Date.parse('2026-10-17T22:01:24Z')});
 assert.equal(s.duration_seconds,24);
 assert.equal(s.duration_approximate,true);
 assert.equal(s.turn_tokens.input_tokens,200);
 assert.equal(s.model,'gpt-6');
 assert.equal(s.rate_limit_window_minutes.primary,300);
 assert.equal(s.rate_limit_window_minutes.secondary,10080);
 assert.equal(s.rate_limit_resets_at.primary,1792362600);
 assert.equal(s.rate_limit_resets_at.secondary,1792929600);
});

test('active Stop hook cannot borrow stale token data from previous task',()=>{
 const rows=[ev('2026-10-17T22:00:00Z','task_started'),ev('2026-10-17T22:00:05Z','token_count',{info:info(100,80)}),ev('2026-10-17T22:00:15Z','task_complete'),ev('2026-10-17T22:01:00Z','task_started')];
 const s=summarize(rows,true,null,{allowActive:true,nowMs:Date.parse('2026-10-17T22:01:24Z')});
 assert.equal(s.turn_tokens,undefined);
 assert.equal(s.session_tokens,undefined);
 assert.equal(s.context_percent_approx,undefined);
 assert.equal(s.duration_seconds,24);
});

test('an incomplete turn is still ignored unless Stop hook is explicitly active',()=>{
 const rows=[ev('2026-10-17T22:01:00Z','task_started'),ev('2026-10-17T22:01:20Z','token_count',{info:info(300,150)})];
 assert.deepEqual(summarize(rows,true),{});
});

test('live rollout with no task_complete includes usage and a final question',()=>{
 const oldHome=process.env.CODEX_HOME;
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-hook-live-'));
 try{
  process.env.CODEX_HOME=tmp;
  const id='01a145c6-b117-7533-84e4-ae01bf98ea0a';
  const dir=path.join(tmp,'sessions','2026','10','17');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,`rollout-2026-10-17T22-00-00-${id}.jsonl`);
  const rows=[ev('2026-10-17T22:00:00Z','task_started'),ev('2026-10-17T22:00:03Z','token_count',{info:info(100,80)}),
  {type:'turn_context',timestamp:'2026-10-17T22:00:03Z',payload:{model:'gpt-6'}},
  {type:'response_item',timestamp:'2026-10-17T22:00:04Z',payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'Can I proceed?'}]}}];
  fs.writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');
  const m=getMetrics({session_id:id,turn_id:'active-1'});
  assert.equal(m.found,true);
  assert.equal(m.metrics.turn_tokens.input_tokens,100);
  assert.equal(m.metrics.model,'gpt-6');
  assert.equal(m.pendingQuestion,true);
 }finally{
  if(oldHome===undefined) delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;
  fs.rmSync(tmp,{recursive:true,force:true});
 }
});


test('reset timestamps are optional and never guessed from window duration',()=>{
 const rows=[ev('2026-10-17T22:00:00Z','task_started'),
  ev('2026-10-17T22:00:01Z','token_count',{info:info(200,40),rate_limits:{primary:{used_percent:50,window_minutes:300},secondary:{used_percent:23,window_minutes:10080,resets_at:1792929600}}}),
  ev('2026-10-17T22:00:02Z','task_complete')];
 const s=summarize(rows,true);
 assert.equal(s.rate_limit_resets_at?.primary,undefined);
 assert.equal(s.rate_limit_resets_at?.secondary,1792929600);
});

test('reject invalid reset timestamps instead of fabricating precision',()=>{
 const rows=[ev('2026-10-17T22:00:00Z','task_started'),
  ev('2026-10-17T22:00:01Z','token_count',{info:info(200,40),rate_limits:{primary:{used_percent:50,window_minutes:300,resets_at:9999999999999},secondary:{used_percent:23,window_minutes:10080,resets_at:'soon'}}}),
  ev('2026-10-17T22:00:02Z','task_complete')];
 const s=summarize(rows,true);
 assert.equal(s.rate_limit_resets_at,undefined);
});

const {prepareFinalReply} = require('../codex-hooks/codex-rollout');

test('plan mode and reasoning effort come from the effective turn context',()=>{
  const rows=[ev('2026-10-17T22:00:00Z','task_started'),
    {type:'turn_context',timestamp:'2026-10-17T22:00:01Z',payload:{model:'gpt-6.1-sol',effort:'high',collaboration_mode:{mode:'plan',settings:{reasoning_effort:'medium'}}}},
    ev('2026-10-17T22:00:02Z','token_count',{info:info(100,40)}),ev('2026-10-17T22:00:04Z','task_complete')];
  const s=summarize(rows,true);
  assert.equal(s.model,'gpt-6.1-sol');
  assert.equal(s.reasoning_effort,'high');
  assert.equal(s.mode,'plan');
});

test('turn settings may precede task_started, and omitted fields stay omitted',()=>{
  const rows=[{type:'turn_context',timestamp:'2026-10-17T22:00:00Z',payload:{model:'gpt-6',collaboration_mode:{mode:'default',settings:{reasoning_effort:'xhigh'}}}},
    ev('2026-10-17T22:00:00Z','task_started'),ev('2026-10-17T22:00:04Z','task_complete')];
  const s=summarize(rows,true);
  assert.equal(s.reasoning_effort,'xhigh');
  assert.equal(s.mode,'default');
  const noContext=summarize([ev(t,'task_started'),ev(t,'task_complete')],true);
  assert.equal(noContext.reasoning_effort,undefined);
  assert.equal(noContext.mode,undefined);
});

test('final reply from the current turn only, not a previous assistant final',()=>{
 const oldHome=process.env.CODEX_HOME;
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-reply-'));
 try {
  process.env.CODEX_HOME=tmp;
  const id='01a145c6-b117-7533-84e4-ae01bf98ea0a';
  const dir=path.join(tmp,'sessions','2026','10','17');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,`rollout-2026-10-17T22-00-00-${id}.jsonl`);
  const rows=[ev(t,'task_started'),{type:'response_item',timestamp:t,payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'Previous secret'}]}},ev(t,'task_complete'),ev(t,'task_started')];
  fs.writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');
  const found=getMetrics({session_id:id,turn_id:'new-turn'});
  assert.equal(found.finalReply,'');
  assert.equal(found.pendingQuestion,false);
  const withHook=getMetrics({session_id:id,turn_id:'new-turn',last_assistant_message:'Actual final response'});
  assert.equal(withHook.finalReply,'Actual final response');
 } finally {
  if(oldHome===undefined) delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;
  fs.rmSync(tmp,{recursive:true,force:true});
 }
});

test('Discord reply size bounded, avoids surrogate split, and closes a truncated code fence',()=>{
  const result=prepareFinalReply('Intro\n```js\n'+ '😀'.repeat(3000));
  assert.ok(result.length<=3750);
  assert.ok(result.includes('*(response truncated for Discord)*'));
  assert.ok(result.includes('\n```\n\n…'));
  assert.equal(/[\uD800-\uDBFF]$/.test(result),false);
  assert.equal(prepareFinalReply('**Done**\n\n- First\n- Second'),'**Done**\n\n- First\n- Second');
  assert.equal(prepareFinalReply(null),'');
});

test('dry run reports final reply size but does not echo its text',()=>{
  const input={session_id:'foo',turn_id:'bar',cwd:'C:/work/demo',stop_hook_active:false};
  const original=process.env.CODE_NOTIFY_CODEX_INCLUDE_REPLY;
  try {
    delete process.env.CODE_NOTIFY_CODEX_INCLUDE_REPLY;
    const result=run(input,{dryRun:true,metrics:{metrics:{model:'gpt-6'},pendingQuestion:false,found:true,finalReply:'Top secret reply'}});
    assert.equal(result.reply_chars,16);
    assert.ok(!JSON.stringify(result).includes('Top secret'));
    process.env.CODE_NOTIFY_CODEX_INCLUDE_REPLY='0';
    const disabled=run(input,{dryRun:true,metrics:{metrics:{},pendingQuestion:false,found:true,finalReply:'Top secret reply'}});
    assert.equal(disabled.reply_chars,0);
  }finally{
    if(original===undefined) delete process.env.CODE_NOTIFY_CODEX_INCLUDE_REPLY;else process.env.CODE_NOTIFY_CODEX_INCLUDE_REPLY=original;
  }
});

test('PowerShell Discord payload supports embed and disables mentions',()=>{
  const ps=fs.readFileSync(path.join(__dirname,'../shared-code-notify/notify.ps1'),'utf8');
  assert.ok(ps.includes('allowed_mentions = @{ parse = @() }'));
  assert.ok(ps.includes("title = 'Codex final response'"));
  assert.ok(ps.includes('description = $reply'));
});
