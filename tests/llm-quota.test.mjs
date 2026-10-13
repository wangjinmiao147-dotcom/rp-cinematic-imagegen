import test from 'node:test';
import assert from 'node:assert/strict';
import {callLLM} from '../src/llm.js';
test('quota exhaustion has an exportable code without exposing the configured key', async t=>{
 let count=0;t.mock.method(globalThis,'fetch',async()=>{count++;return new Response('quota exhausted, key=test-secret',{status:429});});
 await assert.rejects(callLLM('system','user',{llmSource:'custom',llmUrl:'http://llm.test/v1',llmKey:'test-secret',llmModel:'text'}),error=>{
  assert.equal(error.code,'LLM_RATE_LIMITED');assert.match(error.message,/LLM HTTP 429/);assert.doesNotMatch(error.message,/test-secret/);return true;
 });assert.equal(count,1);
});
