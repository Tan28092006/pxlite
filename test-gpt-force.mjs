// GPT path: >=180k estimated tokens forces collapse even with few messages (Chat Completions + Responses).
import assert from 'node:assert/strict';
import { transformOpenAIChatCompletions, transformOpenAIResponses } from './vendor/pxpipe-proxy/dist/core/openai.js';
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const msgs = (n, size) => { const a=[{role:'system',content:'x'}];
  for (let i=0;i<n;i++) a.push({role:i%2?'assistant':'user',content:('line '+i+' abc def ghi\n').repeat(Math.ceil(size/20))}); return a; };
const chat = async (n,size) => (await transformOpenAIChatCompletions(enc({model:'gpt-6.2-sol',messages:msgs(n,size)}),{})).info;
const collapsed = (i) => (i.collapsedTurns ?? 0) > 0 || i.historyReason === 'collapsed';
// 30 messages x 100KB = 3MB chars -> far above 180k tokens but below 50 messages
const a = await chat(30, 100000);
console.log('forced', a.historyReason, a.collapsedTurns);
assert.ok(collapsed(a), 'forced collapse above 180k with <50 messages');
const small = await chat(30, 2000);
assert.ok(!collapsed(small), 'small stays');
process.env.PXLITE_FORCE_COLLAPSE_TOKENS = '0';
const b = await chat(30, 100000);
console.log('disabled', b.historyReason);
assert.ok(!collapsed(b), 'disabled -> normal 50 message gate');
delete process.env.PXLITE_FORCE_COLLAPSE_TOKENS;
const r = (await transformOpenAIResponses(enc({model:'gpt-6.2-sol',instructions:'x',input:[{role:'user',content:[{type:'input_text',text:'go'}]},...Array.from({length:20},(_,i)=>[{type:'function_call',call_id:'c'+i,name:'s',arguments:'{}'},{type:'function_call_output',call_id:'c'+i,output:('l'+i+' abc\n').repeat(6000)}]).flat()]}),{})).info;
assert.ok((r.responsesComposition?.collapsedFunctionPairs ?? 0) > 0, 'responses forced');
console.log('ok');
