'use strict';
// Read-only local inspection. Does not send notifications or print conversation text.
const {findRollout,readTail,summarize}=require('../codex-hooks/codex-rollout');
const session_id=process.argv[2];
if (!session_id) {console.error('Usage: node tools/inspect-metrics.js <session-UUID>');process.exit(2);}
const file=findRollout({session_id});
if (!file) {console.error('No matching rollout found.');process.exit(1);}
const {events,complete}=readTail(file);
const stats=summarize(events,complete,null,{allowActive:true});
const last=events.filter(x=>x.type==='event_msg' && x.payload?.type==='token_count').at(-1);
console.log(JSON.stringify({rollout_found:true,read_scope:complete?'whole':'last-16-MiB',metrics:stats,latest_rate_limits_present:!!last?.payload?.rate_limits},null,2));
