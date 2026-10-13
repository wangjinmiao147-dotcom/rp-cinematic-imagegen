import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacterIdentityUI } from '../src/character-identity-ui.js';

function fixture(initial = { name: 'Adventure Card Title', avatar: 'a.png' }) {
    const elements = [];
    const $ = html => {
        if (html && typeof html === 'object') return html;
        const node = { html, children: [], handlers: {}, properties: {}, value: '', content: '', removed: false,
            append(...children) { this.children.push(...children); return this; },
            text(value) { if (!arguments.length) return this.content; this.content = value; return this; },
            val(value) { if (!arguments.length) return this.value; this.value = value; return this; },
            prop(key, value) { if (arguments.length === 1) return this.properties[key]; this.properties[key] = value; return this; },
            on(event, callback) { this.handlers[event] = callback; return this; },
            off() { this.handlers = {}; return this; },
            fire(event) { this.handlers[event]?.(); }, remove() { this.removed = true; },
        };
        elements.push(node);
        return node;
    };
    let selected = initial, settings = { characterIdentityOverrides: {} }, saves = 0;
    const ui = createCharacterIdentityUI({ $, getSettings: () => settings, getSelectedCharacter: () => selected,
        getCharacterIdentifier: character => character.avatar || character.name, saveSettings: () => { saves++; } });
    return { ui, elements, field: key => elements.find(node => node.html.includes(`data-rpig-identity="${key}"`)),
        get settings() { return settings; }, get saves() { return saves; },
        select(character) { selected = character; }, replaceSettings(value) { settings = value; } };
}

test('card titles are read-only context and never prefill a canonical name', () => {
    const f = fixture();
    assert.equal(f.field('card-title').text(), '卡片标题：Adventure Card Title');
    assert.equal(f.field('name').val(), '');
    assert.equal(f.field('aliases').val(), '');
    assert.equal(f.saves, 0);
    assert.deepEqual(f.settings.characterIdentityOverrides, {});
});

test('canonical names and deduplicated aliases bind to the stable avatar independently of the title', () => {
    const f = fixture();
    f.field('name').val('Alice');
    f.field('aliases').val('Alice, Ali, ALI，阿莉；A. Smith\nA. Smith');
    f.field('save').fire('click');
    assert.deepEqual(f.settings.characterIdentityOverrides['character:a.png'], { name: 'Alice', aliases: ['Ali', '阿莉', 'A. Smith'] });
    f.select({ name: 'An unrelated title', avatar: 'a.png' });
    f.ui.refresh();
    assert.equal(f.field('name').val(), 'Alice');
    assert.equal(f.field('card-title').text(), '卡片标题：An unrelated title');
    f.select({ name: 'An unrelated title', avatar: 'b.png' });
    f.ui.refresh();
    assert.equal(f.field('name').val(), '');
});

test('effective cards display their raw cardTitle and preserve the real-name override', () => {
    const f = fixture({ name: 'Alice', cardTitle: 'A bundle of adventures', avatar: 'a.png' });
    f.replaceSettings({ characterIdentityOverrides: { 'character:a.png': { name: 'Alice', aliases: ['Ali'] } } });
    f.ui.refresh();
    assert.equal(f.field('card-title').text(), '卡片标题：A bundle of adventures');
    assert.equal(f.field('name').val(), 'Alice');
    assert.equal(f.field('aliases').val(), 'Ali');
});

test('blank canonical names explicitly leave identity resolution to current story text', () => {
    const f = fixture();
    f.field('name').val('');
    f.field('save').fire('click');
    assert.deepEqual(f.settings.characterIdentityOverrides['character:a.png'], { name: '', aliases: [] });
    assert.match(f.field('status').text(), /AI 依据正文判断/);
});

test('saving a displayed draft cannot write a newly selected avatar before refresh', () => {
    const f = fixture();
    f.field('name').val('Alice');
    f.select({ name: 'Other title', avatar: 'b.png' });
    f.field('save').fire('click');
    assert.equal(f.settings.characterIdentityOverrides['character:a.png'].name, 'Alice');
    assert.equal(Object.hasOwn(f.settings.characterIdentityOverrides, 'character:b.png'), false);
});

test('saving uses the current settings object and preserves other roles changed in the meantime', () => {
    const f = fixture();
    f.replaceSettings({ characterIdentityOverrides: { 'character:b.png': { name: 'Bob', aliases: [] } } });
    f.field('name').val('Alice');
    f.field('save').fire('click');
    assert.equal(f.settings.characterIdentityOverrides['character:b.png'].name, 'Bob');
    assert.equal(f.settings.characterIdentityOverrides['character:a.png'].name, 'Alice');
});

test('User names and cards with no stable avatar remain outside canonical-role overrides', () => {
    const f = fixture('user');
    assert.match(f.field('card-title').text(), /酒馆当前用户名/);
    assert.equal(f.field('name').prop('disabled'), true);
    f.field('name').val('User override');
    f.field('save').fire('click');
    f.select({ name: 'Only a title' });
    f.ui.refresh();
    assert.equal(f.field('save').prop('disabled'), true);
    f.field('save').fire('click');
    assert.equal(f.saves, 0);
    assert.deepEqual(f.settings.characterIdentityOverrides, {});
});

test('identity data remains literal text and HTML-looking names never create markup', () => {
    const marker = '<img src=x onerror=alert(1)>';
    const f = fixture({ name: marker, avatar: 'a.png' });
    assert.equal(f.field('card-title').text(), `卡片标题：${marker}`);
    f.field('name').val(marker);
    f.field('aliases').val('<b>nickname</b>');
    f.field('save').fire('click');
    assert.equal(f.settings.characterIdentityOverrides['character:a.png'].name, marker);
    assert.equal(f.elements.some(node => node.html.includes(marker)), false);
});

test('oversized names, control characters and excessive aliases are not saved', () => {
    const f = fixture();
    for (const name of ['x'.repeat(101), 'Alice\u0000hidden', 'Alice\nAnother']) {
        f.field('name').val(name);
        f.field('save').fire('click');
        assert.equal(f.saves, 0);
    }
    f.field('name').val('Alice');
    f.field('aliases').val(Array.from({ length: 21 }, (_, index) => `Alias ${index}`).join(','));
    f.field('save').fire('click');
    assert.equal(f.saves, 0);
    assert.match(f.field('status').text(), /最多保存 20/);
    f.field('aliases').val('x'.repeat(101));
    f.field('save').fire('click');
    assert.equal(f.saves, 0);
});

test('destroy removes handlers and prevents stale controls from writing identity overrides', () => {
    const f = fixture();
    f.ui.destroy();
    f.ui.destroy();
    f.field('name').val('Stale name');
    f.field('save').fire('click');
    f.ui.refresh();
    assert.equal(f.saves, 0);
    assert.equal(f.ui.element.removed, true);
});
