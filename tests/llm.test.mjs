import assert from 'node:assert/strict';
import test from 'node:test';

import { extractChatCompletionText } from '../src/llm.js';

test('extracts ordinary OpenAI chat completion text', () => {
  assert.equal(extractChatCompletionText({ choices: [{ message: { content: '{"final_prompt":"scene"}' } }] }), '{"final_prompt":"scene"}');
});

test('extracts array-form content returned by compatible relays', () => {
  const data = { choices: [{ message: { content: [{ type: 'text', text: '{"final_prompt":"scene"}' }] } }] };
  assert.equal(extractChatCompletionText(data), '{"final_prompt":"scene"}');
});

test('extracts object-form structured content', () => {
  const value = extractChatCompletionText({ choices: [{ message: { content: { final_prompt: 'scene', avoid: 'blur' } } }] });
  assert.deepEqual(JSON.parse(value), { final_prompt: 'scene', avoid: 'blur' });
});
