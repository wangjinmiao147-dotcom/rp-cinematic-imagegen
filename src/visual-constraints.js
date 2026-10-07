import { storyTextForIllustration } from './story-text.js';

export const NATURAL_POSTURE_RULE = 'Preserve the selected action and support contacts. Connect the ribcage, waist and pelvis as one continuous torso, with a natural lumbar curve and plausible weight distribution. Explicit bending, arching, twisting, floating and established nonhuman anatomy retain their requested form. Preserve reference-supported nonhuman features and limb layout only where compatible with the current form.';

export function postureRulesForStory(text) {
    const story=String(text || '');
    const backSupport=/\b(?:lean(?:s|ing)?|rest(?:s|ing)?)\s+(?:(?:her|his|their|the)\s+)?back\s+(?:against|on)\b|\bback\s+(?:leaning|resting|supported|pressed)\s+against\b/i.test(story);
    const explicitArch=/\b(?:arch(?:es|ed|ing)?|backbend|contort(?:ed|ion)?)\b/i.test(story);
    return NATURAL_POSTURE_RULE+(backSupport && !explicitArch
        ? ' For the figure whose back is supported by the stated surface, retain that rear contact, a gently inclined connected torso, and a ribcage centered above the pelvis. The support contact defines the lean; the arms keep their own specified tasks.' : '');
}

export const BODY_STRUCTURE_RULES = `BODY STRUCTURE AND CONTACTS:
Keep each main figure's reference body build, head-to-body ratio, torso volume and limb proportions where visibly established. A portrait or clothing does not establish hidden anatomy: construct those parts naturally and do not mistake garment volume for body volume. Render a coherent three-dimensional body in the reference drawing style. For human-shaped figures, connect neck, ribcage, waist and pelvis naturally, with two arms and two legs unless an explicit design or story change says otherwise. Preserve expressly designed nonhuman features without inventing new ones.
When the main face is visible, construct only its visible features on one coherent facial plane. Visible eyes and brows follow the same head tilt and perspective, with compatible eye axes, inner-corner placement and iris alignment. Preserve reference eye shape and proportions while allowing the requested expression; account for foreshortening rather than independently tilting, shrinking or shifting one eye. Keep any visible nose and mouth aligned with that same face plane. In a strict facial profile, the naturally occluded far eye stays hidden; in a direct rear view with the head facing away, facial features stay outside the direct view. Do not turn the head or reveal hidden features to demonstrate identity.
Each arm has one continuous shoulder-to-upper-arm-to-elbow-to-forearm-to-wrist-to-hand chain; each leg has one hip-to-thigh-to-knee-to-calf-to-ankle-to-foot chain. Joints bend plausibly. Keep overlapping limbs distinct through consistent contours and occlusion, attached to their own bodies. Preserve natural torso and shoulder contours under the requested pose rather than stretching, flattening or merging them with arms.
For ordinary human hands, use one palm, one correctly placed thumb and four fingers with natural joints and proportions; for exposed ordinary human feet, use a coherent heel, arch, forefoot and five toes. Show only the digits and limbs visible from the requested pose and crop; do not spread hands, reveal hidden digits, expose covered feet or add limbs to demonstrate their count. Preserve the exact task and contact: a working hand cannot simultaneously remain locked in another incompatible two-hand pose. Keep grasping, touching and weight-bearing contacts physically coherent.`;

export const VIEWPOINT_STRUCTURE_RULES = 'Honor the requested viewing side, height and crop before transferring reference details. The requested camera position and body and head directions override the reference viewing angle. For a direct rear view with the head facing away, depict the back of the head and the naturally visible posterior body surfaces; the face and anterior torso surfaces remain outside the direct view. Keep that direct rear view rather than substituting a three-quarter view or an over-the-shoulder glance. In a facial profile, the naturally occluded far eye stays hidden. Do not change the stated head direction, body orientation or gaze to copy a frontal reference. Moving the camera preserves the current pose, body proportions and natural occlusion, including the back-pelvis-thigh connections.';

export const FRAMING_PREFERENCES = Object.freeze({
    snapshot: 'When no explicit close-up or partial-body crop is requested, use a complete story composition with the main physical figure visible from head to toe and enough setting to understand the action. Frame the physical foreground figure first: widen the view or move the camera back enough to fit its entire silhouette, including the top of the hair and ornaments and the lowest visible body or garment edge, with clear space above and below it. For this default complete view, fit the physical silhouette within about four fifths of the image height, leaving a visible strip of background above the highest ornament and floor below the feet. A portrait reference supplies identity and style, not its output crop. Explicit shot instructions and each participant\'s established visible scope take priority: keep hand-only people hand-only, honor close-ups and existing natural occlusion, and never alter posture or expose hidden parts just to complete the frame.',
    portrait: 'When no explicit alternative crop is requested, prefer face-and-shoulders framing with the necessary gesture or interaction. Explicit full-body, viewpoint and partial-body instructions take priority over this portrait preference. Preserve each participant\'s established visible scope and natural occlusion; never turn the head or expand a hand-only person to demonstrate identity.',
});

export function framingPreference(shotMode = 'snapshot') {
    return FRAMING_PREFERENCES[shotMode] || FRAMING_PREFERENCES.snapshot;
}

export const REFLECTION_STRUCTURE_RULES = 'A reflection is the same physical person at the same instant. Project the same pose, head direction, gaze, clothing, held objects and contacts within the mirror or water boundary, using the established surface and camera. Keep each action on the same anatomical hand or limb. Match the physical and reflected shoulder, elbow, wrist and palm as one synchronized chain: both corresponding arms are raised or both lowered, with the same bend and task. At a mirror contact, the physical palm and its optical image meet at one shared point on the surface and align fingertip-to-fingertip; the reflected wrist and forearm connect that contact to the reflected body. The other arm keeps its own stated task in both views. Preserve natural occlusion and the mirror frame; never add a floating hand to demonstrate contact. The main camera and the mirror view see different projections of this same body. Use the mirror view\'s own head perspective, eye visibility and foreshortening; hiding the physical face in a rear view does not automatically hide the reflected face. Transfer the same identity only to features visible in each view. Fit the physical figure within its requested scope; a complete reflection cannot replace a cropped physical figure. When geometry is unspecified, use a simple consistent layout compatible with the stated positions and actions. Only the designated reflecting surface shows the specified reflected cast. Explicit supernatural mirror events follow the selected story facts.';

export const UNREQUESTED_REFLECTION_RULE = 'Do not add an unrequested mirror, reflected person or reflective duplicate. A room or bathroom alone does not establish a mirror or visible reflection.';

export const NON_MIRROR_GLASS_RULE = 'Preserve the stated glass material and transparency: frosting or condensation diffuses light; clear glass shows only the scene explicitly established beyond it. Keep the glass as a scene surface with its existing texture and environmental highlights. Show the specified physical cast in their established positions, without a copied face, body, hand or human silhouette on the glass. A glass door, window or shower panel is not automatically a person-reflecting mirror.';

export function reflectionRulesForStory(text) {
    if (requestsReflection(text)) return REFLECTION_STRUCTURE_RULES;
    const hasGlass = /\b(?:glass|glazed|frosted|translucent\s+(?:door|pane|panel))\b|玻璃|磨砂/i.test(String(text || ''));
    return hasGlass ? `${NON_MIRROR_GLASS_RULE} ${UNREQUESTED_REFLECTION_RULE}` : UNREQUESTED_REFLECTION_RULE;
}

export function requestsReflection(text) {
    return String(text || '').split(/(?<=[.!?。！？])\s*/).some(sentence => {
        const positive = sentence.replace(/\b(?:no|without|omit|exclude|avoid|never|do not (?:add|show|depict|include))\s+(?:a\s+|any\s+|the\s+|all\s+)?(?:[a-z-]+\s+){0,2}(?:mirrors?|reflections?|reflected\s+(?:people|person|figure|image))(?:\s+(?:or|and)\s+(?:a\s+|any\s+|the\s+|all\s+)?(?:mirrors?|reflections?|reflected\s+(?:people|person|figure|image)))*/gi, '')
            .replace(/(?:没有|无|不(?:要|添加|出现|显示)|禁止|排除)[^，。！？;]{0,8}(?:镜子|镜面|倒影|反射)/g, '');
        return /\b(?:mirrors?|reflections?|reflecting\s+surface|reflected\s+(?:image|figure|person))\b|镜子|镜面|镜中|倒影|水面反射/i.test(positive);
    });
}

export const ARTISTIC_ANATOMY_RULE = 'For an adult figure in a nonsexual artistic nude, retain ordinary anatomical landmarks only on surfaces actually visible from the requested camera. When the corresponding anterior chest surface is visible, include naturally proportioned nipples centered in their areolae on the breast surfaces and aligned with torso perspective. Define local contours and tonal separation at the reference medium and level of simplification, consistent with anatomy and pose. Keep the pelvic region and its naturally visible external anatomy spatially coherent, with normal placement, proportions and connections. Preserve the requested unclothed state and ordinary visible anatomy. Do not invent coverings, mosaics, blur or concealment shadows, or change the pose or crop to conceal it. Preserve only occlusion already caused by the requested current pose, existing scene objects or framing. Never turn the head or torso, change the camera position or move existing hair or limbs to display hidden landmarks. Apply this only to the main adult figure and the requested visible range.';
export function requestsArtisticBodyAnatomy(text) {
    return String(text || '').split(/(?<=[.!?])\s+/).some(s => /\b(?:nude|naked|unclothed|bare[- ](?:chest|breasts?|torso)|topless)\b/i.test(s)
        && !/\b(?:no|not|never|without|avoid|exclude|do not (?:show|depict))\s+(?:a\s+|any\s+)?(?:nude|nudity|naked|unclothed|bare|topless)/i.test(s));
}

const str = x => typeof x === 'string' ? x.trim() : '';
const bubbleWords = /\b(?:thought[- ]bubble|chibi(?:\s+(?:avatar|version|figure))?)\b|思考泡|Q版/i;

export function hasRequestedThoughtBubble(text) {
    return String(text || '').split(/(?<=[.!?])\s+/).some(s => bubbleWords.test(s)
        && !/\b(?:no|without|omit|exclude|do not|never)\s+(?:a\s+|any\s+)?(?:thought[- ]bubbles?|chibi)/i.test(s));
}

// An optional visual layer: incomplete psychology must never stop the story image.
// The facts model identifies explicit inner emotion; the relation model cannot
// turn an informational thought into an emotion. No emotion keyword whitelist.
export function normalizePsychologicalReactions(input, relation, options = {}, note = () => {}) {
    const source = storyTextForIllustration(options.latestStory || '');
    const canonical = name => {
        let n = str(name); const seen = new Set();
        while (relation.aliases?.[n] && !seen.has(n)) { seen.add(n); n = relation.aliases[n]; }
        return n;
    };
    const people = new Map(relation.visible_characters.map(p => [canonical(p.canonical_name), p]));
    const thoughts = options.sceneFacts?.thoughts;
    const seen = new Set();
    return (Array.isArray(input) ? input : input ? [input] : []).flatMap((r, i) => {
        const character = canonical(r?.character), emotion = str(r?.emotion), evidence = str(r?.evidence);
        const person = people.get(character);
        const thought = (Array.isArray(thoughts) ? thoughts : []).find(t => canonical(t.character) === character
            && str(t.content) && str(t.evidence) && source.includes(t.evidence)
            && str(t.emotion) && !/^(?:null|none|neutral|无|未知|中性)$/i.test(str(t.emotion))
            && str(t.emotion_evidence) && t.evidence.includes(t.emotion_evidence)
            && evidence.includes(t.emotion_evidence));
        const headAbsent = /仅.*(?:手|脚|腿|躯干)|只有.*(?:手|脚)|不.*(?:头|脸)|head.*(?:off|outside)|(?:hand|feet|foot|legs?|torso)[ -]only/i.test(person?.visible_scope || '');
        if (!person || headAbsent || !thought || !emotion || /^(?:null|none|neutral|无|未知|中性)$/i.test(emotion)
            || !evidence || (options.latestStory !== undefined && !source.includes(evidence)) || seen.has(character)) {
            note(`psychological_reactions.${i}`, '心理视觉层缺少有效主人、情绪或依据，略过气泡');
            return [];
        }
        seen.add(character);
        return [{ character, emotion:str(thought.emotion), evidence:str(thought.emotion_evidence) }];
    });
}

// Older responses sometimes place the bubble in the physical-action field.
// Keep the ordinary image usable and move that optional clause into its own layer.
export function separateThoughtBubbleText(text) {
    const physical = [], bubbles = [];
    for (const sentence of str(text).split(/(?<=[.!?])\s+/)) {
        if (!bubbleWords.test(sentence)) { physical.push(sentence); continue; }
        const clause = sentence.match(/^(.*?)(?:[,;]\s*(?:and\s+)?(?:add|place|include|reserve)\b|\s+(?:with|alongside)\s+(?:a\s+)?(?=[^.!?]*\b(?:thought[- ]bubble|chibi)\b))(.*)$/i);
        if (clause && str(clause[1])) {
            physical.push(str(clause[1]).replace(/[,.!?;]+$/, '') + '.');
            bubbles.push(sentence.slice(clause[1].length).replace(/^[,;\s]+/, ''));
        } else bubbles.push(sentence);
    }
    return { physical: physical.join(' ').trim(), bubbles: bubbles.join(' ').trim() };
}

export function verifiedAppearanceChanges(sceneState = {}, relationFacts = {}) {
    const canonical = name => relationFacts.aliases?.[name] || name;
    const visible = new Map((relationFacts.visible_characters || []).map(p => [canonical(p.canonical_name), p]));
    return (sceneState?.persistent_states || []).flatMap(p => {
        const character = canonical(p.character), actor = visible.get(character);
        if (!actor || /仅.*(?:手|脚)|(?:hand|foot|feet)[ -]only/i.test(actor.visible_scope || '')) return [];
        const outfit = (p.clothing || []).find(s => s.key === 'outfit' && s.confirmed === true);
        const value = str(outfit?.value);
        if (!value || /并非|不是|非全裸|not (?:nude|naked|unclothed)/i.test(value)) return [];
        const partial = /半裸|上(?:半)?身.*(?:裸|未穿)|topless|bare[- ](?:chest|torso)/i.test(value);
        const unclothed = /未(?:穿|着)(?:任何)?(?:衣物|衣服|衣裳|衣)|没有穿衣|全裸|裸体|赤身|不着寸缕|一丝不挂|\b(?:unclothed|naked|nude)\b/i.test(value);
        return partial ? [{character, state:'bare_torso'}] : unclothed ? [{character, state:'unclothed'}] : [];
    });
}

export function composeStoryEdit(editResult, relationFacts = {}, options = {}) {
    const old = separateThoughtBubbleText(editResult.edit_instruction);
    const reactions = options.sceneFacts !== undefined
        ? normalizePsychologicalReactions(relationFacts.psychological_reactions, relationFacts, options)
        : relationFacts.psychological_reactions || [];
    const requested = str(editResult.thought_bubble_instruction) || old.bubbles;
    const bubble = reactions.length && hasRequestedThoughtBubble(requested) ? requested : '';
    // Strip bubble-only exclusions when the optional layer is absent to avoid priming it.
    const exclude = (editResult.exclude || []).filter(e => bubble || !bubbleWords.test(e));
    const preserve = bubble ? str(editResult.preserve) : separateThoughtBubbleText(editResult.preserve).physical;
    const appearanceChanges = verifiedAppearanceChanges(options.sceneState, relationFacts);
    const currentAppearance = appearanceChanges.map(p => p.state === 'unclothed'
        ? `Show ${p.character} unclothed; retain the selected pose and visible range.`
        : `Keep ${p.character}'s torso bare; retain the confirmed lower-body clothing, pose and crop.`).join(' ');
    return { editInstruction: [currentAppearance, old.physical, bubble].filter(Boolean).join(' '), preserve, exclude,
        thoughtBubbleApplied: !!bubble, psychologicalReactions: reactions, appearanceChanges };
}
