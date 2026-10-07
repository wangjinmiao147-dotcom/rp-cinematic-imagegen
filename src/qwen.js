import { BODY_STRUCTURE_RULES, postureRulesForStory, VIEWPOINT_STRUCTURE_RULES, ARTISTIC_ANATOMY_RULE, requestsArtisticBodyAnatomy, hasRequestedThoughtBubble, framingPreference, reflectionRulesForStory, requestsReflection } from './visual-constraints.js';

// Local Qwen uses its own bounded controls; SD controls belong to SD only.
export function isLocalQwen(settings = {}) {
    try {
        const url = new URL(settings.backendUrl);
        return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
            && (url.port === '8055' || (settings.isLocalQwenBridge === true && /qwen/i.test(settings.backendModel || '')));
    } catch { return false; }
}

export function qwenSteps(value) {
    const number = Number(value);
    return Math.max(12, Math.min(25, Number.isFinite(number) && number > 0 ? Math.round(number) : 20));
}

export function qwenSize(settings = {}, ratio = '16:9') {
    const resolution = settings.qwenResolution;
    const tier = resolution === '512x288' ? 0 : resolution === '768x432' ? 1 : resolution === '1024x576' ? 2
        : settings.qwenResolutionTier === 'high' ? 2 : 0;
    const sizes = {
        '16:9': [[512, 288], [768, 448], [1024, 576]],
        '9:16': [[288, 512], [448, 768], [576, 1024]],
        '1:1': [[512, 512], [512, 512], [768, 768]],
        '2.39:1': [[512, 256], [768, 320], [1024, 416]],
        '4:3': [[512, 384], [640, 480], [1024, 768]],
        '3:4': [[384, 512], [480, 640], [768, 1024]],
    };
    return (sizes[settings.imageSize || ratio] || sizes['16:9'])[tier];
}

export function qwenIdentityRenderSettings(settings = {}, refs = []) {
    // An explicitly chosen lightweight output must never be promoted by the old checkbox.
    if (settings.qwenResolution === '512x288' || (!settings.qwenResolution && settings.qwenResolutionTier !== 'high')) return settings;
    if (settings.qwenIdentityDetailBoost !== true || !refs.some(r => (r.role || r.kind) === 'identity-primary')) return settings;
    // Keep the user's saved standard preset available; the reversible quality
    // mode selects the tested detail profile only for identity-based requests.
    return {...settings, qwenResolution:'1024x576', qwenReferenceProfile:'detail',
        qwenSteps:Math.min(20,qwenSteps(settings.qwenSteps))};
}

// An opt-in whole-scene render keeps the saved sampler controls and returns
// a 512-long-edge illustration after one diffusion pass and whole-frame resize.
export function qwenSceneRenderPlan(settings = {}, refs = [], ratio = '16:9', prompt = '') {
    if (settings.qwenSceneDetail !== true || !refs.some(r => (r.role || r.kind) === 'identity-primary')) return null;
    // The high-resolution mirror regression changed the physical view. Keep
    // reflection scenes on their previously validated saved-resolution path.
    const text=String(prompt || '');
    const story=text.match(/REQUESTED CHANGES:\s*([\s\S]*?)(?=DETAILS TO PRESERVE:|VISIBLE CAST|REFERENCE MAPPING:|$)/i)?.[1]?.trim() || text;
    const preserve=text.match(/DETAILS TO PRESERVE:\s*([\s\S]*?)(?=ELEMENTS TO OMIT:|VISIBLE CAST|REFERENCE MAPPING:|$)/i)?.[1]?.trim() || '';
    if (requestsReflection(story+' '+preserve)) return null;
    const sizes = {
        '16:9': [[1024,576],[512,288]], '9:16': [[576,1024],[288,512]],
        '1:1': [[768,768],[512,512]], '4:3': [[1024,768],[512,384]],
        '3:4': [[768,1024],[384,512]], '2.39:1': [[992,416],[512,214]],
    };
    const [renderSize, outputSize] = sizes[settings.imageSize || ratio] || sizes['16:9'];
    return {renderSize:[...renderSize],outputSize:[...outputSize],referenceProfile:'detail'};
}

export function referenceRole(ref, index) {
    const role = ref.role || ref.kind;
    if (role === 'scene-layout') return `geometric layout only: the left mannequin is ${ref.posePlan.identityNames[0]}, the right mannequin is ${ref.posePlan.identityNames[1]}; use their connected torso poses, support and working-arm positions, not their appearance or gray material`;
    if (role === 'mirror-layout') return 'geometric scene layout only: one physical body and its optical mirror image, projected from the same pose; not an identity, clothing or style source';
    if (role === 'continuity') return 'previous story frame: unchanged clothing and props only; never a face or style source';
    if (role === 'identity-primary') return index === 0
        ? 'same-person identity, body design and artwork style; facial design applies only when the face is visible in the requested view'
        : 'same-person identity and body design; facial design applies only when the face is visible in the requested view';
    const type = ref.viewType || ref.type || ref.label || '';
    if (/face_crop|脸部特写|face detail/i.test(type)) return 'face detail cropped from the primary image of this SAME person: preserve the original facial proportions, eye shape and eye color; it supplies facial detail, not another person or a new composition';
    if (/three_views|三视|turnaround|3 views/i.test(type)) return 'design sheet of this SAME person: clothing and side/back details; never copy its panels, labels or extra views into the output';
    return 'supporting view of this SAME person: compatible clothing, body build, limb proportions and visible design details; primary identity and style take priority';
}

export function activeReferenceViews(views = []) {
    return views.filter(ref => ref && (ref.enabled !== false || ref.isPrimaryIdentity === true));
}

export function selectQwenStoryReferences(refs = [], settings = {}) {
    if (!Array.isArray(refs) || settings.qwenReferencePolicy === 'all') return refs;
    const primaries = refs.filter(r => (r?.role || r?.kind) === 'identity-primary');
    if (!primaries.length) return refs; // Unknown legacy roles cannot establish who may be omitted.
    const owner = r => r.identityId || r.identityName || '';
    const owners = new Set(primaries.map(owner));
    const faceOwners = new Set();
    return [...primaries, ...refs.filter(r => {
        const role = r?.role || r?.kind;
        if (role === 'identity-primary') return false;
        if (role === 'continuity') return true;
        const id = owner(r);
        if (!owners.has(id) || faceOwners.has(id) || !/face_crop|脸部特写|face detail/i.test(r.viewType || r.type || r.label || '')) return false;
        faceOwners.add(id);
        return true;
    })];
}

// This input is a selected region of a finished illustration, not a character
// reference for another story frame. The caller composites only its edit mask.
export function qwenDetailEditPrompt(instruction) {
    const detail = String(instruction || '').trim();
    return `Refine only the explicitly requested detail in this cropped region of an existing illustration: ${detail} Preserve the current shapes, natural scale, perspective, poses and contacts, existing occlusion, illumination and colors, and the original drawing medium, linework and shading. Retain existing surface conditions such as wetness. Keep every other detail unchanged; do not add an unrequested person, pose, covering, accessory, background or text.`.replace(/\s+/g, ' ').trim();
}

// Mirror scenes need the linked action before reference-design boilerplate.
// Keep all selected facts and scoped omissions; reduce repeated general rules.
function mirrorStoryPrompt({ story, framing, reflection, preserve = '', cast = '', omit = '', source, mapping = '', art = '', bubble = '', layout = null, layoutTag = '' }) {
    if (layout) {
        const physical=layout.cameraSide==='left'?'right':'left',optical=physical==='right'?'left':'right';
        const other=layout.hand==='right'?'left':'right';
        return `Render one coherent finished story illustration using the exact scene geometry in ${layoutTag} and the identity and artwork style from ${source}. ${layoutTag} supplies the whole composition, mirror plane, projected poses and shared palm contact. Its two gray silhouettes represent one physical person and this person's optical mirror image, not two actors. Replace both placeholders with the same current identity and wardrobe. Preserve the guide's figure scale, background above the highest ornament and floor below the feet. Show this selected moment: ${story} ${preserve ? `Preserve: ${preserve.replace(/[.\s]+$/, '')}.` : ''} The physical figure is on the ${physical}, seen from behind and slightly to its ${layout.cameraSide}; the optical image stays within the mirror on the ${optical}, using the mirror view's own face perspective. Both corresponding ${layout.hand} arms are bent and raised, with the physical and reflected ${layout.hand} palms meeting at the guide's one shared contact point at shoulder height. Both ${other} arms keep hanging at the side. Preserve these shoulder-elbow-wrist-hand connections and their natural occlusion. ${cast ? `Visible cast: ${cast}.` : ''} Each person appears once as a physical figure; its optical image is the same identity. Match ${source}'s medium, linework, shading and palette. Retain identity features only where visible in each view; an unseen physical face remains unseen. Current clothing and accessories override outdated references; the geometry guide supplies no wardrobe or identity. Honor stated illumination, without adding a physical light source. Use one scene without text, panels or duplicate design-sheet views. ${omit} ${mapping}`.replace(/\s+/g,' ').trim();
    }
    const crop = framing === framingPreference('snapshot')
        ? 'Unless the selected moment explicitly requests a close-up or partial crop, use a wide head-to-toe view of the physical foreground figure. Fit its entire silhouette within about four fifths of the image height, with a visible strip of background above the highest ornament and floor below the feet. The physical figure is fully inside the image borders; a complete reflection cannot substitute for it. Explicit crops, hand-only participants and natural occlusion take priority.'
        : framing;
    return `Create one coherent story illustration. ${crop} Show this single moment: ${story} ${reflection} Preserve the stated camera side, height, body direction, head direction and gaze. The requested camera position and body and head directions override the reference viewing angle; a rear physical view shows the back of the head. ${preserve ? `Preserve: ${preserve.replace(/[.\s]+$/, '')}.` : ''} ${cast ? `Visible cast: ${cast}.` : ''} Each person appears once as a physical figure; a hand-only participant stays hand-only and off-camera people stay off-camera. Match ${source}'s medium, linework, shading and palette. Retain each primary face, eye design and color and hairline only where visible from the requested view. An unseen face remains unseen. Current wardrobe, hair, accessories, props and transformations override outdated references. Preserve compatible reference body design and distinctive anatomy, without inventing hidden structure or displaying hidden traits. Connect existing shoulder-elbow-wrist-hand and hip-knee-ankle-foot chains naturally; retain their tasks, ownership and occlusion. Honor explicitly stated illumination and sources; when unspecified, keep visible surfaces readable without inventing a physical light source. A visible neutral main face must not inherit a reference blush.${art}${bubble} Use one scene without panels, labels, text or duplicate design-sheet views. ${omit} ${mapping}`.replace(/\s+/g, ' ').trim();
}

// Address each input separately using Qwen's ordered multi-image syntax.
// Keep the selected state and operational constraints; send plain prose to Qwen
// so template headings are not rendered as a reference-sheet layout.
export function qwenReferenceEditPrompt(prompt, refs = [], options = {}) {
    const fullPrompt = String(prompt || '').trim();

    // Unified template path: preserve its facts and scope in a Qwen prose instruction.
    if (fullPrompt.startsWith('Edit the supplied references')) {
        // Map the final uploaded image order and preserve the selected story state.
        const references = Array.isArray(refs) ? refs : [];
        const multiple = references.length > 1;
        const styleSource = multiple ? '<image1>' : 'the supplied image';
        const original = fullPrompt
            .replace(/(?:^|\r?\n)REFERENCE MAPPING:\s*[\s\S]*$/i, '')
            .replace(/\bimage\s+1\b/gi, styleSource)
            .trim();
        const section = (name, next) => original.match(new RegExp(`${name}:\\s*([\\s\\S]*?)(?=${next}|$)`, 'i'))?.[1]?.trim() || '';
        const story = section('REQUESTED CHANGES', 'DETAILS TO PRESERVE:');
        const preserve = section('DETAILS TO PRESERVE', 'ELEMENTS TO OMIT:|VISIBLE CAST|REFERENCE MAPPING:');
        const omit = section('ELEMENTS TO OMIT', 'VISIBLE CAST|REFERENCE MAPPING:');
        const cast = section('VISIBLE CAST \\([^)]*\\)', 'REFERENCE MAPPING:').replace(/\. Each listed[\s\S]*$/, '');
        const framing = section('FRAMING PREFERENCE', 'REFLECTIONS:|THOUGHT BUBBLES:|LIGHTING:|REQUESTED CHANGES:') || framingPreference();
        const reflection = section('REFLECTIONS', 'THOUGHT BUBBLES:|LIGHTING:|REQUESTED CHANGES:') || reflectionRulesForStory(story+' '+preserve);
        const anatomy = `Follow the currently established body form and limb layout. Only in currently human-shaped regions, build naturally connected torso and existing shoulder-elbow-wrist-hand and hip-knee-ankle-foot chains, with any visible eyes aligned. A confirmed human form has two arms and two legs unless its explicit design says otherwise; do not impose human legs or feet on a nonhuman lower body. Only ordinary human hands have one thumb and four fingers, and ordinary human feet five toes, one big toe and four smaller toes; preserve established nonhuman digits. Do not duplicate or fuse visible digits; retain existing occlusion rather than exposing every digit. Each visible limb performs its specified task, respecting occlusion and crop.`;
        const art = requestsArtisticBodyAnatomy(story) ? ` On the visible bare adult body, draw normal anatomical landmarks only on surfaces actually visible from the requested camera and in currently confirmed human-shaped regions. Only when the corresponding anterior chest surface is visible, include proportionate nipples centered in their areolae, aligned with breast surfaces and torso perspective; keep naturally visible external pelvic anatomy coherent only where that region is human-shaped and within the requested range. Never turn the head or torso, change the camera position or move existing hair or limbs to display hidden landmarks. Retain the requested pose and its existing occlusion; body detail follows the reference medium and level of simplification.` : '';
        const bubble = hasRequestedThoughtBubble(story) ? ` The thought bubble contains only this person's recognizable super-deformed chibi: an oversized rounded head, tiny shoulders and a very small simplified body, with clearly exaggerated readable brow, eye and mouth cues for the specified inner reaction. Follow the main figure's current hair state. It has no text and does not alter the main figure's proportions or expression. It is not another physical cast member.` : '';
        // Qwen sometimes renders long uppercase template headings as typography or
        // a reference sheet. Send the same operational constraints as plain prose,
        // with the actual selected action first, rather than the template layout.
        const lighting = `When overall illumination is unspecified, render the currently visible body surfaces in readable midtones with distinct local contours. Honor explicitly stated illumination and physical sources; local shadows stay local. Recalculate exposure for this scene instead of copying reference exposure, without inventing a physical light source.`;
        const mapping = references.map((ref, index) => {
            const tag = multiple ? `<image${index + 1}>` : 'The supplied image';
            const identity = String(ref.identityName || '').trim();
            const role = referenceRole(ref, index);
            // A continuity frame may contain several people; do not assign
            // every person shown in it to a single current identity.
            const owner = (ref.role || ref.kind) === 'continuity'
                ? (identity ? `; matching person: ${identity}` : '')
                : (identity ? `; identity: ${identity}` : '');
            return `${tag}: ${role}${owner}.`;
        }).join('\n');
        const body = `Create one coherent new story illustration using these named identity sources: ${mapping.replace(/\s+/g,' ')} All supplied images provide identity and design, not the new poses, composition or background. Render this selected moment: ${story} ${preserve ? `Preserve: ${preserve.replace(/[.\s]+$/, '')}.` : ''} ${cast ? `Visible cast: ${cast}.` : ''} ${postureRulesForStory(story)} ${framing} ${VIEWPOINT_STRUCTURE_RULES} ${reflection} ${anatomy} ${lighting}${art} Match ${styleSource}'s medium, linework, shading and palette; retain each primary face, eye design and color and hairline only where visible from the requested view, and compatible reference body design and distinctive anatomy. Draw visible facial features as economical, distinct lines and tonal shapes at the current head scale, following the requested perspective, expression and gaze. An unseen face remains unseen. Current wardrobe, hair, accessories, props, poses and setting override outdated references. Keep different named identities separate. Each person appears once as a physical figure; a hand-only participant stays hand-only and off-camera people stay off-camera. Explicit current transformations override outdated reference anatomy. A species name alone does not establish visible anatomy; a head-and-shoulders portrait does not establish hidden lower-body structure. Never alter mouth state, pose or occlusion just to display a species trait; keep a closed mouth closed with no protruding tongue and leave hidden traits hidden. Complete only the established form naturally, without mistaking garment volume for body volume. Reference objects are scene props, not identity or clothing. Keep current object counts and contacts. A visible neutral main face must not inherit a reference blush.${bubble} Use one scene without panels, labels, text or duplicate design-sheet views. ${omit}`.replace(/\s+/g, ' ').trim();

        if (requestsReflection(story+' '+preserve)) {
            const layoutIndex = references.findIndex(ref => (ref.role || ref.kind) === 'mirror-layout');
            return mirrorStoryPrompt({ story, framing, reflection, preserve, cast, omit,
                source: styleSource, mapping, art, bubble,
                layout: layoutIndex < 0 ? null : references[layoutIndex].mirrorPlan,
                layoutTag: layoutIndex < 0 ? '' : `<image${layoutIndex+1}>` });
        }
        // Do not reintroduce a permissive optical-reflection instruction when
        // the selected scene has no reflecting surface or reflected cast.
        const sentBody = requestsReflection(story+' '+preserve) ? body
            : body.replace('; a grounded optical reflection follows the reflection rules', '');
        if (options.compactScene) {
            const crop = framing === framingPreference('snapshot')
                ? 'Unless an explicit close-up, partial crop or natural occlusion is requested, fit the main physical figure from head to toe within about four fifths of the image height, with space above the highest hair ornament and floor below the feet. Each participant keeps the stated visible scope; hand-only participants remain hand-only. Reference portraits do not set the output crop.' : framing;
            const poseIndex=references.findIndex(ref=>(ref.role || ref.kind)==='scene-layout');
            if(poseIndex>=0){
                const tag=`<image${poseIndex+1}>`,plan=references[poseIndex].posePlan;
                return `Compose one finished story illustration using the two-person geometry in ${tag}. ${mapping} Replace the left mannequin with ${plan.identityNames[0]} and the right mannequin with ${plan.identityNames[1]}, retaining their projected body positions, figure scale and connected limb poses. The left figure's back rests against the support surface; its chest, waist and pelvis follow the guide's continuous gently inclined torso. The right figure bends toward the left, with its working ${plan.hand ? plan.hand+' ' : ''}hand reaching along the guide's shoulder, elbow and wrist. Render this selected moment: ${story} ${preserve ? `Preserve: ${preserve}.` : ''} ${cast ? `Visible cast: ${cast}.` : ''} ${crop} Match ${styleSource}'s medium, linework, shading and palette. Draw each face in its current head perspective from its own identity source, with distinct visible features and the requested expression and gaze. Keep visible hands joined to their own wrists, with compact naturally bent fingers performing only the specified task; retain natural overlap and occlusion. Current clothing and objects override references. Rebuild the setting from this story, keeping the guide's support contact. The guide supplies geometry only. Reference costumes, background and old arm gestures do not define the selected action. ${reflection} Use one scene without gray mannequins, text or panels. ${omit}`.replace(/\s+/g,' ').trim();
            }
            return `Create a new coherent story illustration from these named identity sources: ${mapping} Each source supplies only its named person, not a scene canvas. Replace the source poses and background with this selected moment: ${story} ${preserve ? `Preserve current story details: ${preserve}.` : ''} ${cast ? `Visible cast: ${cast}.` : ''} ${postureRulesForStory(story)} ${crop} Retain the stated camera, body and head directions, gaze, expression and natural occlusion. Transfer visible facial features in the requested head perspective, using distinct economical lines and tonal shapes at the current head size; unseen features remain hidden. Keep each person's identity separate, with one physical body and its own shoulder-elbow-wrist-hand and hip-knee-ankle-foot connections in confirmed human-shaped regions. Preserve explicit nonhuman forms and transformations; a portrait or costume does not establish hidden anatomy. Visible hands stay joined to their own wrists, with compact naturally bent fingers performing only the specified task; retain overlap, occlusion and contacts. Match ${styleSource}'s drawing medium, linework, shading and palette throughout. Current clothing, hair, accessories, objects and their counts override old reference details. Keep the stated illumination; unspecified lighting leaves visible surfaces readable. A neutral main face does not inherit reference blush.${art}${bubble} ${reflection} Use one finished scene without text, panels or duplicate design-sheet views. ${omit}`.replace(/\s+/g,' ').trim();
        }
        return sentBody;
    }

    // Legacy path: non-unified-template input, keep compatible behavior
    const story = String(prompt || '').match(/REQUESTED CHANGES:\s*([\s\S]*?)(?=DETAILS TO PRESERVE:|VISIBLE CAST|REFERENCE MAPPING:|$)/i)?.[1]?.trim()
        || String(prompt || '').trim();
    // Current clothing and props may be in preserve rather than edit_instruction.
    // Keep that confirmed story state when reducing the unified template for Qwen.
    const preserve = String(prompt || '').match(/DETAILS TO PRESERVE:\s*([\s\S]*?)(?=VISIBLE CAST|REFERENCE MAPPING:|$)/i)?.[1]?.trim();
    const storyDetails = preserve ? ` Keep these current story details: ${preserve}.` : '';
    const multiple = refs.length > 1;
    const source = multiple ? '<image1>' : 'the supplied image';
    const mapping = refs.map((ref, index) => {
        const tag = multiple ? `<image${index + 1}>` : 'The supplied image';
        return `${tag} supplies ${referenceRole(ref, index)} for ${ref.identityName || 'the visible character'}.`;
    }).join(' ');
    const names = [...new Set(refs.filter(ref => (ref.role || ref.kind) !== 'continuity').map(ref => ref.identityName).filter(Boolean))];
    const sheetRule = refs.some(ref => /three_views|三视|turnaround/i.test(ref.viewType || ref.type || ''))
        ? 'Supporting sheets show additional views of the same person; transfer only relevant design details into the requested scene. ' : '';
    const reflection = reflectionRulesForStory(story+' '+storyDetails);
    if (requestsReflection(story+' '+storyDetails)) {
        return mirrorStoryPrompt({ story, framing: framingPreference(), reflection, preserve,
            source, mapping, art: requestsArtisticBodyAnatomy(story) ? ` ${ARTISTIC_ANATOMY_RULE}` : '' });
    }
    return `Create a new story illustration with the requested framing and action: ${story}${storyDetails} ${postureRulesForStory(story)} ${framingPreference()} ${VIEWPOINT_STRUCTURE_RULES} ${reflection} All supplied images are character references, not the poses, composition or background to preserve. ${mapping} Preserve each person's exact face, hairstyle and distinctive accessories only where visible from the requested view; an unseen face remains unseen. Match the rendering medium, artwork style, linework and color treatment of ${source} throughout the new scene. ${BODY_STRUCTURE_RULES} ${sheetRule}Show each visible person once as a physical figure${names.length ? ` (${names.join(', ')})` : ''}. Keep the reference clothing unless the story explicitly changes it; depict the specified actions and exposure faithfully.`.replace(/\s+/g, ' ').trim();
}
