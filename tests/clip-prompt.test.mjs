import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleUnifiedPrompt,compactClipPrompt,preparePromptForBackend,isClipDiffusionBackend} from '../src/prompts.js';
const unified=assembleUnifiedPrompt({editInstruction:'A woman gives a yellow book to the man on her right in a stone courtyard.',preserve:'The woman has teal hair; the man wears a blue coat.',exclude:['extra people']});
test('CLIP receives the real scene before any editing boilerplate',()=>{
 const short=compactClipPrompt(unified.replace(/\s+/g,' '));
 assert.ok(short.startsWith('A woman gives a yellow book'));assert.ok(short.includes('teal hair'));
 assert.ok(short.includes('blue coat'));assert.ok(short.length<400);
 assert.doesNotMatch(short,/REFERENCE ROLES|BODY STRUCTURE|FRAMING PREFERENCE/);
});
test('explicit SD presets receive compact scene text while Gemini and Qwen keep editing instructions',()=>{
 for(const s of [{backend:'sd'},{backend:'tavern-sd'},...['sd-text','sd-img2img','sd-cast'].map(comfyPreset=>({backend:'comfyui',comfyPreset}))]){
  assert.equal(isClipDiffusionBackend(s),true);assert.ok(preparePromptForBackend(s,unified,'extra people').prompt.startsWith('A woman gives'));
 }
 for(const s of [{backend:'gemini'},{backend:'openai'},{backend:'comfyui',comfyPreset:'qwen-edit'},{backend:'comfyui',comfyPreset:'custom'}]){
  assert.equal(isClipDiffusionBackend(s),false);assert.equal(preparePromptForBackend(s,unified,'').prompt,unified);
 }
});
test('handwritten prompts and unrecognized edited templates remain intact',()=>{
 for(const text of ['two people, yellow book','Edit the supplied references with this handwritten instruction','REQUESTED CHANGES: hand-only contact']) assert.equal(compactClipPrompt(text),text);
});
