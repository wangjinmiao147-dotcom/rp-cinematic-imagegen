import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEditInstructionPrompt, assembleUnifiedPrompt } from '../src/prompts.js';
import { qwenReferenceEditPrompt } from '../src/qwen.js';
import { BODY_STRUCTURE_RULES, VIEWPOINT_STRUCTURE_RULES, FRAMING_PREFERENCES, REFLECTION_STRUCTURE_RULES, UNREQUESTED_REFLECTION_RULE, NON_MIRROR_GLASS_RULE, reflectionRulesForStory, requestsReflection } from '../src/visual-constraints.js';
import { VIEWPOINT_PROMPT_REFERENCES } from '../src/scene-prompt-library.js';
const refs=[{role:'identity-primary',identityName:'A',identityId:'a'}];

test('mirror reduction preserves asymmetric tasks, current props and scoped omissions in both prompt paths',()=>{
    for (const side of ['right','left']) {
        const edit=`Show A facing a wall mirror. Her raised ${side} palm touches the mirror and her other arm hangs down. B stays visible only as a hand holding the lamp.`;
        const assembled=assembleUnifiedPrompt({editInstruction:edit,preserve:'Her new blue robe.',exclude:['a reflected lamp','turning toward the camera']})+'\nVISIBLE CAST (2): A, B. Each listed person has one physical body.';
        const sent=qwenReferenceEditPrompt(assembled,[...refs,{role:'identity-primary',identityName:'B'}]);
        assert.ok(sent.includes(edit));
        for (const retained of ['Her new blue robe','a reflected lamp','turning toward the camera','Visible cast: A, B','<image1>','<image2>']) assert.ok(sent.includes(retained),retained);
        assert.ok(sent.indexOf('both corresponding arms are raised or both lowered')<sent.indexOf('Match <image1>'));
        assert.match(sent,/one shared point on the surface/);
        assert.match(sent,/other arm keeps its own stated task/);
        assert.match(sent,/hand-only participant stays hand-only/);
        assert.doesNotMatch(sent,/FRAMING PREFERENCE:|REFLECTIONS:|REFERENCE MAPPING:/);
        const legacy=qwenReferenceEditPrompt(edit,refs);
        assert.ok(legacy.includes(edit));
        assert.match(legacy,/physical and reflected shoulder, elbow, wrist and palm/);
    }
});

test('complete framing reserves physical ornament and floor margins while explicit mirror close-ups keep priority',()=>{
    const full=qwenReferenceEditPrompt(assembleUnifiedPrompt({editInstruction:'Show A standing at a wall mirror.'}),refs);
    assert.match(full,/four fifths of the image height/);
    assert.match(full,/background above the highest ornament and floor below the feet/);
    assert.match(full,/a complete reflection cannot replace a cropped physical figure/);
    const close='Show an explicit close-up of A\'s hand touching a mirror; the face and feet stay outside the frame.';
    const portrait=qwenReferenceEditPrompt(assembleUnifiedPrompt({editInstruction:close,shotMode:'portrait'}),refs);
    assert.ok(portrait.includes(close));
    assert.match(portrait,/Explicit full-body, viewpoint and partial-body instructions take priority/);
    assert.doesNotMatch(portrait,/four fifths|head to toe/);
});

test('mirror prose keeps a grounded psychological bubble while ordinary mirror images omit it',()=>{
    const edit='Show A facing a mirror in her confirmed relieved inner moment.';
    const plain=qwenReferenceEditPrompt(assembleUnifiedPrompt({editInstruction:edit}),refs);
    assert.doesNotMatch(plain,/thought[- ]bubble|chibi/i);
    const authorized=qwenReferenceEditPrompt(assembleUnifiedPrompt({editInstruction:edit+' Add a small thought bubble with her own relieved chibi avatar.'}),refs);
    assert.match(authorized,/specified inner reaction/);
    assert.match(authorized,/not another physical cast member/);
});

test('story and portrait preferences survive the Qwen reduction and preserve explicit close-ups and partial actors',()=>{
    for(const shotMode of ['snapshot','portrait']){
        const full=assembleUnifiedPrompt({editInstruction:'Show A reading beside the door; B is visible only as a hand offering a book.',shotMode});
        const sent=qwenReferenceEditPrompt(full,refs);
        assert.ok(full.includes(FRAMING_PREFERENCES[shotMode]));
        assert.ok(sent.includes(FRAMING_PREFERENCES[shotMode]));
        assert.match(sent,/B is visible only as a hand/);
        assert.doesNotMatch(sent,/FRAMING PREFERENCE:|REFLECTIONS:|\{framing_preference\}/);
    }
    const close=qwenReferenceEditPrompt(assembleUnifiedPrompt({editInstruction:'Show an explicitly requested close-up of A\'s hands folding the paper.',shotMode:'snapshot'}),refs);
    assert.match(close,/Explicit shot instructions and each participant's established visible scope take priority/);
    assert.match(close,/honor close-ups and existing natural occlusion/);
});

test('a grounded mirror retains optical pose and crop rules without counting a second physical actor',()=>{
    const edit='Show A facing a tall wall mirror, holding the cup in her right hand, with the corresponding reflection inside the mirror.';
    const full=assembleUnifiedPrompt({editInstruction:edit});
    const sent=qwenReferenceEditPrompt(full,refs);
    assert.ok(full.includes(REFLECTION_STRUCTURE_RULES)&&sent.includes(REFLECTION_STRUCTURE_RULES));
    assert.match(BODY_STRUCTURE_RULES,/facial features stay outside the direct view/);
    assert.match(sent,/same pose, head direction, gaze, clothing, held objects and contacts/);
    assert.match(sent,/same anatomical hand or limb/);
    assert.match(sent,/within the mirror or water boundary/);
    assert.match(sent,/Each person appears once as a physical figure/);
    assert.doesNotMatch(sent,/UNREQUESTED_REFLECTION_RULE|Do not add an unrequested mirror/);
    assert.ok(qwenReferenceEditPrompt(edit,refs).includes(REFLECTION_STRUCTURE_RULES));
});

test('a bathroom or excluded mirror cannot invent a reflection',()=>{
    for(const edit of ['Show A standing inside a bathroom.','Show A standing without a mirror.','Show A standing. Do not show any reflection.']){
        const sent=qwenReferenceEditPrompt(assembleUnifiedPrompt({editInstruction:edit,exclude:['mirror','reflection']}),refs);
        assert.equal(requestsReflection(edit),false);
        assert.ok(sent.includes(UNREQUESTED_REFLECTION_RULE));
        assert.ok(!sent.includes(REFLECTION_STRUCTURE_RULES));
    }
    assert.equal(requestsReflection('Keep her reflection visible in the mirror.'),true);
    assert.equal(requestsReflection('镜中倒影与她的姿态一致。'),true);
    assert.equal(requestsReflection('没有镜子。'),false);
    assert.equal(requestsReflection('Show A standing. Exclude all mirrors and reflections.'),false);
    assert.equal(requestsReflection('Show A standing without a mirror or reflections.'),false);
});

test('frosted doors do not turn into portrait-bearing mirrors in either backend path',()=>{
    for (const edit of ['Show A knocking on a frosted-glass door.', 'A站在磨砂玻璃淋浴门前，手掌贴着玻璃。']) {
        assert.equal(requestsReflection(edit), false);
        const assembled = assembleUnifiedPrompt({editInstruction: edit});
        for (const sent of [qwenReferenceEditPrompt(assembled, refs), qwenReferenceEditPrompt(edit, refs)]) {
            assert.ok(sent.includes(NON_MIRROR_GLASS_RULE));
            assert.ok(sent.includes(UNREQUESTED_REFLECTION_RULE));
            assert.ok(!sent.includes(REFLECTION_STRUCTURE_RULES));
            assert.doesNotMatch(sent, /a grounded optical reflection follows|only a full-length reflection/);
            assert.ok(sent.includes(edit));
        }
    }
    assert.ok(reflectionRulesForStory('Show A at the clear-glass window with B explicitly visible beyond it.').includes('explicitly established beyond it'));
});

test('a requested reflected face follows its own view rather than the physical face visibility',()=>{
    const edit = 'Observe A from behind as she touches a wall mirror with her right hand, with her front visible in the mirror.';
    const sent=qwenReferenceEditPrompt(assembleUnifiedPrompt({editInstruction:edit}),refs);
    assert.ok(sent.includes(REFLECTION_STRUCTURE_RULES));
    assert.match(sent,/main camera and the mirror view see different projections/);
    assert.match(sent,/hiding the physical face in a rear view does not automatically hide the reflected face/);
    assert.match(sent,/mirror view's own head perspective, eye visibility and foreshortening/);
    assert.match(sent,/align fingertip-to-fingertip/);
    assert.ok(!reflectionRulesForStory(edit).includes(NON_MIRROR_GLASS_RULE));
});

test('rear adult figure keeps visible-surface rules before anatomy and visible identity without rotating to show them',()=>{
    const edit='Show adult A unclothed in a full-body direct rear view, with body and head facing away, arms relaxed and feet parallel.';
    const full=assembleUnifiedPrompt({editInstruction:edit,preserve:'Her original long hair.',exclude:['visible face','turning head']});
    const sent=qwenReferenceEditPrompt(full,refs);
    for(const text of [edit,'Her original long hair','visible face','turning head']) assert.ok(sent.includes(text));
    assert.ok(sent.indexOf(VIEWPOINT_STRUCTURE_RULES)<sent.indexOf('On the visible bare adult body'));
    assert.match(sent,/only on surfaces actually visible from the requested camera/);
    assert.match(sent,/Only when the corresponding anterior chest surface is visible/);
    assert.match(sent,/Never turn the head or torso, change the camera position or move existing hair or limbs/);
    assert.match(sent,/retain each primary face, eye design and color and hairline only where visible/);
    assert.match(sent,/An unseen face remains unseen/);
});

test('rear view keeps the requested pose and cannot be forced to show a face by the unified or Qwen prompt',()=>{
    const edit='Show A directly from behind in her current burgundy robe, keeping her head facing away and her hand on the door.';
    const full=assembleUnifiedPrompt({editInstruction:edit});
    const sent=qwenReferenceEditPrompt(full,refs);
    assert.ok(full.includes(edit)&&sent.includes(edit));
    assert.ok(full.includes(VIEWPOINT_STRUCTURE_RULES)&&sent.includes(VIEWPOINT_STRUCTURE_RULES));
    assert.match(sent,/face and anterior torso surfaces remain outside the direct view/);
    assert.match(sent,/requested camera position and body and head directions override the reference viewing angle/);
    assert.match(sent,/rather than substituting a three-quarter view/);
    assert.match(sent,/Moving the camera preserves the current pose/);
    assert.doesNotMatch(BODY_STRUCTURE_RULES,/both eyes and brows/);
    assert.match(BODY_STRUCTURE_RULES,/Do not turn the head or reveal hidden features/);
});

test('strict side view protects a naturally hidden far eye and limbs in the legacy Qwen path too',()=>{
    const edit='Show A in strict left profile, maintaining the current walking pose and naturally hidden far hand.';
    const sent=qwenReferenceEditPrompt(edit,refs);
    assert.ok(sent.includes(edit));
    assert.match(sent,/strict facial profile, the naturally occluded far eye stays hidden/);
    assert.ok(sent.includes(VIEWPOINT_STRUCTURE_RULES));
    assert.match(sent,/Show only the digits and limbs visible/);
});

test('both scene and portrait analysis honor explicit direction without suggesting that all faces must be shown',()=>{
    for(const shotMode of ['snapshot','portrait']){
        const p=buildEditInstructionPrompt({shotMode,latestStory:'A站在门边，没有回头。',latestUserInstruction:'本张插画从正后方看，动作不变。'});
        assert.ok(p.userText.includes('本张插画从正后方看，动作不变。'));
        assert.doesNotMatch(p.system,/尽量让脸可辨认/);
        assert.match(p.system,/主脸在背面或画外时不为了体现表情新增脸或回头/);
        assert.match(p.system,/观察方向、身体朝向、头部朝向和视线分别处理/);
    }
});

test('viewpoint catalogue distinguishes rear, strict profile, front and rear three-quarter and camera heights',()=>{
    const view=id=>VIEWPOINT_PROMPT_REFERENCES.find(item=>item.id===id);
    assert.match(view('rear_view').guidance,/骨盆臀部与大腿连接/);
    assert.match(view('strict_profile').guidance,/不改成正面或三分之四/);
    assert.match(view('front_three_quarter').guidance,/不把肩胯五官拉成正面镜像/);
    assert.match(view('rear_three_quarter').guidance,/不自动回眸/);
    assert.match(view('high_angle').guidance,/不自动让人物低头/);
    assert.match(view('low_angle').guidance,/不自动让人物仰头/);
    assert.match(view('camera_pose_separation').guidance,/镜头绕后不证明人物转身/);
});
