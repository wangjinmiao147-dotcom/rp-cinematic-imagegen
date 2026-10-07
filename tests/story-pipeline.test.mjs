import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVersionedSceneState,getPreviousSceneState,getEffectivePreviousState,getIllustrationFacts,
    canUseContinuityReference} from '../src/scene-state.js';
import {parseAnalysisResponse} from '../src/analysis-validation.js';
import {buildStoryFactsPrompt,buildRelationCheckerPrompt,buildEditInstructionPrompt,buildFinalizerPrompt,
    assembleUnifiedPrompt,referenceImageEditPrompt} from '../src/prompts.js';
import {qwenReferenceEditPrompt} from '../src/qwen.js';

const unknown=()=>({location:null,time_of_day:null,weather:null,lighting:null,scene_continues:null});
const fact=(value,evidence)=>({value,evidence});
const update=(category,key,value,evidence)=>({character:'甲',category,key,value,evidence});
function extraction(text,patch={}) {
    return {moment:'甲的精彩瞬间',moment_evidence:text,scene_state:unknown(),
        actions:[{character:'甲',action:'停下',expression:null,gaze:null,contact:null}],
        thoughts:[],uncertainties:[],explicit_changes:{clothing:[],environment:[],props:[]},
        persistent_continues:null,persistent_updates:[],continuity_state:null,continuity_updates:[],
        narrative_end_state:{...unknown(),persistent_continues:null},narrative_end_updates:[],...patch};
}
function build(text,patch={},prev=null,index=0) {
    const f=extraction(text,patch);
    parseAnalysisResponse(JSON.stringify(f),1,{latestStory:text,previousState:getEffectivePreviousState(prev)});
    return buildVersionedSceneState(f,prev,index,text);
}
function previous(text,patch={}) {
    const state=build(text,patch);const chat=[{mes:text,extra:{rpigInfo:{sceneState:state}}}];
    return {chat,state,prev:getPreviousSceneState(chat,1)};
}

test('structured contact preserves target, body part, quantity and negation through scene saving',()=>{
    const text='甲握住乙的左手，乙没有接过两把钥匙。',notes=[];
    const parsed=parseAnalysisResponse(JSON.stringify(extraction(text,{actions:[{
        character:'甲',action:'握住乙的左手',expression:'',gaze:'  ',
        contact:{with:'乙',part:'乙的左手',quantity:2,state:'没有接过两把钥匙'},
    }]})),1,{latestStory:text,onNormalization:n=>notes.push(...n)});
    const state=buildVersionedSceneState(parsed,null,0,text);
    assert.equal(state.character_states[0].expression,null);assert.equal(state.character_states[0].gaze,null);
    for(const token of ['乙的左手','数量：2','没有接过两把钥匙'])assert.ok(state.character_states[0].contact.includes(token));
    assert.equal(state.character_states[0].contact.includes('[object Object]'),false);
    assert.ok(notes.some(n=>n.path==='actions.0.contact'));
});

test('missing optional facts and single action objects receive unknown defaults without adding gestures',()=>{
    const text='甲停下。';
    const parsed=parseAnalysisResponse(JSON.stringify({moment:'甲停下',moment_evidence:text,actions:{character:'甲',action:'停下'}}),1,{latestStory:text});
    assert.deepEqual(parsed.actions,[{character:'甲',action:'停下',expression:null,gaze:null,contact:null}]);
    assert.deepEqual(parsed.scene_state,unknown());assert.deepEqual(parsed.thoughts,[]);
    assert.deepEqual(parsed.explicit_changes,{clothing:[],environment:[],props:[]});
    assert.equal(parsed.persistent_continues,null);assert.equal(parsed.narrative_end_state.persistent_continues,null);
});

test('emotion evidence outside an informational thought drops only the bubble eligibility',()=>{
    const text='甲想：找不到衣料。她的声音透着窘迫。';
    const f=parseAnalysisResponse(JSON.stringify(extraction(text,{thoughts:[{character:'甲',content:'找不到衣料',
        evidence:'找不到衣料。',emotion:'窘迫',emotion_evidence:'声音透着窘迫'}]})),1,{latestStory:text});
    assert.equal(f.thoughts[0].content,'找不到衣料');
    assert.equal(f.thoughts[0].emotion,null);assert.equal(f.thoughts[0].emotion_evidence,null);
    assert.equal(f.actions.length,1);
});

test('eye part descriptions stay distinct and malformed optional scalars cannot become invented expressions',()=>{
    const text='甲停下，瞳孔变圆，没有回头。';
    const parsed=parseAnalysisResponse(JSON.stringify(extraction(text,{actions:[{character:'甲',action:'停下，没有回头',
        expression:{part:'瞳孔',change:'变圆'},gaze:{direction:'没有回头'},contact:42}]})),1,{latestStory:text});
    assert.match(parsed.actions[0].expression,/瞳孔/);assert.doesNotMatch(parsed.actions[0].expression,/眼型/);
    assert.match(parsed.actions[0].gaze,/没有回头/);assert.equal(parsed.actions[0].contact,null);
});

test('one empty placeholder does not destroy other valid actions or a valid actor',()=>{
    const text='甲停下。';
    const parsed=parseAnalysisResponse(JSON.stringify(extraction(text,{actions:[{},null,{character:'甲',action:'停下'}]})),1,{latestStory:text});
    assert.equal(parsed.actions.length,1);assert.equal(parsed.actions[0].character,'甲');
    const p=parseAnalysisResponse(JSON.stringify({visible_characters:[null,{}, {canonical_name:'甲',presence_evidence:text}]}),2,{latestStory:text});
    assert.equal(p.visible_characters.length,1);assert.equal(p.visible_characters[0].visible_scope,null);
});

test('readable relationship objects retain ownership and off-camera scope',()=>{
    const text='甲停下。';
    const p=parseAnalysisResponse(JSON.stringify({visible_characters:[{name:'甲',presence_evidence:text}],
        action_ownership:[{actor:'甲',action:'没有接过',object:'两把钥匙',quantity:2}],
        spatial_relations:{subject:'甲',relation:'背对',target:'乙',scope:'乙在画外'},
        mentioned_only_characters:[{name:'乙'}],
    }),2,{latestStory:text});
    assert.deepEqual(p.mentioned_only_characters,['乙']);
    for(const token of ['甲','没有接过','两把钥匙','2'])assert.ok(p.action_ownership[0].includes(token));
    assert.match(p.spatial_relations[0],/背对.*乙.*乙在画外/);
});

test('string cast names use corroborating action and an existing anchor, never a bare mentioned name',()=>{
    const text='小甲停下，乙曾在这里工作。';
    const p=parseAnalysisResponse(JSON.stringify({visible_characters:['小甲','乙'],aliases:[{alias:'小甲',canonical_name:'甲'}]}),2,
        {latestStory:text,momentEvidence:'小甲停下',sceneFacts:{actions:[{character:'甲',action:'停下'}]}});
    assert.deepEqual(p.visible_characters,[{canonical_name:'甲',presence_evidence:'小甲停下',visible_scope:null}]);
    assert.deepEqual(p.mentioned_only_characters,['乙']);
});

test('nickname-only cast records resolve to the canonical identity used for reference lookup',()=>{
    const text='小甲停下。';
    const p=parseAnalysisResponse(JSON.stringify({visible_characters:[{canonical_name:'小甲',presence_evidence:text,visible_scope:'仅手部'}],
        aliases:{小甲:'甲'}}),2,{latestStory:text});
    assert.equal(p.visible_characters[0].canonical_name,'甲');assert.equal(p.visible_characters[0].visible_scope,'仅手部');
});

test('ordinary unknowns and resolved object conflicts do not stop a drawable scene',()=>{
    const text='甲停下。';
    const p=parseAnalysisResponse(JSON.stringify({visible_characters:[{canonical_name:'甲',presence_evidence:text}],
        conflicts:['未解决：左右手未说明','未解决：没有明确照明',{issue:'动作矛盾',resolved:true}]}),2,{latestStory:text});
    assert.equal(p.visible_characters.length,1);assert.match(p.conflicts[2],/^已纠正：/);
});

test('genuinely unresolved central identity or incompatible actions still cannot become an image instruction',()=>{
    const text='甲停下。';
    for(const conflict of ['未解决：人物身份不明',{issue:'动作互斥，无法决定同一只手握谁',resolved:false}])
        assert.throws(()=>parseAnalysisResponse(JSON.stringify({visible_characters:[{canonical_name:'甲',presence_evidence:text}],
            conflicts:[conflict]}),2,{latestStory:text}),{code:'ANALYSIS_UNRESOLVED_CONFLICT'});
});

test('stage three accepts text wrappers, preserve lists and scoped exclusion objects',()=>{
    const p=parseAnalysisResponse(JSON.stringify({edit_instruction:{instruction:'Show Jia holding one key.'},
        preserve:['burgundy coat',{value:'neutral expression',scope:'main figure'}],
        exclude:[{element:'blush',scope:'main figure'},{value:'text',scope:'thought bubble'}]}),3,{latestStory:'甲握住钥匙。'});
    assert.equal(p.edit_instruction,'Show Jia holding one key.');
    assert.equal(p.preserve,'burgundy coat; neutral expression (main figure)');
    assert.deepEqual(p.exclude,['blush (main figure)','text (thought bubble)']);
    const defaults=parseAnalysisResponse(JSON.stringify({edit_instruction:'Show Jia holding one key.'}),3,{latestStory:'甲握住钥匙。'});
    assert.equal(defaults.preserve,'');assert.deepEqual(defaults.exclude,[]);
});

test('upstream rejection and empty core instructions survive compatibility normalization as failures',()=>{
    for(const raw of [JSON.stringify({refusal:'provider refused',edit_instruction:'Show Jia.'}),
        JSON.stringify({edit_instruction:"I cannot help generate this request."})])
        assert.throws(()=>parseAnalysisResponse(raw,3,{latestStory:'甲停下。'}));
    assert.throws(()=>parseAnalysisResponse('{"edit_instruction":null,"preserve":[]}',3,{latestStory:'甲停下。'}),{code:'ANALYSIS_INVALID_SCHEMA'});
    assert.throws(()=>parseAnalysisResponse(JSON.stringify({moment:'甲停下',moment_evidence:'甲停下。',actions:[{}]}),1,{latestStory:'甲停下。'}),{code:'ANALYSIS_NO_SUBJECT'});
});

test('conflicting optional state updates are omitted rather than selecting an arbitrary outfit',()=>{
    const text='甲穿着外套。';
    const parsed=parseAnalysisResponse(JSON.stringify(extraction(text,{persistent_updates:[
        update('clothing','outfit','蓝外套',text),update('clothing','outfit','红外套',text)]})),1,{latestStory:text});
    assert.deepEqual(parsed.persistent_updates,[]);
    assert.ok(parsed.uncertainties.some(x=>x.includes('冲突')));
});

test('a rejected claimed change cannot silently resurrect an old scene or outfit',()=>{
    const {prev}=initial(),text='甲停下。';
    const parsed=parseAnalysisResponse(JSON.stringify(extraction(text,{scene_state:{...unknown(),scene_continues:true,
        location:fact('庭院','来到庭院。')},persistent_continues:true,
        persistent_updates:[update('clothing','outfit','白外套','换上白外套。')]})),1,{latestStory:text});
    const state=buildVersionedSceneState(parsed,prev,1,text);
    assert.equal(parsed.scene_state.scene_continues,null);assert.equal(state.location,null);
    assert.equal(parsed.persistent_continues,null);assert.deepEqual(state.persistent_states,[]);
});

test('invalid claimed ending and intervening updates also disable their inherited state',()=>{
    const {prev}=initial(),text='甲停下。';
    const middle='甲换上白裙。',prior={...prev,_intervening_messages:[{source_message_index:1,text:middle}],_hasInterveningMessages:true};
    const parsed=parseAnalysisResponse(JSON.stringify(extraction(text,{scene_state:{...unknown(),scene_continues:true},persistent_continues:true,
        continuity_state:{...unknown(),location:{...fact('庭院','来到庭院。'),source_message_index:1},scene_continues:true,persistent_continues:true},
        continuity_updates:[{...update('clothing','outfit','蓝裙','换上蓝裙。'),source_message_index:1}],
        narrative_end_state:{...unknown(),location:fact('花园','走到花园。'),scene_continues:true,persistent_continues:true},
        narrative_end_updates:[update('clothing','outfit','蓝裙','换上蓝裙。')]})),1,{latestStory:text,previousState:prior});
    const state=buildVersionedSceneState(parsed,prior,2,text);
    assert.equal(state.location,null);assert.deepEqual(state.persistent_states,[]);
    assert.equal(state.narrative_end_state.location,null);assert.deepEqual(state.narrative_end_persistent_states,[]);
});

test('a duplicate actor retains an explicitly supplied partial scope',()=>{
    const text='甲的手握住钥匙。';
    const p=parseAnalysisResponse(JSON.stringify(cast([{canonical_name:'甲',presence_evidence:text,visible_scope:null},
        {canonical_name:'甲',presence_evidence:text,visible_scope:'仅手部'}])),2,{latestStory:text});
    assert.equal(p.visible_characters.length,1);assert.equal(p.visible_characters[0].visible_scope,'仅手部');
});

test('conflict messages and resolved statuses retain their real blocking meaning',()=>{
    const text='甲停下。',person={canonical_name:'甲',presence_evidence:text};
    assert.throws(()=>parseAnalysisResponse(JSON.stringify({visible_characters:[person],
        conflicts:[{message:'同一只手动作互斥',resolved:false}]}),2,{latestStory:text}),{code:'ANALYSIS_UNRESOLVED_CONFLICT'});
    const fixed=parseAnalysisResponse(JSON.stringify({visible_characters:[person],
        conflicts:[{message:'同一只手动作互斥',status:'resolved'}]}),2,{latestStory:text});
    assert.match(fixed.conflicts[0],/^已纠正：/);
});

test('nested upstream rejection markers cannot be hidden by a readable text wrapper',()=>{
    assert.throws(()=>parseAnalysisResponse(JSON.stringify({edit_instruction:{text:'Show Jia.',refusal:'provider refused'}}),3,
        {latestStory:'甲停下。'}),{code:'ANALYSIS_REJECTED'});
    assert.throws(()=>parseAnalysisResponse(JSON.stringify({edit_instruction:{text:'Show Jia.',error:'quota exceeded'}}),3,
        {latestStory:'甲停下。'}),{code:'ANALYSIS_REJECTED'});
});

test('legacy visible_names only recovers actors supported by current facts and the existing moment quote',()=>{
    const text='甲停下，乙曾在这里工作。';
    const p=parseAnalysisResponse(JSON.stringify({visible_names:['甲','乙']}),2,
        {latestStory:text,momentEvidence:'甲停下',sceneFacts:{actions:[{character:'甲',action:'停下'}]}});
    assert.deepEqual(p.visible_characters,[{canonical_name:'甲',presence_evidence:'甲停下',visible_scope:null}]);
    assert.deepEqual(p.mentioned_only_characters,['乙']);assert.equal(p.visible_names,undefined);
});

test('wrapped contact descriptions retain their sibling target and part fields',()=>{
    const text='甲握住乙的手。';
    const parsed=parseAnalysisResponse(JSON.stringify(extraction(text,{actions:[{character:'甲',action:'握住',
        contact:{text:'保持接触',with:'乙',part:'乙的手'}}]})),1,{latestStory:text});
    for(const token of ['保持接触','乙','乙的手'])assert.ok(parsed.actions[0].contact.includes(token));
});

test('object exclusion scope stays local to the main face without blocking the chibi expression',()=>{
    const parsed=parseAnalysisResponse(JSON.stringify({edit_instruction:'Show Jia with a chibi thought bubble.',
        exclude:[{element:'blushing',scope:{target:'main figure',part:'face'}}]}),3,{latestStory:'甲停下。'});
    assert.match(parsed.exclude[0],/blushing.*main figure.*face/);
    assert.notEqual(parsed.exclude[0],'blushing');
});
const outfit='甲换上酒红长裙。';
const initial=()=>previous(outfit,{scene_state:{...unknown(),location:fact('图书室',outfit)},
    persistent_updates:[update('clothing','outfit','穿着酒红长裙',outfit)],
    narrative_end_state:{...unknown(),scene_continues:true,persistent_continues:true}});

test('an earlier dramatic frame and the later narrative ending remain independent',()=>{
    const frame='甲在图书室握住钥匙，瞳孔变圆。',end='随后甲将钥匙收入口袋，走到庭院。',text=frame+end;
    const state=build(text,{moment_evidence:frame,
        scene_state:{...unknown(),location:fact('图书室',frame)},
        persistent_updates:[update('props','钥匙','手中握着一把钥匙',frame)],
        narrative_end_state:{...unknown(),location:fact('庭院',end),scene_continues:false,persistent_continues:true},
        narrative_end_updates:[update('props','钥匙','一把钥匙已收入口袋',end)]});
    assert.equal(state.location.value,'图书室');assert.match(state.persistent_states[0].props[0].value,/手中/);
    const next=getEffectivePreviousState(state);
    assert.equal(next.location.value,'庭院');assert.match(next.persistent_states[0].props[0].value,/口袋/);
    assert.equal(next.character_states[0].action,'停下'); // Only current-frame diagnostics; never used as inherited actions.
});

test('unknown ending location never falls back to the selected earlier scene',()=>{
    const state=build('甲在图书室停下。后来不知过了多久。',{moment_evidence:'甲在图书室停下。',
        scene_state:{...unknown(),location:fact('图书室','甲在图书室停下。')}});
    assert.equal(state.location.value,'图书室');assert.equal(getEffectivePreviousState(state).location,null);
});

test('new actions preserve verified clothing without copying past gestures or reactions',()=>{
    const {prev}=initial();const state=build('甲慢慢坐下。',{scene_state:{...unknown(),scene_continues:true},
        persistent_continues:true,actions:[{character:'甲',action:'坐下',expression:null,gaze:null,contact:null}]},prev,1);
    assert.equal(state.persistent_states[0].clothing[0].value,'穿着酒红长裙');
    assert.deepEqual(state.character_states[0],{character:'甲',action:'坐下',expression:null,gaze:null,contact:null,source_message_index:1});
});

test('moving locations clears scene inheritance but can retain an unchanged outfit',()=>{
    const {prev}=initial(),text='甲走到庭院停下。';
    const state=build(text,{scene_state:{...unknown(),location:fact('庭院',text),scene_continues:false},persistent_continues:true},prev,1);
    assert.equal(state.location.value,'庭院');assert.equal(state.lighting,null);
    assert.equal(state.persistent_states[0].clothing[0].value,'穿着酒红长裙');
});

test('uncertain time jumps do not silently inherit clothes or environmental facts',()=>{
    const {prev}=initial();const state=build('多年以后，甲停下。',{},prev,1);
    assert.equal(state.location,null);assert.deepEqual(state.persistent_states,[]);
});

test('changing clothing after the chosen frame affects the next turn, not this picture',()=>{
    const frame='甲穿着酒红长裙握住钥匙。',end='后来甲换上白色外套。';
    const state=build(frame+end,{moment_evidence:frame,persistent_updates:[update('clothing','outfit','酒红长裙',frame)],
        narrative_end_state:{...unknown(),persistent_continues:true},
        narrative_end_updates:[update('clothing','outfit','白色外套',end)]});
    assert.equal(state.persistent_states[0].clothing[0].value,'酒红长裙');
    assert.equal(getEffectivePreviousState(state).persistent_states[0].clothing[0].value,'白色外套');
});

test('a new outfit replaces old outfit damage while retaining unrelated accessories',()=>{
    const text='甲穿着破损长裙，戴着银戒。';
    const {prev}=previous(text,{persistent_updates:[update('clothing','outfit','长裙',text),
        update('clothing','condition:outfit:裙摆','裙摆破损',text),update('clothing','accessory:戒指','银戒',text)],
        narrative_end_state:{...unknown(),persistent_continues:true}});
    const change='甲换上白裙。';const state=build(change,{persistent_continues:true,
        persistent_updates:[update('clothing','outfit','白裙',change)]},prev,1);
    assert.deepEqual(state.persistent_states[0].clothing.map(f=>f.key),['outfit','accessory:戒指']);
});

test('repeated same-key prop updates retain one current result instead of a history list',()=>{
    const text='甲拿着一把钥匙。';const {prev}=previous(text,{persistent_updates:[update('props','钥匙','手中一把钥匙',text)],
        narrative_end_state:{...unknown(),persistent_continues:true}});
    const change='甲把钥匙放在桌上。';const state=build(change,{persistent_continues:true,
        persistent_updates:[update('props','钥匙','钥匙在桌上，甲手中没有钥匙',change)]},prev,1);
    assert.equal(state.persistent_states[0].props.length,1);assert.match(state.persistent_states[0].props[0].value,/手中没有/);
});

test('source edits invalidate frame, ending, and previous image even when a quoted phrase survives',()=>{
    const {chat,state}=initial();chat[0].mes+='其实那是回忆。';
    const prev=getPreviousSceneState(chat,1);
    assert.equal(prev.location,null);assert.equal(getEffectivePreviousState(prev).location,null);
    assert.deepEqual(getEffectivePreviousState(prev).persistent_states,[]);
    assert.equal(prev._intervening_messages[0].source_message_index,0);
    assert.equal(canUseContinuityReference({url:'/old.png',messageIndex:0},chat,state),false);
});

test('editing an earlier provenance message invalidates facts carried by a later saved state',()=>{
    const {chat,prev}=initial();const text='甲坐下。';
    const state=build(text,{scene_state:{...unknown(),scene_continues:true},persistent_continues:true,
        narrative_end_state:{...unknown(),scene_continues:true,persistent_continues:true}},prev,1);
    chat.push({mes:text,extra:{rpigInfo:{sceneState:state}}});chat[0].mes+='那是过去。';
    const next=getEffectivePreviousState(getPreviousSceneState(chat,2));
    assert.equal(next.location,null);assert.deepEqual(next.persistent_states,[]);
    assert.equal(canUseContinuityReference({url:'/second.png',messageIndex:1},chat,state),false);
});

test('intervening assistant messages update continuity with their own indexed evidence',()=>{
    const {chat}=initial(),middle='无关细节。'.repeat(100)+'甲换上白裙，来到庭院。';
    chat.push({mes:'我试着让甲换上蓝裙。',is_user:true},{mes:middle});
    const prev=getPreviousSceneState(chat,3),evidence='甲换上白裙，来到庭院。';
    assert.equal(prev._intervening_messages.length,1);assert.ok(prev._intervening_messages[0].text.endsWith(evidence));
    const state=build('甲在那里坐下。',{scene_state:{...unknown(),scene_continues:true},persistent_continues:true,
        continuity_state:{...unknown(),location:{...fact('庭院',evidence),source_message_index:2},
            scene_continues:false,persistent_continues:true},
        continuity_updates:[{...update('clothing','outfit','穿着白裙',evidence),source_message_index:2}]},prev,3);
    assert.equal(state.location.value,'庭院');assert.equal(state.location.source_message_index,2);
    assert.equal(state.persistent_states[0].clothing[0].value,'穿着白裙');
    const prompt=buildStoryFactsPrompt({latestStory:'甲在那里坐下。',currentState:prev});
    assert.match(prompt.userText,/只推进连续性/);assert.match(prompt.userText,/source_message_index/);
    assert.equal(prompt.userText.split('【前次保存')[0].includes(evidence),false);
});

test('old version-2 frame data is re-reviewed, not trusted as a narrative ending',()=>{
    const chat=[{mes:'甲先在图书室，后来到了庭院。',extra:{rpigInfo:{sceneState:{version:2,location:fact('图书室','图书室')}}}}];
    const prev=getPreviousSceneState(chat,1);
    assert.equal(getEffectivePreviousState(prev).location,null);assert.equal(prev._intervening_messages[0].source_message_index,0);
});

test('unverified optional scene and prop records stay out of a valid frame without stopping it',()=>{
    const text='甲握住钥匙。后来收入口袋。',f=extraction(text,{moment_evidence:'甲握住钥匙。',
        scene_state:{...unknown(),lighting:fact('烛光','点燃蜡烛')},
        persistent_updates:[update('props','钥匙','收入口袋','把钥匙塞进背包。')]});
    const parsed=parseAnalysisResponse(JSON.stringify(f),1,{latestStory:text});
    const state=buildVersionedSceneState(parsed,null,0,text);
    assert.equal(parsed.actions[0].character,'甲');assert.equal(state.lighting,null);
    assert.deepEqual(state.persistent_states,[]);assert.ok(parsed.uncertainties.length>=2);
});

test('explicit boolean strings are recovered while unknown continuity stays null',()=>{
    const text='甲握住钥匙。';
    const a=parseAnalysisResponse(JSON.stringify(extraction(text,{persistent_continues:'true',
        scene_state:{...unknown(),scene_continues:'false'}})),1,{latestStory:text});
    assert.equal(a.persistent_continues,true);assert.equal(a.scene_state.scene_continues,false);
    const b=parseAnalysisResponse(JSON.stringify(extraction(text,{persistent_continues:'probably'})),1,{latestStory:text});
    assert.equal(b.persistent_continues,null);
});

test('ambiguous repeated moment anchors must be expanded, not guessed',()=>{
    const text='甲停下。随后乙离开。甲停下。';
    assert.throws(()=>parseAnalysisResponse(JSON.stringify(extraction(text,{moment_evidence:'甲停下。'})),1,{latestStory:text}),
        {code:'ANALYSIS_AMBIGUOUS_MOMENT'});
});

const cast=people=>({visible_characters:people,mentioned_only_characters:[],aliases:{},spatial_relations:[],action_ownership:[],conflicts:[]});
for(const bad of [[null],[{}],[{canonical_name:'',presence_evidence:'甲停下。',visible_scope:null}]])
    test(`invalid cast record ${JSON.stringify(bad)} cannot pass as a nonempty list`,()=>{
        assert.throws(()=>parseAnalysisResponse(JSON.stringify(cast(bad)),2,{latestStory:'甲停下。'}),{code:'ANALYSIS_EMPTY_CAST'});
    });
test('simultaneous body presence written after the moment anchor is allowed',()=>{
    const text='甲停下。此时乙握着甲的手。';
    const parsed=parseAnalysisResponse(JSON.stringify(cast([{canonical_name:'乙',presence_evidence:'此时乙握着甲的手。',visible_scope:null}])),
        2,{latestStory:text,momentEvidence:'甲停下。'});
    assert.equal(parsed.visible_characters[0].canonical_name,'乙');
});
test('aliases merge duplicate physical actors and remove the same identity from the off-camera list',()=>{
    const p={canonical_name:'甲',presence_evidence:'甲停下。',visible_scope:'仅手部'};
    const v=cast([p,{...p,canonical_name:'小甲'}]);v.aliases={'小甲':'甲'};
    const a=parseAnalysisResponse(JSON.stringify(v),2,{latestStory:'甲停下。'});
    assert.deepEqual(a.visible_characters,[p]);
    v.visible_characters=[p];v.mentioned_only_characters=['小甲'];
    const b=parseAnalysisResponse(JSON.stringify(v),2,{latestStory:'甲停下。'});
    assert.deepEqual(b.mentioned_only_characters,[]);
});

test('full narration remains reviewable while structured ending state stays out of frame facts',()=>{
    const frame='甲握住钥匙。',end='后来甲到了日出庭院。',text=frame+end;
    const raw=extraction(text,{moment_evidence:frame,narrative_end_state:{...unknown(),location:fact('日出庭院',end),persistent_continues:null}});
    const state=buildVersionedSceneState(raw,null,0,text),visible=getIllustrationFacts(raw,state);
    assert.equal(visible.narrative_end_state,undefined);
    for(const build of [buildRelationCheckerPrompt,buildEditInstructionPrompt]){
        const p=build({latestStory:text,sceneFacts:raw,structuredSceneState:state});
        assert.equal(p.userText.includes(end),true);assert.equal(p.userText.includes('narrative_end_state'),false);
        assert.match(p.userText,/按已锁定瞬间核验/);
        assert.match(p.userText,/甲握住钥匙/);
    }
});

test('post-anchor simultaneous facts survive validation and state building without replacing the later ending',()=>{
    const frame='甲停下脚步，捏住折纸。';
    const simultaneous='她此时仍穿着酒红长裙，站在图书室桌旁；窗外正下雨，她心里暗自高兴，折纸还握在手中。';
    const ending='随后甲走到庭院，换上白色外套，把折纸收进抽屉。';
    const text=frame+simultaneous+ending;
    const raw=extraction(text,{moment_evidence:frame,
        scene_state:{...unknown(),location:fact('图书室','站在图书室桌旁'),weather:fact('下雨','窗外正下雨')},
        thoughts:[{character:'甲',content:'暗自高兴',evidence:'她心里暗自高兴'}],
        persistent_updates:[update('clothing','outfit','酒红长裙','她此时仍穿着酒红长裙'),update('props','paper','折纸在手中','折纸还握在手中')],
        narrative_end_state:{...unknown(),location:fact('庭院','随后甲走到庭院'),scene_continues:false,persistent_continues:true},
        narrative_end_updates:[update('clothing','outfit','白色外套','换上白色外套'),update('props','paper','折纸在抽屉中','把折纸收进抽屉')]});
    const parsed=parseAnalysisResponse(JSON.stringify(raw),1,{latestStory:text});
    const state=buildVersionedSceneState(parsed,null,0,text);
    assert.equal(state.location.value,'图书室');assert.equal(state.weather.value,'下雨');
    assert.equal(state.persistent_states[0].clothing[0].value,'酒红长裙');assert.match(state.persistent_states[0].props[0].value,/手中/);
    const end=getEffectivePreviousState(state);
    assert.equal(end.location.value,'庭院');assert.equal(end.weather,null);
    assert.equal(end.persistent_states[0].clothing[0].value,'白色外套');assert.match(end.persistent_states[0].props[0].value,/抽屉/);
    for(const build of [buildRelationCheckerPrompt,buildEditInstructionPrompt]){
        const p=build({latestStory:text,sceneFacts:raw,structuredSceneState:state});
        assert.ok(p.userText.includes(simultaneous));assert.ok(p.userText.includes(ending));
        assert.equal(p.userText.includes('narrative_end_updates'),false);
    }
});

test('missing history source bookkeeping is recovered only from its unique literal quote',()=>{
    const {chat}=initial(),middle='甲来到庭院，换上白色外套。';chat.push({mes:middle});
    const prior=getPreviousSceneState(chat,2),text='甲停下。';
    const raw=extraction(text,{scene_state:{...unknown(),scene_continues:true},persistent_continues:true,
        continuity_state:{...unknown(),location:fact('庭院',middle),scene_continues:false,persistent_continues:true},
        continuity_updates:[update('clothing','outfit','白色外套',middle)]});
    const parsed=parseAnalysisResponse(JSON.stringify(raw),1,{latestStory:text,previousState:prior});
    assert.equal(parsed.continuity_state.location.source_message_index,1);
    assert.equal(parsed.continuity_updates[0].source_message_index,1);
    const state=buildVersionedSceneState(parsed,prior,2,text);
    assert.equal(state.location.value,'庭院');assert.equal(state.persistent_states[0].clothing[0].value,'白色外套');
    const wrong=structuredClone(raw);wrong.continuity_state.location.source_message_index=999;
    const ignored=parseAnalysisResponse(JSON.stringify(wrong),1,{latestStory:text,previousState:prior});
    assert.equal(ignored.continuity_state.location,null);
    assert.ok(ignored.uncertainties.some(x=>x.includes('来源未核实')));
});

test('unified and Qwen prompts preserve identity, partial bodies, and text-free symbolic chibi bubbles',()=>{
    const prompt=assembleUnifiedPrompt({editInstruction:'Show Jia holding one key, with a small thought bubble containing her own worried chibi avatar.',preserve:'The burgundy dress.'});
    const refs=[{identityName:'Jia',kind:'identity-primary',dataUrl:'data:image/png;base64,YQ=='},
        {identityName:'Jia',kind:'identity-secondary',viewType:'three_views',dataUrl:'data:image/png;base64,Yg=='}];
    const mapped=referenceImageEditPrompt(prompt,refs),qwen=qwenReferenceEditPrompt(mapped,refs);
    for(const p of [mapped,qwen]){
        for(const clause of ['eye design and color','hand-only participant','no text',
            'not another physical cast member','Honor explicit']) assert.ok(p.includes(clause),clause);
        assert.match(p,/Keep (?:current|the single moment's) object counts/);
    }
    assert.equal((mapped.match(/ONE CONSISTENT STYLE:/g)||[]).length,1);
    assert.doesNotMatch(qwen,/ONE CONSISTENT STYLE:|REFERENCE MAPPING:|BODY STRUCTURE AND CONTACTS:/);
    assert.match(mapped,/Reference image 2: Jia/);assert.match(qwen,/<image1>/);
});
test('reference indexes remain actual upload indexes when an earlier image has no identity label',()=>{
    const prompt=referenceImageEditPrompt('Have Jia sit.',[{kind:'identity-primary'},{identityName:'Jia',kind:'identity-secondary'}]);
    assert.match(prompt,/Reference image 2: Jia/);assert.doesNotMatch(prompt,/Reference image 1: Jia/);
});
test('scoped story exclusions reach the Qwen positive instruction independently of negative sampling',()=>{
    const exclusions=["blushing on the main figure's face",'writing on the folded paper'];
    const p=assembleUnifiedPrompt({editInstruction:'Show Jia holding blank paper with a shy chibi thought bubble.',exclude:exclusions});
    const q=qwenReferenceEditPrompt(p,[{identityName:'Jia',kind:'identity-primary'}]);
    for(const excluded of exclusions)assert.ok(q.includes(excluded));
    assert.match(q,/Do not depict these excluded elements/);assert.match(q,/scene props, not identity or clothing/);
    assert.match(q,/neutral main face must not inherit a reference blush/);
    assert.equal(assembleUnifiedPrompt({editInstruction:'Show Jia.'}).includes('ELEMENTS TO OMIT:'),false);
});
test('reference-mode finalizer keeps the common moment and chibi rules without forcing old backgrounds',()=>{
    const p=buildFinalizerPrompt({stylePreset:'reference',currentMessageText:'甲停下。',visibleCharacters:['甲']});
    assert.match(p.system,/Q版/);assert.match(p.system,/环境未知时留给统一模板/);
    assert.doesNotMatch(p.system,/环境未明确改变时，保持参考图环境|参考图为二次元动漫风格/);
});

for(const [stage,value] of [[1,extraction('甲停下。')],[2,cast([{canonical_name:'甲',presence_evidence:'甲停下。',visible_scope:null}])],
    [3,{edit_instruction:'Have Jia stop.',preserve:'',exclude:[]}]])
    test(`stage ${stage} ignores uncontracted model fields instead of propagating or failing`,()=>{
        const parsed=parseAnalysisResponse(JSON.stringify({...value,style_suggestion:'invented dark studio'}),stage,
            {latestStory:'甲停下。'});
        assert.equal(parsed.style_suggestion,undefined);assert.equal(JSON.stringify(parsed).includes('invented dark studio'),false);
    });
test('verified previous frames remain eligible as continuity references',()=>{
    const {chat,state}=initial();assert.equal(canUseContinuityReference({url:'/valid.png',messageIndex:0},chat,state),true);
});
test('malformed saved clothes cannot be used as a continuity image',()=>{
    const {chat,state}=initial();const saved=structuredClone(state);saved.persistent_states[0].clothing={};
    chat[0].extra.rpigInfo.sceneState=saved;
    assert.equal(canUseContinuityReference({url:'/invalid.png',messageIndex:0},chat,state),false);
});
test('shifted source indexes are re-reviewed even when the story text is identical',()=>{
    const {chat,state}=initial();state.source_message_index=1;
    const previous=getPreviousSceneState(chat,1);assert.equal(getEffectivePreviousState(previous).location,null);
    assert.equal(previous._intervening_messages.length,1);
});
test('known identity names are passed only as a disambiguation index',()=>{
    const p=buildStoryFactsPrompt({latestStory:'她停下。',identityIndex:{focal_character:'甲',player:'乙'}});
    assert.match(p.userText,/仅消歧，不证明在场/);assert.match(p.userText,/focal_character/);
});

test('a rejected-offer modifier cannot add the off-camera offerer as a physical actor',()=>{
    const text='星禾抱着包裹，明确拒绝了你递出的两张票卡，票卡都在桌上。';
    const value=cast([{canonical_name:'星禾',presence_evidence:'星禾抱着包裹',visible_scope:null},
        {canonical_name:'玩家',presence_evidence:'明确拒绝了你递出的两张票卡',visible_scope:null}]);
    value.aliases={'你':'玩家'};
    assert.throws(()=>parseAnalysisResponse(JSON.stringify(value),2,{latestStory:text,
        sceneFacts:{actions:[{character:'星禾',action:'抱着蛋，摇头拒绝'}]}}),{code:'ANALYSIS_CAST_CONTEXT_ONLY'});
});
test('a refused object does not hide an independently visible contacting hand',()=>{
    const text='星禾拒绝了你递出的钥匙，但握住你的手。';
    const value=cast([{canonical_name:'星禾',presence_evidence:text,visible_scope:null},
        {canonical_name:'玩家',presence_evidence:text,visible_scope:'仅手部'}]);value.aliases={'你':'玩家'};
    assert.equal(parseAnalysisResponse(JSON.stringify(value),2,{latestStory:text,
        sceneFacts:{actions:[{character:'星禾',action:'握住玩家的手'}]}}).visible_characters.length,2);
});

for(const body of ['你的左手仍握着钥匙柄。','你伸出的手停在桌面上方。',
    '你就在她身旁，伸出的手仍托着钥匙。'])
    test(`a refusal preserves explicitly shown partial body: ${body}`,()=>{
        const text='星禾摇头拒绝你递出的钥匙，'+body;
        const value=cast([{canonical_name:'星禾',presence_evidence:text,visible_scope:null},
            {canonical_name:'玩家',presence_evidence:text,visible_scope:'仅手部'}]);value.aliases={'你':'玩家'};
        assert.equal(parseAnalysisResponse(JSON.stringify(value),2,{latestStory:text,
            sceneFacts:{actions:[{character:'星禾',action:'摇头拒绝'}]}}).visible_characters.length,2);
    });
test('a negated touch does not establish the off-camera offerer body',()=>{
    const text='星禾拒绝了你递出的钥匙，没有触碰你的手。';
    const value=cast([{canonical_name:'星禾',presence_evidence:text,visible_scope:null},
        {canonical_name:'玩家',presence_evidence:text,visible_scope:'仅手部'}]);value.aliases={'你':'玩家'};
    assert.throws(()=>parseAnalysisResponse(JSON.stringify(value),2,{latestStory:text,
        sceneFacts:{actions:[{character:'星禾',action:'拒绝'}]}}),{code:'ANALYSIS_CAST_CONTEXT_ONLY'});
});

for(const body of ['从未碰到过你的手。','你的手并未出现在画面里。'])
    test(`a refusal does not use negated body evidence: ${body}`,()=>{
        const text='星禾摇头拒绝你递出的钥匙，'+body;
        const value=cast([{canonical_name:'星禾',presence_evidence:text,visible_scope:null},
            {canonical_name:'玩家',presence_evidence:text,visible_scope:'仅手部'}]);value.aliases={'你':'玩家'};
        assert.throws(()=>parseAnalysisResponse(JSON.stringify(value),2,{latestStory:text,
            sceneFacts:{actions:[{character:'星禾',action:'摇头拒绝'}]}}),{code:'ANALYSIS_CAST_CONTEXT_ONLY'});
    });
