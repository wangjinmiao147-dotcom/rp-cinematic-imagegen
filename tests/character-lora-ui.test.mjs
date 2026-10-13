import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacterLoraUI } from '../src/character-lora-ui.js';

function fixture(t, initial = { name: 'Same', avatar: 'a.png' }) {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const document = {};
    Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
    t.after(() => originalDocument ? Object.defineProperty(globalThis, 'document', originalDocument) : delete globalThis.document);
    const elements = [];
    function node(html) {
        const value = { html, children: [], properties: {}, handlers: new Map(), textValue: '', fieldValue: '', removed: false,
            append(...children) { this.children.push(...children); return this; },
            empty() { this.children = []; return this; },
            text(text) { if (!arguments.length) return this.textValue; this.textValue = text; return this; },
            val(next) { if (!arguments.length) return this.fieldValue; this.fieldValue = next; return this; },
            prop(key, next) { if (arguments.length === 1) return this.properties[key]; this.properties[key] = next; return this; },
            on(event, callback) { this.handlers.set(event, [...(this.handlers.get(event) || []), callback]); return this; },
            off(event, callback) {
                if (!arguments.length) this.handlers.clear();
                else this.handlers.set(event, (this.handlers.get(event) || []).filter(handler => handler !== callback));
                return this;
            },
            fire(event, detail = {}) { for (const callback of this.handlers.get(event) || []) callback({ detail }); },
            remove() { this.removed = true; },
        };
        elements.push(value);
        return value;
    }
    const eventTarget = node('document');
    const $ = value => value === document ? eventTarget : value && typeof value === 'object' ? value : node(value);
    let selected = initial;
    let settings = { backendUrl: 'http://comfy.test:8188', characterLoras: {} };
    let saves = 0;
    const ui = createCharacterLoraUI({ $, getSettings: () => settings, getSelectedCharacter: () => selected,
        getCharacterIdentifier: character => character.avatar || character.name,
        saveSettings: () => { saves++; } });
    const field = key => elements.find(element => typeof element.html === 'string' && element.html.includes(`data-rpig-lora="${key}"`));
    return { ui, field, elements, eventTarget, get settings() { return settings; }, get saves() { return saves; },
        select(value) { selected = value; }, replaceSettings(value) { settings = value; } };
}

test('new bindings display disabled defaults without writing settings or requiring a model list', t => {
    const f = fixture(t);
    assert.equal(f.field('enabled').prop('checked'), false);
    assert.equal(f.field('name').val(), '');
    assert.equal(f.field('strengthModel').val(), 0.8);
    assert.equal(f.field('strengthClip').val(), 0.8);
    assert.equal(f.field('family').val(), 'sd');
    assert.equal(f.field('name').prop('disabled'), false);
    assert.equal(f.field('models').prop('disabled'), true);
    assert.equal(f.saves, 0);
    assert.deepEqual(f.settings.characterLoras, {});
});

test('same-name cards keep separate bindings and switching refreshes every input', t => {
    const f = fixture(t);
    f.field('name').val('a.safetensors');
    f.field('enabled').prop('checked', true);
    f.field('triggerWords').val('actor_a');
    f.field('save').fire('click');
    f.select({ name: 'Same', avatar: 'b.png' });
    f.ui.refresh();
    assert.equal(f.field('name').val(), '');
    assert.equal(f.field('enabled').prop('checked'), false);
    assert.equal(f.field('triggerWords').val(), '');
    f.field('name').val('b.safetensors');
    f.field('save').fire('click');
    assert.equal(f.settings.characterLoras['character:a.png'].name, 'a.safetensors');
    assert.equal(f.settings.characterLoras['character:b.png'].name, 'b.safetensors');
    f.select({ name: 'Renamed', avatar: 'a.png' });
    f.ui.refresh();
    assert.equal(f.field('name').val(), 'a.safetensors');
    assert.equal(f.field('triggerWords').val(), 'actor_a');
});

test('a role switch before refresh cannot save the displayed draft into the newly selected card', t => {
    const f = fixture(t);
    f.field('name').val('draft-for-a.safetensors');
    f.select({ name: 'Other', avatar: 'b.png' });
    f.field('save').fire('click');
    assert.equal(f.settings.characterLoras['character:a.png'].name, 'draft-for-a.safetensors');
    assert.equal(Object.hasOwn(f.settings.characterLoras, 'character:b.png'), false);
});

test('saving uses current settings and preserves bindings added since controls were opened', t => {
    const f = fixture(t);
    f.replaceSettings({ backendUrl: 'http://comfy.test:8188', characterLoras: { 'character:b.png': { enabled: false, name: 'new-b.safetensors' } } });
    f.field('name').val('a.safetensors');
    f.field('save').fire('click');
    assert.equal(f.settings.characterLoras['character:b.png'].name, 'new-b.safetensors');
    assert.equal(f.settings.characterLoras['character:a.png'].name, 'a.safetensors');
});

test('User bindings are explicit and characters lacking a stable avatar cannot write a name binding', t => {
    const f = fixture(t, 'user');
    assert.equal(f.field('target').text(), '当前绑定：User');
    f.field('name').val('user.safetensors');
    f.field('save').fire('click');
    assert.equal(f.settings.characterLoras.user.name, 'user.safetensors');
    f.select({ name: 'Only a display name' });
    f.ui.refresh();
    assert.equal(f.field('save').prop('disabled'), true);
    assert.equal(f.field('enabled').prop('disabled'), true);
    f.field('save').fire('click');
    assert.equal(f.saves, 1);
    assert.equal(Object.hasOwn(f.settings.characterLoras, 'character:Only a display name'), false);
});

test('invalid enabled configuration and blank strength inputs show validation without saving', t => {
    const f = fixture(t);
    f.field('enabled').prop('checked', true);
    f.field('save').fire('click');
    assert.match(f.field('status').text(), /未填写模型文件名/);
    assert.equal(f.saves, 0);
    f.field('name').val('a.safetensors');
    f.field('strengthModel').val('');
    f.field('save').fire('click');
    assert.match(f.field('status').text(), /强度/);
    assert.equal(f.saves, 0);
    f.field('strengthModel').val('0');
    f.field('save').fire('click');
    assert.equal(f.settings.characterLoras['character:a.png'].strengthModel, 0);
});

test('server lists are scoped to the matching URL and can select a relative model filename', t => {
    const f = fixture(t);
    f.eventTarget.fire('rpig:comfy-models', { url: 'http://comfy.test:8188/', models: { loras: ['people/a.safetensors', 'people/a.safetensors'] } });
    assert.equal(f.field('models').prop('disabled'), false);
    assert.equal(f.field('models').children.length, 2);
    f.field('models').val('people/a.safetensors');
    f.field('models').fire('change');
    assert.equal(f.settings.characterLoras['character:a.png'].name, 'people/a.safetensors');
    f.settings.backendUrl = 'http://other-comfy.test:8188';
    f.ui.refresh();
    assert.equal(f.field('models').prop('disabled'), true);
    assert.equal(f.field('models').children.length, 1);
    f.ui.setModels({ url: 'http://comfy.test:8188', loras: ['stale.safetensors'] });
    assert.equal(f.field('models').prop('disabled'), true);
});

test('matching a model-list event strips credentials and query parameters from both service URLs', t => {
    const f = fixture(t);
    f.settings.backendUrl = 'http://user:password@comfy.test:8188/?token=private-value';
    f.ui.setModels({ url: 'http://comfy.test:8188', loras: ['a.safetensors'] });
    assert.equal(f.field('models').prop('disabled'), false);
    assert.equal(f.elements.some(element => typeof element.textValue === 'string' && element.textValue.includes('password')), false);
});

test('role names, trigger words and returned model labels remain text, never dynamic HTML', t => {
    const injection = '<img src=x onerror=alert(1)>';
    const f = fixture(t, { name: injection, avatar: 'a.png' });
    assert.equal(f.field('target').text(), `当前绑定：${injection}`);
    f.field('name').val('a.safetensors');
    f.field('triggerWords').val(injection);
    f.field('save').fire('click');
    assert.equal(f.settings.characterLoras['character:a.png'].triggerWords, injection);
    f.ui.setModels({ url: 'http://comfy.test:8188', loras: [injection] });
    assert.equal(f.field('models').children[1].text(), injection);
    assert.equal(f.elements.some(element => typeof element.html === 'string' && element.html.includes(injection)), false);
});

test('destroy removes subscriptions and stops stale controls from saving or accepting new model lists', t => {
    const f = fixture(t);
    f.ui.destroy();
    f.ui.destroy();
    f.field('name').val('stale.safetensors');
    f.field('save').fire('click');
    f.eventTarget.fire('rpig:comfy-models', { url: 'http://comfy.test:8188', models: { loras: ['stale.safetensors'] } });
    f.ui.setModels({ url: 'http://comfy.test:8188', loras: ['stale.safetensors'] });
    f.ui.refresh();
    assert.equal(f.saves, 0);
    assert.equal(f.ui.element.removed, true);
    assert.equal(f.eventTarget.handlers.get('rpig:comfy-models').length, 0);
});
