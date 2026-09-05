import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCastCharacters } from '../src/cast.js';
import { buildFinalizerPrompt, buildOmniscientPrompt } from '../src/prompts.js';

const castContext = {
  context: { name1: '秋刀鱼', name2: '女1' },
  chat: [
    { is_user: true, name: '秋刀鱼', mes: '前序消息' },
    { is_user: false, name: '女1', mes: '女1独自留在房间里。' },
  ],
  messageIndex: 1,
  focalCharacter: { name: '女1' },
};

test('a one-person LLM cast stays one-person instead of forcing user plus focal character', () => {
  assert.deepEqual(
    normalizeCastCharacters([{ canonical_name: '女1', presence_evidence: '女1独自留在房间里' }], castContext),
    ['女1'],
  );
});

test('empty visible cast conservatively falls back to the current message character only', () => {
  assert.deepEqual(normalizeCastCharacters([], castContext), ['女1']);
});

test('explicitly absent candidates are excluded and exclusions can disable fallback', () => {
  assert.deepEqual(
    normalizeCastCharacters([{ canonical_name: '女2', present: false }], { ...castContext, fallbackToFocal: false }),
    [],
  );
});

test('cast prompts require physical-presence evidence and pass exclusions to finalization', () => {
  const omniscient = buildOmniscientPrompt({ currentMessageText: '女1独自留在房间里。' });
  assert.match(omniscient.system, /presence_evidence/);
  assert.match(omniscient.userText, /证据不足一律放入 excluded_characters/);

  const finalizer = buildFinalizerPrompt({
    directorDraft: 'draft',
    visibleCharacters: ['女1'],
    excludedCharacters: ['女2', '秋刀鱼'],
  });
  assert.match(finalizer.userText, /明确不入镜名单/);
  assert.match(finalizer.userText, /女2/);
  assert.match(finalizer.userText, /秋刀鱼/);
});
