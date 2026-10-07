import test from 'node:test';
import assert from 'node:assert/strict';
import {callLLM,looksLikeModelRefusal} from '../src/llm.js';
import {RpigError} from '../src/utils.js';
import {parseAnalysisResponse} from '../src/analysis-validation.js';
const settings={llmSource:'custom',llmUrl:'http://primary.test/v1',llmModel:'gemini-test',llmKey:'unit-primary-key',llmFallbackEnabled:true,llmFallbackUrl:'http://local.test/v1',llmFallbackModel:'local-test',llmPrimaryTimeoutSeconds:60,llmFallbackTimeoutSeconds:180};
const reply=text=>new Response(JSON.stringify({choices:[{message:{content:text}}]}),{status:200,headers:{'Content-Type':'application/json'}});
async function withFetch(fn,run){const before=globalThis.fetch;globalThis.fetch=fn;try{return await run();}finally{globalThis.fetch=before;}}
test('cloud success does not invoke local and narrative refusal is not a provider refusal',async()=>{
  let calls=0;const story=JSON.stringify({action:'林岚拒绝接过钥匙'});
  await withFetch(async()=>{calls++;return reply(story);},async()=>{assert.equal(await callLLM('system','story',settings,null,{jsonMode:true,validateResponse:JSON.parse}),story);});
  assert.equal(calls,1);assert.equal(looksLikeModelRefusal(story),false);
});
test('only the failed stage falls back and the next stage returns to cloud',async()=>{
  const calls=[];let cloudCalls=0;const notices=[];
  await withFetch(async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body),auth:opts.headers.Authorization});if(url.includes('primary'))return reply(++cloudCalls===1?'抱歉，我不能完成此任务。':'{"stage":2}');return reply('{"stage":1}');},async()=>{
    assert.equal(await callLLM('system','original story',settings,null,{jsonMode:true,validateResponse:JSON.parse,onFallback:d=>notices.push(d)}),'{"stage":1}');
    assert.equal(await callLLM('next system','next input',settings,null,{jsonMode:true,validateResponse:JSON.parse}),'{"stage":2}');
  });
  assert.deepEqual(calls.map(c=>c.body.model),['gemini-test','local-test','gemini-test']);assert.equal(calls[1].auth,undefined);
  assert.equal(calls[1].body.messages[1].content,'original story');assert.equal(notices[0].reason,'refusal');
});
test('invalid analysis is retried once locally and local analysis is validated too',async()=>{
  let calls=0;
  await withFetch(async()=>reply(++calls===1?'bad schema':'valid'),async()=>{
    assert.equal(await callLLM('system','story',settings,null,{validateResponse:raw=>{if(raw!=='valid')throw new RpigError('ANALYSIS_INVALID_SCHEMA','invalid');}}),'valid');
  });assert.equal(calls,2);
  calls=0;
  await withFetch(async()=>{calls++;return reply('bad');},async()=>{
    await assert.rejects(callLLM('system','story',settings,null,{validateResponse:()=>{throw new RpigError('ANALYSIS_INVALID_EVIDENCE','bad evidence');}}),/本地回退也未通过/);
  });assert.equal(calls,2);
});
test('cloud timeout falls back without waiting for an unbounded retry',async()=>{
  let calls=0;
  await withFetch(async()=>{if(++calls===1)throw new DOMException('timed out','TimeoutError');return reply('ok');},async()=>{assert.equal(await callLLM('system','story',settings,null),'ok');});assert.equal(calls,2);
});
test('a cloud HTTP failure invokes local once',async()=>{
  let calls=0;
  await withFetch(async()=>++calls===1?new Response('upstream unavailable',{status:503}):reply('ok'),async()=>{assert.equal(await callLLM('system','story',settings,null),'ok');});assert.equal(calls,2);
});
test('manual cancellation never starts local inference',async()=>{
  const controller=new AbortController();let calls=0;
  await withFetch(async()=>{calls++;controller.abort();throw new DOMException('cancelled','AbortError');},async()=>{await assert.rejects(callLLM('system','story',settings,null,{signal:controller.signal}));});assert.equal(calls,1);
});
test('manual cancellation during fallback stops without another provider attempt',async()=>{
  const controller=new AbortController();let calls=0;
  await withFetch(async()=>{if(++calls===1)return reply('I cannot complete this task.');controller.abort();throw new DOMException('cancelled','AbortError');},async()=>{await assert.rejects(callLLM('system','story',settings,null,{signal:controller.signal}));});assert.equal(calls,2);
});
test('disabled fallback keeps the original provider behavior',async()=>{
  let calls=0;
  await withFetch(async()=>{calls++;return new Response('unavailable',{status:503});},async()=>{await assert.rejects(callLLM('system','story',{...settings,llmFallbackEnabled:false},null),/503/);});assert.equal(calls,1);
});

test('Tavern quiet generation also respects the cloud deadline before local fallback',async()=>{
  const original=AbortSignal.timeout;let calls=0;
  AbortSignal.timeout=()=>AbortSignal.abort(new DOMException('timed out','TimeoutError'));
  try{await withFetch(async()=>{calls++;return reply('local success');},async()=>{
    assert.equal(await callLLM('system','story',{...settings,llmSource:'tavern'},()=>({generateQuietPrompt:()=>new Promise(()=>{})})),'local success');
  });}finally{AbortSignal.timeout=original;}assert.equal(calls,1);
});
test('JSON compatibility retry shares a single primary deadline',async()=>{
  const signals=[];
  await withFetch(async(url,opts)=>{signals.push(opts.signal);return signals.length===1?new Response('unsupported response_format',{status:400}):reply('{"ok":true}');},async()=>{
    assert.equal(await callLLM('system','story',settings,null,{jsonMode:true}),'{"ok":true}');
  });assert.equal(signals.length,2);assert.equal(signals[0],signals[1]);
});

test('a translated canonical identity triggers only this stage to retry locally',async()=>{
  let calls=0;const encode=name=>JSON.stringify({edit_instruction:name+' points at one key with her left hand.',preserve:'',exclude:[],thought_bubble_instruction:''});
  await withFetch(async()=>reply(encode(++calls===1?'Lin Lan':'林岚')),async()=>{
    const raw=await callLLM('system','original scene',settings,null,{validateResponse:raw=>parseAnalysisResponse(raw,3,{latestStory:'林岚左手指着一把钥匙。',expectedCharacterNames:['林岚']})});
    assert.match(raw,/林岚/);
  });assert.equal(calls,2);
});
test('a name mentioned only in exclusions cannot satisfy a visible actor identity',()=>{
  const raw=JSON.stringify({edit_instruction:'A woman points at the key.',preserve:'',exclude:['林岚'],thought_bubble_instruction:''});
  assert.throws(()=>parseAnalysisResponse(raw,3,{latestStory:'林岚左手指着钥匙。',expectedCharacterNames:['林岚']}),e=>e.code==='ANALYSIS_IDENTITY_MISMATCH');
});
