import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createImageRetryCache, imageRetrySignature } from '../src/image-retry.js';
import * as utils from '../src/utils.js';

// Execute the actual task function with isolated host/API adapters. This checks
// the production orchestration, including all three text stages and the review.
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
const taskSource=source.slice(source.indexOf('async function executeGenerationTask('),source.indexOf('\nasync function generateCharacterSheetFlow('));
function fixture() {
    const message={mes:'The character sits at a desk.',send_date:'today',swipe_id:0};
    const character={name:'Test',avatar:'test.png',description:'A test character'};
    const settings={backend:'openai',backendUrl:'https://api.test/v1',backendModel:'image',shotMode:'snapshot',useCharacterImage:false,previewBeforeGeneration:true};
    const context={chat:[message],chatId:'chat-one',saveChat:async()=>{}};
    const cache=createImageRetryCache();
    const state={textCalls:0,imageCalls:[],reviews:0,refReads:0,failImage:true,failText:false,failRefs:false,cancelImage:false,toasts:[]};
    const dependencies={...utils,rpigImageRetryCache:cache,imageRetrySignature,getContext:()=>context,getChatSessionKey:c=>c.chatId,getSettings:()=>settings,
        getCharacterForMessage:()=>character,getCurrentCharacter:()=>character,getPreviousGeneratedImage:()=>null,
        setGenStatus:()=>{},toastr:Object.fromEntries(['info','warning','success','error'].map(type=>[type,(message,_title,options)=>state.toasts.push({type,message,options})])),
        buildDialogueContext:chat=>chat.map(m=>m.mes).join('\n'),buildParticipantContext:()=> 'participants',getCharacterVisualAnchor:()=>character.description,
        buildDirectorPrompt:()=>({system:'director',userText:'test'}),buildOmniscientPrompt:()=>({system:'omniscient',userText:'test'}),buildFinalizerPrompt:()=>({system:'finalizer',userText:'test'}),
        callLLM:async system=>{state.textCalls++;if(state.failText)throw new Error('text endpoint failed');return system==='director'?JSON.stringify({final_prompt:'director draft',scene_anchor:'desk'}):system==='omniscient'?JSON.stringify({ensemble_prompt:'ensemble draft',visible_characters:['Test']}):'Final analyzed prompt';},
        parseDirectorLlmOutput:raw=>({json:JSON.parse(raw),finalPrompt:JSON.parse(raw).final_prompt}),normalizeCastCharacters:()=>['Test'],getFinalizerLlmSettings:s=>s,
        normalizeFinalPromptOutput:raw=>raw,collapsePromptToSingleParagraph:p=>p,enforceOmniscientEnsemble:p=>p,
        getCharacterAvatarDataUrl:async()=>{state.avatarReads=(state.avatarReads||0)+1;return null;},getCharacterRefs:async()=>{state.refReads++;if(state.failRefs)throw new Error('reference read failed');return state.refs||[];},
        buildSceneAwareImagePrompt:({basePrompt})=>basePrompt+' + reference instructions',
        reviewFinalPrompt:async()=>{state.reviews++;return{confirmed:true,prompt:'User edited final prompt',avoid:'User edited negative'};},
        generateImage:async(s,p,a,refs)=>{state.imageCalls.push({settings:{...s},prompt:p,avoid:a,refs});if(state.cancelImage)throw utils.createAbortError();if(state.failImage)throw new Error('image backend failed');return{dataUrl:'data:image/png;base64,YWJj',model:'image',usedRefs:true};},
        fetchToDataUrl:async()=>'',SlashCommandParser:{},persistMediaUrl:async()=>'/saved.png',saveBase64AsFile:()=>{},migrateLegacyMedia:()=>{},
        $:()=>({addClass(){return this;}}),updateMessageBlock:()=>{},ensureFallbackMediaRender:()=>{},saveToGallery:async()=>{},
    };
    const execute=new Function(...Object.keys(dependencies),taskSource+';return executeGenerationTask;')(...Object.values(dependencies));
    return{state,message,settings,context,character,cache,run:(overrides={})=>execute({messageIndex:0,controller:new AbortController(),...overrides})};
}

test('image failure retries only images, preserving manual edits and skipping repeat review',async()=>{
    const f=fixture();assert.ok((await f.run()).error);assert.equal(f.state.textCalls,3);assert.equal(f.state.reviews,1);
    f.settings.backendUrl='https://fixed-api.test/v1';f.settings.backendModel='fixed-image';f.state.failImage=false;
    assert.equal((await f.run()).success,true);assert.equal(f.state.textCalls,3);assert.equal(f.state.reviews,1);assert.equal(f.state.refReads,2);
    assert.equal(f.state.imageCalls.length,2);assert.equal(f.state.imageCalls[1].prompt,'User edited final prompt');assert.equal(f.state.imageCalls[1].avoid,'User edited negative');
    assert.equal(f.state.imageCalls[1].settings.backendUrl,'https://fixed-api.test/v1');
    await f.run();assert.equal(f.state.textCalls,6,'success must clear the failed-attempt cache');
});

test('multiple image failures keep the same completed analysis',async()=>{
    const f=fixture();await f.run();await f.run();await f.run();assert.equal(f.state.textCalls,3);assert.equal(f.state.imageCalls.length,3);assert.equal(f.state.reviews,1);
});

test('manual retry reuses completed automatic analysis instead of discarding its preset',async()=>{
    const f=fixture();await f.run({presetPrompt:'Auto director result',generationMeta:{automatic:true,sceneAnchor:'desk',sceneChanged:true}});
    assert.equal(f.state.textCalls,2);await f.run();assert.equal(f.state.textCalls,2);assert.equal(f.state.imageCalls.length,2);
});

test('reference failure after text completion retries reference reading without text calls',async()=>{
    const f=fixture();f.state.failRefs=true;assert.ok((await f.run()).error);assert.equal(f.state.imageCalls.length,0);f.state.failRefs=false;f.state.failImage=false;
    assert.equal((await f.run()).success,true);assert.equal(f.state.textCalls,3);assert.equal(f.state.refReads,2);
});

for(const [name,mutate] of [
    ['message edit',f=>f.message.mes+=' New action.'],['swipe',f=>f.message.swipe_id++],['chat change',f=>f.context.chatId='other'],
    ['character change',f=>f.character.avatar='other.png'],['character description',f=>f.character.description='New character'],
    ['shot mode',f=>f.settings.shotMode='portrait'],['style',f=>f.settings.stylePreset='anime'],['omniscient mode',f=>f.settings.omniscientMode=false],
])test(`${name} invalidates old analysis`,async()=>{const f=fixture();await f.run();mutate(f);await f.run();assert.ok(f.state.textCalls>3);});

test('text failure does not cache incomplete analysis',async()=>{
    const f=fixture();f.state.failText=true;await f.run();assert.equal(f.state.imageCalls.length,0);f.state.failText=false;await f.run();assert.equal(f.state.textCalls,4);
});

test('cancellation and explicit chat cleanup discard retry analysis',async()=>{
    const f=fixture();f.state.cancelImage=true;assert.equal((await f.run()).cancelled,true);f.state.cancelImage=false;await f.run();assert.equal(f.state.textCalls,6);f.cache.clear();await f.run();assert.equal(f.state.textCalls,9);
});

test('generation error toast supplies plain text with explicit HTML escaping',async()=>{
    const f=fixture();await f.run();const error=f.state.toasts.find(t=>t.type==='error');assert.equal(error.options.escapeHtml,true);assert.equal(error.message.includes('&quot;'),false);
});

test('user can choose fresh analysis after failure and then reuse the new result', async()=>{
    const f=fixture();await f.run();assert.equal(f.state.textCalls,3);
    f.settings.imageRetryMode='reanalyze';await f.run();assert.equal(f.state.textCalls,6);assert.equal(f.state.reviews,2);
    f.settings.imageRetryMode='reuse';f.state.failImage=false;assert.equal((await f.run()).success,true);
    assert.equal(f.state.textCalls,6);assert.equal(f.state.reviews,2);
});
test('fresh analysis failure cannot resurrect an older cached prompt', async()=>{
    const f=fixture();await f.run();f.settings.imageRetryMode='reanalyze';f.state.failText=true;await f.run();
    f.settings.imageRetryMode='reuse';f.state.failText=false;await f.run();
    assert.equal(f.state.textCalls,7);assert.equal(f.state.reviews,2);
});

test('reference style prioritizes uploaded image over card avatar in the actual task',async()=>{
    const f=fixture();f.settings.stylePreset='reference';f.settings.useCharacterImage=true;
    f.state.refs=[{dataUrl:'data:image/png;base64,YWJj',label:'uploaded style'}];await f.run();
    assert.equal(f.state.avatarReads||0,0);assert.equal(f.state.imageCalls[0].refs.length,1);
    assert.equal(f.state.imageCalls[0].refs[0].dataUrl,f.state.refs[0].dataUrl);
    assert.equal(f.state.imageCalls[0].refs[0].kind,'identity-primary');
});
