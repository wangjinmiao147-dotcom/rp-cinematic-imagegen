import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage } from '../src/backends.js';
import { qwenSceneRenderPlan } from '../src/qwen.js';
import { postureRulesForStory } from '../src/visual-constraints.js';
import { resizeSceneOutput } from '../src/scene-output.js';
import { assembleUnifiedPrompt } from '../src/prompts.js';
import { qwenReferenceEditPrompt } from '../src/qwen.js';
import { supportedPosePlan, supportedPoseFixture, supportedPoseReference } from '../src/pose-layout.js';

const refs=[{dataUrl:'data:image/png;base64,YWJj',kind:'identity-primary',identityName:'A'},
    {dataUrl:'data:image/png;base64,ZGVm',kind:'identity-primary',identityName:'B'}];
const settings={backend:'gemini',backendUrl:'http://127.0.0.1:8055',backendModel:'qwen-image-2.1',
    stylePreset:'reference',imageSize:'16:9',qwenResolution:'512x288',qwenSteps:24,qwenCfg:1,qwenSceneDetail:true};
const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
function network(t) {
    const requests=[];
    t.mock.method(globalThis,'fetch',async(url,options)=>{
        if(url.endsWith('/rpig-capabilities'))return json({bridge:'rpig-qwen',protocol:2,reference_order:true,explicit_dimensions:true});
        requests.push(JSON.parse(options.body));
        return json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'YWJj'}}]}}]});
    });
    return requests;
}

test('whole-scene detail is opt-in and requires a primary identity',()=>{
    assert.equal(qwenSceneRenderPlan({...settings,qwenSceneDetail:false},refs),null);
    assert.equal(qwenSceneRenderPlan({},refs),null);
    assert.equal(qwenSceneRenderPlan(settings,[{kind:'continuity'}]),null);
});

test('supported aspects retain a final 512 long edge with aligned render canvases',()=>{
    for(const [ratio,value] of [['16:9',16/9],['9:16',9/16],['1:1',1],['4:3',4/3],['3:4',3/4],['2.39:1',2.39]]){
        const plan=qwenSceneRenderPlan({...settings,imageSize:ratio},refs);
        assert.equal(Math.max(...plan.outputSize),512);
        assert.ok(Math.abs(plan.outputSize[0]/plan.outputSize[1]/value-1)<.0025);
        assert.ok(plan.renderSize.every(n=>n%32===0 && n>=256 && n<=1024));
        assert.ok(plan.renderSize[0]*plan.renderSize[1]<=1024*768);
    }
});
test('reflection scenes retain their validated path without mistaking generic template rules for story facts',()=>{
    assert.equal(qwenSceneRenderPlan(settings,refs,'16:9','A touches her reflection in a wall mirror.'),null);
    const onlyPreserved=assembleUnifiedPrompt({editInstruction:'A stands in the same room.',preserve:'The wall mirror and her visible reflection.'});
    assert.equal(qwenSceneRenderPlan(settings,refs,'16:9',onlyPreserved),null);
    const ordinary=assembleUnifiedPrompt({editInstruction:'A and B read beside the window.'});
    assert.deepEqual(qwenSceneRenderPlan(settings,refs,'16:9',ordinary).renderSize,[1024,576]);
});
test('enabling clarity does not change the sent mirror wording, guide, reference processing or sampler controls',async t=>{
    const requests=network(t),mirrorRefs=[refs[0]];
    const full=assembleUnifiedPrompt({editInstruction:'Show A alone standing facing a vertical wall mirror. Observe her from behind and slightly to her left; her body and head remain directed toward the mirror. Her raised right palm touches the mirror at shoulder height and her left arm hangs at her side.'})+'\nVISIBLE CAST (1): A.';
    const opts={resizeSceneImage:()=>{throw Error('Mirror must retain the saved output');}};
    await generateImage({...settings,qwenSceneDetail:false,qwenReferenceProfile:'balanced'},full,'',mirrorRefs,opts);
    await generateImage({...settings,qwenSceneDetail:true,qwenReferenceProfile:'balanced'},full,'',mirrorRefs,opts);
    assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
    assert.deepEqual([requests[1].width,requests[1].height,requests[1].steps,requests[1].cfg_scale],[512,288,24,1]);
    assert.equal(requests[1].contents[0].parts.filter(p=>p.inlineData).length,2);
});

test('one detail generation retains saved steps, CFG, both identities and final dimensions',async t=>{
    const requests=network(t),before=structuredClone(settings),diagnostics={};let resized=0;
    const result=await generateImage(settings,'Show A and B reading beside the window.','',refs,{diagnostics,
        resizeSceneImage:async(data,plan)=>{resized++;assert.deepEqual(plan.renderSize,[1024,576]);assert.deepEqual(plan.outputSize,[512,288]);return 'data:image/png;base64,ZmluYWw=';}});
    assert.equal(requests.length,1);assert.equal(resized,1);
    assert.deepEqual([requests[0].width,requests[0].height,requests[0].steps,requests[0].cfg_scale],[1024,576,24,1]);
    assert.equal(requests[0].reference_profile,'detail');
    assert.equal(requests[0].contents[0].parts.filter(p=>p.inlineData).length,2);
    assert.deepEqual(result.outputSize,[512,288]);assert.deepEqual(diagnostics.outputSize,[512,288]);
    assert.equal(diagnostics.sceneRendering.diffusionPasses,1);assert.deepEqual(settings,before);
});

test('turning whole-scene detail off retains the explicitly selected lightweight path',async t=>{
    const requests=network(t);
    const result=await generateImage({...settings,qwenSceneDetail:false},'Show A reading.','',refs,
        {resizeSceneImage:()=>{throw Error('Unexpected resize');}});
    assert.equal(requests.length,1);assert.deepEqual([requests[0].width,requests[0].height],[512,288]);
    assert.equal(result.dataUrl,'data:image/png;base64,YWJj');
});

test('failed final resizing never returns an internal-resolution illustration as the final output',async t=>{
    network(t);
    await assert.rejects(generateImage(settings,'Show A reading.','',refs,{resizeSceneImage:()=>{throw Error('decode failed');}}),/decode failed/);
});

test('back support guidance is scoped to supported backs and preserves explicit arching',()=>{
    assert.match(postureRulesForStory('A leans her back against the washbasin. B leans forward.'),/figure whose back is supported/);
    for(const text of ['A leans forward over the basin.','A arches her back against the stage prop.','A rests her waist against the table.','A floats above the ground.']){
        assert.doesNotMatch(postureRulesForStory(text),/figure whose back is supported|gently inclined/);
    }
    assert.match(postureRulesForStory('A is explicitly arching backward.'),/Explicit bending, arching/);
});

test('compact detail prompts retain the selected action, wardrobe, view and partial participant scope',()=>{
    const story='Show A leaning her back against the basin. B is visible only as a hand offering a folded towel. Observe from behind, with her head facing away.';
    const full=assembleUnifiedPrompt({editInstruction:story,preserve:'Her current burgundy blouse.',exclude:['the former crown','B\'s face and torso']});
    const sent=qwenReferenceEditPrompt(full,refs,{compactScene:true});
    for(const text of [story,'Her current burgundy blouse','the former crown','B\'s face and torso','<image1>','<image2>'])assert.ok(sent.includes(text),text);
    assert.match(sent,/identity separate/);assert.match(sent,/hand-only participants remain hand-only/);
    assert.match(sent,/unseen features remain hidden/);assert.match(sent,/not a scene canvas/);
    assert.doesNotMatch(sent,/FRAMING PREFERENCE:|REFERENCE MAPPING:|new schema/);
});

function imageFixture(width,height){return class {
    naturalWidth=width;naturalHeight=height;
    set src(value){if(value)queueMicrotask(()=>this.onload?.());}
};}
test('final resize retains every edge of the full image and reduces to the requested canvas',async()=>{
    const calls=[],context={drawImage:(...args)=>calls.push(args)};
    const canvas={getContext:()=>context,toDataURL:()=>`data:image/png;size=${canvas.width}x${canvas.height}`};
    const result=await resizeSceneOutput('fixture',{renderSize:[1024,576],outputSize:[512,288]},
        {Image:imageFixture(1024,576),document:{createElement:()=>canvas}});
    assert.equal(result,'data:image/png;size=512x288');assert.equal(context.imageSmoothingQuality,'high');
    assert.deepEqual(calls[0].slice(1),[0,0,512,288]);
});
test('incorrect bridge dimensions and canceled output are rejected before a canvas can be saved',async()=>{
    const env={Image:imageFixture(512,288),document:{createElement:()=>{throw Error('Unexpected canvas');}}};
    await assert.rejects(resizeSceneOutput('fixture',{renderSize:[1024,576],outputSize:[512,288]},env),{code:'SCENE_RENDER_SIZE_MISMATCH'});
    await assert.rejects(resizeSceneOutput('fixture',{renderSize:[1024,576],outputSize:[512,288]},
        {...env,signal:AbortSignal.abort()}),{name:'AbortError'});
});

const supportedStory='Show A leaning her back against a washbasin. Her hands rest near her abdomen. B bends the upper body forward and offers a towel with the right hand. Observe from a front three-quarter view.';
const supportedFull=story=>assembleUnifiedPrompt({editInstruction:story})+'\nVISIBLE CAST (2): A, B.';
test('supported posture reference retains explicit working side and declines incompatible poses',()=>{
    const plan=supportedPosePlan(supportedFull(supportedStory),refs,settings);
    assert.equal(plan.kind,'supported-back-two-people');assert.equal(plan.hand,'right');
    const left=supportedPosePlan(supportedFull(supportedStory.replace('right hand','left hand')),refs,settings);
    assert.equal(left.hand,'left');
    for(const edit of [supportedStory.replace('leaning her back','arching her back'),supportedStory+' Use a strict profile.',
        supportedStory.replace('front three-quarter','rear'),supportedStory+' Keep her confirmed serpent tail.',
        supportedStory.replace('her back against','her waist against')])assert.equal(supportedPosePlan(supportedFull(edit),refs,settings),null,edit);
    assert.equal(supportedPosePlan(supportedFull(supportedStory),refs,{...settings,qwenSceneDetail:false}),null);
});
test('unspecified hand and camera remain unspecified scene facts while the guide makes a neutral rendering choice',()=>{
    const edit=supportedStory.replace('with the right hand','using one hand').replace(' Observe from a front three-quarter view.','');
    const plan=supportedPosePlan(supportedFull(edit),refs,settings);
    assert.equal(plan.hand,null);assert.equal(plan.cameraSource,'unspecified-neutral-camera');
    const ref=supportedPoseReference(plan,512,288);
    const sent=qwenReferenceEditPrompt(supportedFull(edit),[...refs,ref],{compactScene:true});
    assert.match(sent,/working hand reaching/);assert.doesNotMatch(sent,/working right hand|working left hand/);
});
test('the pose guide uses continuous torso inclinations with complete figures and correctly owned working arms',()=>{
    const plan=supportedPosePlan(supportedFull(supportedStory),refs,settings),fixture=supportedPoseFixture(plan);
    const [a,b]=fixture.people;
    assert.ok(a.head[0]<a.rib[0] && a.rib[0]<a.waist[0] && a.waist[0]<a.hip[0]);
    assert.ok(b.head[0]<b.hip[0]);assert.ok(b.rightPalm[0]<b.rightShoulder[0]);
    const ref=supportedPoseReference(plan,1024,576);
    assert.equal(ref.role,'scene-layout');
    const bytes=Buffer.from(ref.dataUrl.split(',')[1],'base64');assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[1024,576]);
    for(const person of ref.projectedPeople)assert.ok(Object.values(person).every(([x,y])=>x>0 && x<1024 && y>0 && y<576));
});
test('supported scene sends two identities and one geometry reference in a single detail request',async t=>{
    const requests=network(t),diagnostics={};
    const result=await generateImage(settings,supportedFull(supportedStory),'',refs,{diagnostics,resizeSceneImage:async()=> 'data:image/png;base64,YWJj'});
    assert.equal(requests.length,1);assert.equal(requests[0].contents[0].parts.filter(p=>p.inlineData).length,3);
    assert.equal(diagnostics.references[2].role,'scene-layout');assert.deepEqual(diagnostics.poseGeometry.identityNames,['A','B']);
    assert.match(result.usedPrompt,/left mannequin with A and the right mannequin with B/);
    assert.match(result.usedPrompt,/geometry in <image3>/);assert.doesNotMatch(result.usedPrompt,/five toes|one thumb and four fingers/);
});
