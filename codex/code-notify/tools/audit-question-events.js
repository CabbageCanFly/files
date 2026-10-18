'use strict';
// Dry-run only: audit event TYPES of Codex interactive questions, never text.
const path = require('path');
const {findRollout, readTail} = require('../codex-hooks/codex-rollout');
const id = process.argv[2];
if (!id) {console.error('Usage: node tools/audit-question-events.js <Codex-session-UUID>');process.exit(2);}
const file = findRollout({session_id:id});
if (!file) {console.error('No matching Codex rollout found.');process.exit(1);}
const {events, complete} = readTail(file);
const matches = [];
for (const e of events) {
  let kind='', name='';
  const p=e?.payload;
  if (!p || typeof p !== 'object') continue;
  if (typeof p.type === 'string' && /user.?input|elicitation|question|approval|permission|prompt/i.test(p.type)) kind=p.type;
  if (e.type === 'response_item' && p.type === 'function_call' && typeof p.name === 'string' && /request_user_input|ask_user|elicitation/i.test(p.name)) {kind='function_call';name=p.name;}
  if (kind) matches.push({when:e.timestamp || null, record_type:e.type, event_type:kind, tool_name:name || undefined});
}
console.log(JSON.stringify({session:id, portion:complete?'full':'last-16-MiB-only', matching_event_types:matches.slice(-100), total_matches_in_portion:matches.length},null,2));
