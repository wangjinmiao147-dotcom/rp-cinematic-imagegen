import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnalysisResponse } from '../src/analysis-validation.js';
import { composeStoryEdit, BODY_STRUCTURE_RULES, ARTISTIC_ANATOMY_RULE } from '../src/visual-constraints.js';
import { assembleUnifiedPrompt } from '../src/prompts.js';
import { qwenReferenceEditPrompt, qwenIdentityRenderSettings, qwenSize, selectQwenStoryReferences } from '../src/qwen.js';

const story = '甲站在门边，抬手叩门。她心中因误会解除而松了一口气。';
const thoughts = [{character:'甲',content:'误会解除后释然',evidence:'她心中因误会解除而松了一口气。',emotion:'释然',emotion_evidence:'松了一口气'}];
const relation = extra => ({visible_characters:[{canonical_name:'甲',presence_evidence:'甲站在门边，抬手叩门。',visible_scope:null}],
    mentioned_only_characters:[],aliases:{},spatial_relations:[],action_ownership:[],conflicts:[],...extra});
const parse = extra => parseAnalysisResponse(JSON.stringify(relation(extra)),2,{latestStory:story,sceneFacts:{actions:[{character:'甲'}],thoughts}});
const edit = {edit_instruction:'Show 甲 knocking on the door.',preserve:'',exclude:[],
    thought_bubble_instruction:'Add a small thought bubble beside 甲, showing her own chibi avatar with relaxed brows and a relieved smile.'};

test('ordinary images never receive the optional bubble section or a chibi avatar',()=>{
    const result=composeStoryEdit(edit,parse({}));
    assert.equal(result.thoughtBubbleApplied,false);
    const prompt=assembleUnifiedPrompt(result);
    assert.match(prompt,/knocking on the door/);
    assert.doesNotMatch(prompt,/THOUGHT BUBBLES:|thought[- ]bubble|chibi/i);
});

test('artistic anatomy details are conditional and never change a clothed illustration',()=>{
    const clothed=assembleUnifiedPrompt({editInstruction:'Show 甲 standing in her reference outfit.'});
    assert.doesNotMatch(clothed,/nipples|artistic nude/);
    assert.doesNotMatch(assembleUnifiedPrompt({editInstruction:'Show 甲 fully clothed, not nude.'}),/naturally proportioned nipples/);
    const art=assembleUnifiedPrompt({editInstruction:'Show an adult figure in a nonsexual artistic nude study.'});
    assert.ok(art.includes(ARTISTIC_ANATOMY_RULE));
    assert.match(qwenReferenceEditPrompt(art,[{kind:'identity-primary',identityName:'甲'}]),/visible bare adult body.*proportionate nipples centered in their areolae/);
});

test('Qwen prose keeps cast, scoped exclusions, body structure and lighting without rendering template headings',()=>{
    const full=assembleUnifiedPrompt({editInstruction:'Show 甲 and 乙 holding the same box in an explicitly dark room.',preserve:'The burgundy coat.',exclude:['writing on the box']})+'\nVISIBLE CAST (2): 甲, 乙. Each listed person has one physical body.';
    const q=qwenReferenceEditPrompt(full,[{identityName:'甲',kind:'identity-primary'},{identityName:'乙',kind:'identity-primary'}]);
    assert.match(q,/Render this selected moment: Show 甲 and 乙/);
    for(const text of ['burgundy coat','Visible cast: 甲, 乙','writing on the box','shoulder-elbow-wrist-hand','Honor explicitly stated illumination','<image1>','<image2>'])assert.ok(q.includes(text),text);
    assert.doesNotMatch(q,/REQUESTED CHANGES:|ONE CONSISTENT STYLE:|THOUGHT BUBBLES:|REFERENCE MAPPING:/);
    assert.match(q,/local shadows stay local/);
    assert.match(q,/When overall illumination is unspecified/);
    assert.match(q,/without inventing a physical light source/);
});

test('identity detail mode uses tested sizes and reference detail without mutating saved presets',()=>{
    const original={qwenIdentityDetailBoost:true,qwenResolution:'768x432',qwenReferenceProfile:'balanced',qwenSteps:25,imageSize:'16:9'};
    const refs=[{kind:'identity-primary'}],detail=qwenIdentityRenderSettings(original,refs);
    assert.deepEqual(qwenSize(detail),[1024,576]);assert.equal(detail.qwenReferenceProfile,'detail');assert.equal(detail.qwenSteps,20);
    assert.equal(original.qwenResolution,'768x432');assert.equal(original.qwenReferenceProfile,'balanced');assert.equal(original.qwenSteps,25);
    assert.equal(qwenIdentityRenderSettings(original,[]),original);
    const disabled={...original,qwenIdentityDetailBoost:false};assert.equal(qwenIdentityRenderSettings(disabled,refs),disabled);
});

test('the 512 preset stays lightweight even with a stale high tier or identity detail checkbox',()=>{
    const settings={qwenResolution:'512x288',qwenResolutionTier:'high',qwenIdentityDetailBoost:true};
    assert.equal(qwenIdentityRenderSettings(settings,[{kind:'identity-primary'}]),settings);
    for(const ratio of ['16:9','9:16','1:1','2.39:1','4:3','3:4']) {
        const size=qwenSize({...settings,imageSize:ratio});
        assert.equal(Math.max(...size),512);assert.ok(size.every(n=>n>=256 && n%32===0));
    }
    assert.deepEqual(qwenSize(settings),[512,288]);
    assert.deepEqual(qwenSize({}),[512,288]);
    assert.deepEqual(qwenSize({qwenResolution:'768x432'}),[768,448]);
});

test('a grounded current inner reaction adds a readable expression without changing the main action',()=>{
    const r=parse({psychological_reactions:[{character:'甲',emotion:'释然',evidence:thoughts[0].evidence}]});
    const result=composeStoryEdit(edit,r);
    assert.equal(result.thoughtBubbleApplied,true);
    assert.match(result.editInstruction,/knocking on the door/);
    assert.match(result.editInstruction,/relaxed brows and a relieved smile/);
    assert.match(assembleUnifiedPrompt(result),/do not merely copy the main portrait/);
});

test('missing or invented psychology drops only the optional layer and never fails generation',()=>{
    for(const bad of [{character:'甲',emotion:'惊讶',evidence:'并不存在的心理反应'},
        {character:'甲',emotion:'',evidence:thoughts[0].evidence},null]) {
        assert.doesNotThrow(()=>parse({psychological_reactions:[bad]}));
        assert.deepEqual(parse({psychological_reactions:[bad]}).psychological_reactions,[]);
    }
});

test('visible facial emotion alone cannot authorize an invented inner reaction',()=>{
    const r=parseAnalysisResponse(JSON.stringify(relation({psychological_reactions:[{character:'甲',emotion:'释然',evidence:thoughts[0].evidence}]})),2,
        {latestStory:story,sceneFacts:{actions:[{character:'甲'}],thoughts:[]}});
    assert.deepEqual(r.psychological_reactions,[]);
});

test('an informational inner thought cannot acquire an invented emotion from the relation or old editor draft',()=>{
    const source='甲抬手叩门。她想：行囊尽失，连一件衣料都找不到。她的声音透着窘迫。';
    const sceneFacts={actions:[{character:'甲'}],thoughts:[{character:'甲',content:'找不到衣料',evidence:'行囊尽失，连一件衣料都找不到。',emotion:null,emotion_evidence:null}]};
    const raw=relation({visible_characters:[{canonical_name:'甲',presence_evidence:'甲抬手叩门。',visible_scope:null}],
        psychological_reactions:[{character:'甲',emotion:'害羞',evidence:sceneFacts.thoughts[0].evidence}]});
    assert.deepEqual(parseAnalysisResponse(JSON.stringify(raw),2,{latestStory:source,sceneFacts}).psychological_reactions,[]);
    const composed=composeStoryEdit(edit,raw,{latestStory:source,sceneFacts});
    assert.equal(composed.thoughtBubbleApplied,false);
    assert.match(composed.editInstruction,/knocking/);
    assert.doesNotMatch(composed.editInstruction,/chibi|bubble/i);
});

test('the optional bubble retains the facts-stage emotion instead of replacing it with another reaction',()=>{
    const r=parse({psychological_reactions:[{character:'甲',emotion:'害羞',evidence:thoughts[0].evidence}]});
    assert.deepEqual(r.psychological_reactions,[{character:'甲',emotion:'释然',evidence:'松了一口气'}]);
});

test('an off-camera or hand-only person cannot acquire a floating head or thought bubble',()=>{
    for(const visible of [[],[{canonical_name:'甲',presence_evidence:story,visible_scope:'仅手部'}]]) {
        const r=parse({visible_characters:visible.length?visible:relation().visible_characters,
            psychological_reactions:[{character:visible.length?'甲':'乙',emotion:'释然',evidence:thoughts[0].evidence}]});
        assert.deepEqual(r.psychological_reactions,[]);
    }
});

test('old combined bubble sentences are omitted when ungrounded while retaining the story action',()=>{
    const result=composeStoryEdit({...edit,edit_instruction:edit.edit_instruction+' '+edit.thought_bubble_instruction,
        thought_bubble_instruction:undefined,exclude:['text inside the thought bubble','a second key']},parse({}));
    assert.equal(result.editInstruction,edit.edit_instruction);
    assert.deepEqual(result.exclude,['a second key']);
    const mixed=composeStoryEdit({...edit,edit_instruction:'Show 甲 knocking on the door, and add a small thought bubble with a chibi avatar.'},parse({}));
    assert.equal(mixed.editInstruction,edit.edit_instruction);
    const neutral=composeStoryEdit({...edit,edit_instruction:edit.edit_instruction+' The main face is neutral and unflushed; reserve the shy flush for the chibi avatar inside the bubble.'},parse({}));
    assert.match(neutral.editInstruction,/main face is neutral and unflushed/);
    assert.doesNotMatch(neutral.editInstruction,/chibi|bubble/);
});

test('optional new editor field remains compatible with the original three-field responses',()=>{
    const old=parseAnalysisResponse(JSON.stringify({edit_instruction:edit.edit_instruction,preserve:'',exclude:[]}),3,{latestStory:story});
    assert.equal(composeStoryEdit(old,parse({})).editInstruction,edit.edit_instruction);
    const current=parseAnalysisResponse(JSON.stringify(edit),3,{latestStory:story});
    assert.equal(current.thought_bubble_instruction,edit.thought_bubble_instruction);
});

test('positive anatomy constraints reach Qwen at CFG 1 and respect hidden digits and crop',()=>{
    const refs=[{identityName:'甲',kind:'identity-primary'}];
    for(const prompt of [assembleUnifiedPrompt({editInstruction:'Show 甲 seated, one hand resting on the table.'}),
        qwenReferenceEditPrompt('Show 甲 seated, one hand resting on the table.',refs)]) {
        assert.ok(prompt.replace(/\s+/g,' ').includes(BODY_STRUCTURE_RULES.replace(/\s+/g,' ')));
        assert.match(prompt,/shoulder-to-upper-arm-to-elbow-to-forearm-to-wrist-to-hand/);
        assert.match(prompt,/do not spread hands, reveal hidden digits/);
        assert.match(prompt,/reference body build/);
    }
});

test('verified current undress survives an editor that mentions it only in exclusions',()=>{
    const sceneState={persistent_states:[{character:'甲',clothing:[{key:'outfit',value:'身体湿透未穿衣物',confirmed:true}]}]};
    const composed=composeStoryEdit({edit_instruction:'Show 甲 knocking on a frosted door.',preserve:'',exclude:['clothing on body']},relation(),{sceneState});
    const q=qwenReferenceEditPrompt(assembleUnifiedPrompt(composed),[{identityName:'甲',kind:'identity-primary'}]);
    assert.match(q,/Show 甲 unclothed/);
    assert.match(q,/visible bare adult body.*proportionate nipples centered in their areolae/);
    assert.doesNotMatch(q,/Keep unchanged clothing/);
    assert.ok(q.indexOf('Show 甲 unclothed')<q.indexOf('retain each primary face'));
    assert.deepEqual(composed.appearanceChanges,[{character:'甲',state:'unclothed'}]);
});

test('unknown, clothed and off-camera wardrobe records cannot invent undress',()=>{
    for (const value of ['酒红长袍','不是裸体','未知']) {
        const sceneState={persistent_states:[{character:'甲',clothing:[{key:'outfit',value,confirmed:true}]}]};
        assert.deepEqual(composeStoryEdit(edit,relation(),{sceneState}).appearanceChanges,[]);
    }
    for(const [character,confirmed] of [['乙',true],['甲',false]]) {
        const sceneState={persistent_states:[{character,clothing:[{key:'outfit',value:'未穿衣物',confirmed}]}]};
        assert.deepEqual(composeStoryEdit(edit,relation(),{sceneState}).appearanceChanges,[]);
    }
});

test('partial undress and hand-only framing retain their exact scope',()=>{
    const sceneState={persistent_states:[{character:'甲',clothing:[{key:'outfit',value:'上身赤裸，下身仍穿长裤',confirmed:true}]}]};
    const partial=composeStoryEdit(edit,relation(),{sceneState});
    assert.match(partial.editInstruction,/torso bare/);assert.doesNotMatch(partial.editInstruction,/Show 甲 unclothed/);
    const hands=relation({visible_characters:[{canonical_name:'甲',visible_scope:'仅手部'}]});
    assert.deepEqual(composeStoryEdit(edit,hands,{sceneState}).appearanceChanges,[]);
});

test('story references retain every independent identity and omit duplicate costume views',()=>{
    const a={identityName:'甲',identityId:'a',kind:'identity-primary'},b={identityName:'乙',identityId:'b',kind:'identity-primary'};
    const costume={identityName:'甲',identityId:'a',kind:'identity-supporting',viewType:'three_views'};
    const face={identityName:'甲',identityId:'a',kind:'identity-supporting',viewType:'face_crop'};
    const refs=[a,costume,b,face,{...costume,identityId:'b',identityName:'乙'}];
    assert.deepEqual(selectQwenStoryReferences(refs),[a,b,face]);
    assert.equal(selectQwenStoryReferences(refs,{qwenReferencePolicy:'all'}),refs);
});
