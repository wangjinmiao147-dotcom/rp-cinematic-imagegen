import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as utils from '../src/utils.js';
import { generateImage } from '../src/backends.js';
import { buildCharacterSheetPrompt } from '../src/prompts.js';
import { getCharacterIdentifier, persistMediaUrl } from '../src/gallery.js';
import { snapshotGenerationSettings } from '../src/task-context.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function between(start, end) {
    const first = source.indexOf(start); const last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `Production function markers must exist: ${start}`);
    return source.slice(first, last);
}
const production = between('async function getCharacterAvatarInfo(', 'async function resolveCharacterReferences(')
    + '\n' + between('async function renderCharacterSheetFlow(', 'const rpigRendering =');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=';
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function fixture(t) {
    const character = { name: 'Test character', avatar: 'test-character.png', description: 'An adult character in a blue coat.' };
    const context = { chatId: 'chat-one', chat: [] };
    const settings = { backend: 'openai', backendUrl: 'https://image.test/v1', backendModel: 'gpt-image-1', stylePreset: 'reference', imageSize: '16:9' };
    const state = { current: true, avatarCalls: [], imageCalls: [], saves: [], gallery: [], refs: [], statuses: [] };
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
        if (String(url).includes('/characters/') || String(url).startsWith('characters/') || String(url).includes('/thumbnail?')) {
            state.avatarCalls.push({ url, options });
            if (state.readAvatar) return state.readAvatar(options);
            state.onAvatar?.();
            return new Response(Buffer.from(png.split(',')[1], 'base64'), { headers: { 'Content-Type': 'image/png' } });
        }
        state.imageCalls.push({ url, options });
        return json({ data: [{ b64_json: png.split(',')[1] }] });
    });
    const deps = { ...utils, generateImage, buildCharacterSheetPrompt, getCharacterIdentifier, persistMediaUrl, snapshotGenerationSettings,
        getContext: () => context, getSettings: () => settings, getCurrentCharacter: () => character,
        setGenStatus: (phase, text) => state.statuses.push({ phase, text }), toastr: { warning() {} }, SlashCommandParser: {}, MAX_REFS_PER_CHAR: 50,
        saveBase64AsFile: async (body, folder, filename, extension) => {
            state.saves.push({ body, folder, filename, extension }); return '/saved-character-sheet.png';
        },
        updateCharacterRefs: async (_character, modify) => { state.refs = await modify(state.refs); return state.refs; },
        saveToGallery: async (_character, entry) => { state.gallery.push(entry); },
    };
    const render = new Function(...Object.keys(deps), production + '; return renderCharacterSheetFlow;')(...Object.values(deps));
    return { state, character, settings, context, run: (options = {}, runtime = {}) => render(options, { isSourceValid: () => state.current, ...runtime }) };
}

for (const type of ['three_views', 'full_body']) {
    test(`${type} works with the default reference style and archives the actual image result`, async t => {
        const f = fixture(t);
        const result = await f.run({ type });
        assert.equal(f.state.imageCalls.length, 1);
        assert.equal(f.state.imageCalls[0].url, 'https://image.test/v1/images/edits');
        const form = f.state.imageCalls[0].options.body;
        assert.equal(Buffer.from(await form.get('image').arrayBuffer()).toString('base64'), png.split(',')[1]);
        assert.match(form.get('prompt'), /Test character/);
        assert.equal(result.isPersisted, true);
        assert.equal(result.addedToRefs, true);
        assert.equal(result.imageUrl, '/saved-character-sheet.png');
        assert.equal(f.state.saves[0].body, png.split(',')[1]);
        assert.equal(f.state.refs.length, 1);
        assert.equal(f.state.refs[0].url, result.persistedUrl);
        assert.equal(f.state.gallery.length, 1);
        assert.equal(f.state.gallery[0].url, result.persistedUrl);
        assert.equal(f.state.statuses.at(-1).phase, 'done');
    });
}

test('cancelling during the actual avatar download stops immediately without retrying avatars or requesting an image', async t => {
    const f = fixture(t); const controller = new AbortController();
    let downloading; const started = new Promise(resolve => { downloading = resolve; });
    f.state.readAvatar = options => new Promise((_resolve, reject) => {
        downloading();
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    const pending = f.run({}, { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await started; controller.abort(utils.createAbortError()); await rejected;
    assert.equal(f.state.avatarCalls.length, 1);
    assert.equal(f.state.imageCalls.length, 0);
    assert.equal(f.state.saves.length, 0);
    assert.equal(f.state.gallery.length, 0);
});

test('changing the source during avatar download prevents a paid request', async t => {
    const f = fixture(t);
    f.state.onAvatar = () => { f.state.current = false; };
    await assert.rejects(f.run(), { name: 'AbortError' });
    assert.equal(f.state.avatarCalls.length, 1);
    assert.equal(f.state.imageCalls.length, 0);
    assert.equal(f.state.refs.length, 0);
});

test('an already-stale character sheet cannot even read its avatar', async t => {
    const f = fixture(t); f.state.current = false;
    await assert.rejects(f.run(), { name: 'AbortError' });
    assert.equal(f.state.avatarCalls.length, 0);
    assert.equal(f.state.imageCalls.length, 0);
});

test('backend changes while the avatar loads apply to the next sheet only', async t => {
    const f = fixture(t);
    f.state.onAvatar = () => { f.settings.backendUrl = 'https://replacement.test/v1'; };
    await f.run();
    assert.equal(f.state.imageCalls[0].url, 'https://image.test/v1/images/edits');
    await f.run();
    assert.equal(f.state.imageCalls[1].url, 'https://replacement.test/v1/images/edits');
});
