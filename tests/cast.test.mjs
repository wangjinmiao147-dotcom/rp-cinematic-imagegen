import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCastCharacters } from '../src/cast.js';
import { buildFinalizerPrompt, buildOmniscientPrompt, normalizeFinalPromptOutput } from '../src/prompts.js';
import { resolveCastReferencePlan } from '../src/character-identities.js';

const castContext = {
  context: { name1: '周禾', name2: '女1' },
  chat: [
    { is_user: true, name: '周禾', mes: '前序消息' },
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
    excludedCharacters: ['女2', '周禾'],
  });
  assert.match(finalizer.userText, /明确不入镜名单/);
  assert.match(finalizer.userText, /女2/);
  assert.match(finalizer.userText, /周禾/);
});

test('policy refusal text is rejected instead of being sent to the image backend', () => {
  const refusal = "The prompt could not be submitted. The prompt contains sensitive words that violate Google's Generative AI Prohibited Use policy.";
  assert.equal(normalizeFinalPromptOutput(refusal), '');
  assert.equal(normalizeFinalPromptOutput('无法提交该提示词，因为其中包含敏感词并违反安全政策。'), '');
  assert.match(
    normalizeFinalPromptOutput('Cinematic two-shot of one male traveler and one young East Asian woman beside a campfire.'),
    /one male traveler and one young East Asian woman/,
  );
});

test('import suffix names match the same current card without changing actor labels or library keys',()=>{
  const card={name:'Example1',avatar:'Example11.png'};
  const [p]=resolveCastReferencePlan(['Example'],{characters:[card],focalCharacter:card});
  assert.equal(p.character,card);assert.equal(p.actorName,'Example');assert.equal(p.character.avatar,'Example11.png');
});

test('multiple named people and their aliases resolve to separate character cards',()=>{
  const a={name:'First',avatar:'first.png'},b={name:'Second2',avatar:'second.png'};
  const p=resolveCastReferencePlan(['First','Nickname','Player'],{characters:[a,b],focalCharacter:a,userName:'Player',aliases:{Nickname:'Second'}});
  assert.equal(p[0].character,a);assert.equal(p[1].character,b);assert.equal(p[2].kind,'user');
  assert.equal(p[1].actorName,'Nickname');
});

test('exact card names win over suffix heuristics and arbitrary prefixes never identify a person',()=>{
  const a={name:'First1',avatar:'copy.png'},b={name:'First',avatar:'original.png'};
  const [exact,partial]=resolveCastReferencePlan(['First','Fir'],{characters:[a,b],focalCharacter:a});
  assert.equal(exact.character,b);assert.equal(partial.kind,'unmatched');
});

test('ambiguous imported names need active-card context rather than the first library entry',()=>{
  const a={name:'Example1',avatar:'one.png'},b={name:'Example2',avatar:'two.png'};
  const [unknown]=resolveCastReferencePlan(['Example'],{characters:[a,b]});
  assert.equal(unknown.kind,'unmatched');
  const [current]=resolveCastReferencePlan(['Example'],{characters:[a,b],focalCharacter:b});
  assert.equal(current.character,b);
});

test('explicit per-card aliases and original data names are reusable for any character',()=>{
  const c={name:'Display',avatar:'person.png',data:{name:'Canonical',extensions:{rpig_aliases:['Nickname']}}};
  const p=resolveCastReferencePlan(['Canonical','Nickname'],{characters:[c]});
  assert.ok(p.every(x=>x.character===c));
});
