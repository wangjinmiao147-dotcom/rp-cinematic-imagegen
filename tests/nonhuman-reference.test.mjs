import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleUnifiedPrompt } from '../src/prompts.js';
import { qwenReferenceEditPrompt } from '../src/qwen.js';

const reference = { role: 'identity-primary', identityId: 'adult-character', identityName: 'Qingli' };

// Exercise the production unified-template reduction. These tests verify the
// actual sent constraints; model adherence is checked separately with images.
function sent(editInstruction, preserve = '', refs = [reference]) {
    return qwenReferenceEditPrompt(assembleUnifiedPrompt({ editInstruction, preserve }), refs);
}

test('a confirmed serpent lower body keeps its tail facts without an unconditional human leg chain', () => {
    const instruction = 'Show adult Qingli in her current serpentine form, with one scaled tail instead of human legs and her reference slit pupils.';
    const prompt = sent(instruction);
    assert.ok(prompt.includes(instruction));
    assert.match(prompt, /Only in currently human-shaped regions, build[^.]*existing shoulder-elbow-wrist-hand and hip-knee-ankle-foot/);
    assert.match(prompt, /do not impose human legs or feet on a nonhuman lower body/);
    assert.match(prompt, /Preserve reference-supported nonhuman features and limb layout only where compatible with the current form/);
    assert.doesNotMatch(prompt, /Build naturally connected torso and shoulder-elbow-wrist-hand and hip-knee-ankle-foot/);
    assert.match(prompt, /retain each primary face, eye design and color/);
});

test('an explicit current human transformation takes priority over an outdated serpentine reference', () => {
    const instruction = 'Show adult Qingli after her completed transformation into a human form with two arms and two legs; she has no tail in this moment.';
    const prompt = sent(instruction, 'The current human form and wine-red robe.',
        [{ ...reference, label: 'Earlier serpentine full-body design' }]);
    assert.ok(prompt.includes(instruction));
    assert.match(prompt, /A confirmed human form has two arms and two legs unless its explicit design says otherwise/);
    assert.match(prompt, /Explicit current transformations override outdated reference anatomy/);
    assert.match(prompt, /nonhuman features and limb layout only where compatible with the current form/);
    assert.match(prompt, /Preserve: The current human form and wine-red robe/);
    assert.doesNotMatch(prompt, /keep (?:the |her )?(?:reference |original )?tail regardless/i);
});

test('a species name and a head portrait cannot invent a lower-body design', () => {
    const prompt = sent('Show the adult character seated at the table in her current robe.', '',
        [{ ...reference, identityName: 'Qingli the thousand-year-old snake spirit', label: 'Head-and-shoulders portrait' }]);
    assert.match(prompt, /A species name alone does not establish visible anatomy/);
    assert.match(prompt, /a head-and-shoulders portrait does not establish hidden lower-body structure/);
    assert.match(prompt, /Complete only the established form naturally/);
    assert.doesNotMatch(prompt, /\btail\b|\bscales\b|slit pupils/i);
});

test('confirmed wings remain distinctive body design without becoming extra actors or forced human limbs', () => {
    const instruction = 'Show the adult winged figure turning at the doorway; retain her one reference-supported pair of feathered wings and existing arm pose.';
    const prompt = sent(instruction, 'Her current white robe and the established feather colors.');
    assert.ok(prompt.includes(instruction));
    assert.match(prompt, /compatible reference body design and distinctive anatomy/);
    assert.match(prompt, /Preserve reference-supported nonhuman features and limb layout/);
    assert.match(prompt, /Each person appears once/);
    assert.match(prompt, /Only ordinary human hands[^.]*ordinary human feet five toes/);
    assert.match(prompt, /preserve established nonhuman digits/);
    assert.doesNotMatch(prompt, /remove (?:the |her )?wings|convert[^.]*wings[^.]*arms/i);
});

test('art anatomy applies only to confirmed human-shaped regions of a mixed body', () => {
    const prompt = sent('Show the adult serpent figure unclothed in a nonsexual artistic figure study, with a human-shaped torso and a scaled lower body.');
    assert.match(prompt, /visible bare adult body, draw normal anatomical landmarks only on surfaces actually visible from the requested camera and in currently confirmed human-shaped regions/);
    assert.match(prompt, /proportionate nipples centered in their areolae/);
    assert.match(prompt, /external pelvic anatomy coherent only where that region is human-shaped/);
    assert.match(prompt, /Only when the corresponding anterior chest surface is visible/);
    assert.match(prompt, /Retain the requested pose and its existing occlusion/);
    assert.match(prompt, /do not impose human legs or feet on a nonhuman lower body/);
});

test('ordinary human actions, facial identity, style and current clothing retain existing behavior', () => {
    const instruction = 'Show the adult human figure lifting one hand to knock on the door, wearing the newly changed burgundy coat.';
    const prompt = sent(instruction, 'The current burgundy coat and absence of the former crown.');
    assert.ok(prompt.includes(instruction));
    assert.match(prompt, /shoulder-elbow-wrist-hand/);
    assert.match(prompt, /hip-knee-ankle-foot/);
    assert.match(prompt, /two arms and two legs/);
    assert.match(prompt, /one thumb and four fingers/);
    assert.match(prompt, /ordinary human feet five toes/);
    assert.match(prompt, /Current wardrobe, hair, accessories(?:, props, poses and setting| and props) override outdated references/);
    assert.match(prompt, /medium, linework, shading and palette/);
    assert.match(prompt, /eye design and color and hairline/);
    assert.doesNotMatch(prompt, /nipples|external pelvic anatomy/);
});

test('a closed-mouth human transformation retains confirmed pupils without displaying a tongue or hidden species traits', () => {
    const instruction = 'Show adult Qingli in her current human form with the confirmed vertical slit pupils, lips closed and no visible tongue, tail or scales.';
    const prompt = sent(instruction);
    assert.ok(prompt.includes(instruction));
    assert.match(prompt, /Explicit current transformations override outdated reference anatomy/);
    assert.match(prompt, /Never alter mouth state, pose or occlusion just to display a species trait/);
    assert.match(prompt, /keep a closed mouth closed with no protruding tongue/);
    assert.match(prompt, /leave hidden traits hidden/);
    assert.match(prompt, /retain each primary face, eye design and color/);
});

test('confirmed animal ears and tail coexist with a human body without forcing hidden traits into view', () => {
    const instruction = 'Show the adult human-bodied character with her confirmed animal ears and one tail, her mouth closed; the tail tip remains behind the chair.';
    const prompt = sent(instruction, 'The confirmed ear design, tail design and current white dress.');
    assert.ok(prompt.includes(instruction));
    assert.match(prompt, /Preserve: The confirmed ear design, tail design and current white dress/);
    assert.match(prompt, /Preserve reference-supported nonhuman features and limb layout only where compatible with the current form/);
    assert.match(prompt, /A confirmed human form has two arms and two legs unless its explicit design says otherwise/);
    assert.match(prompt, /leave hidden traits hidden/);
    assert.match(prompt, /respecting occlusion and crop/);
    assert.match(prompt, /keep a closed mouth closed with no protruding tongue/);
});
