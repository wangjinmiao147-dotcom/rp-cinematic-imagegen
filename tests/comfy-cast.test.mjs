import test from 'node:test';
import assert from 'node:assert/strict';
import {buildComfyPresetWorkflow,getComfyPreset,inspectComfyCapabilities} from '../src/comfy-presets.js';
import {generateImage} from '../src/backends.js';
import {buildReferencePlan,referenceBudgetFor} from '../src/reference-plan.js';

const settings={backend:'comfyui',comfyPreset:'sd-cast',comfySamplingProfile:'lcm',comfyCheckpoint:'sd.safetensors',imageSize:'16:9',comfySeed:314159};
test('four references all reach the composed latent and each has a distinct local text region',()=>{
 const files=['a.png','b.png','c.png','d.png'];
 const {workflow:w}=buildComfyPresetWorkflow(settings,{prompt:'four adults in one courtyard',uploadedImages:files,referencePrompts:['silver-haired man in red','violet-haired woman','black-haired man in blue','teal-haired winged woman']});
 assert.deepEqual(Object.values(w).filter(n=>n.class_type==='LoadImage').map(n=>n.inputs.image),files);
 assert.deepEqual(w['11'].inputs.pixels,['38',0]);
 for(let index=0;index<4;index++){
  assert.deepEqual(w[String(31+index*2)].inputs.image,[String(20+index),0]);
  const composite=w[String(32+index*2)];assert.equal(composite.class_type,'ImageCompositeMasked');
  assert.deepEqual(composite.inputs.source,[String(31+index*2),0]);
  assert.deepEqual(composite.inputs.destination,[String(index?30+index*2:30),0]);
  const area=w[String(51+index*3)];assert.equal(area.inputs.x,index*192);assert.equal(area.inputs.width,192);
 }
 assert.deepEqual(w['12'].inputs.positive,['61',0]);assert.equal(w['12'].inputs.sampler_name,'lcm');
 assert.equal(Object.values(w).some(n=>/IPAdapter|Lora/.test(n.class_type)),false);
});
test('the cast preset cannot quietly load a global character LoRA or ignore its matching text',()=>{
 assert.throws(()=>buildComfyPresetWorkflow(settings,{prompt:'scene',uploadedImages:['a','b'],referencePrompts:['one','two'],loras:[{name:'role.safetensors'}]}),{code:'COMFY_LORA_UNSUPPORTED'});
 assert.throws(()=>buildComfyPresetWorkflow(settings,{prompt:'scene',uploadedImages:['a','b'],referencePrompts:['one']}),{code:'COMFY_CONTROL_INVALID'});
 assert.throws(()=>buildComfyPresetWorkflow(settings,{prompt:'scene',uploadedImages:['a','b','c','d','e'],referencePrompts:['1','2','3','4','5']}),{code:'COMFY_REFERENCE_LIMIT'});
});
test('auxiliary views of a person never become extra bodies in a cast layout',()=>{
 const refs=[{role:'identity-primary',identityId:'character:a'}, {role:'identity-supporting',identityId:'character:a'},
 {role:'identity-primary',identityId:'character:b'}, {role:'identity-supporting',identityId:'character:b'}];
 const budget=referenceBudgetFor(settings), plan=buildReferencePlan(refs,budget);
 assert.equal(budget.maxReferences,4);assert.equal(budget.primaryOnly,true);
 assert.deepEqual(plan.refs.map(r=>r.identityId),['character:a','character:b']);assert.equal(plan.omitted.length,2);
});
test('malformed multi-person inputs stop before capability checks and uploads',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('must not request');});
 const bytes=['data:image/png;base64,YQ==','data:image/png;base64,Yg=='];
 await assert.rejects(generateImage(settings,'scene','',bytes.map((dataUrl,index)=>({dataUrl,role:'identity-primary',identityId:'character:one',identityName:'one'}))),{code:'COMFY_CAST_REFERENCE_INVALID'});
 assert.equal(calls,0);
});
test('cast sampling metadata and required model family stay SD',()=>{
 assert.equal(getComfyPreset(settings).defaultSteps,8);assert.equal(getComfyPreset(settings).modelFamily,'sd');
 const result=inspectComfyCapabilities({},settings);assert.ok(result.missingNodes.includes('ImageCompositeMasked'));
 assert.ok(result.missingNodes.includes('ConditioningSetArea'));assert.ok(result.missingNodes.includes('ModelSamplingDiscrete'));
});
