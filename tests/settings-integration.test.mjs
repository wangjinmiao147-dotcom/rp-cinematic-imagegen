import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const jqueryFile = process.env.RPIG_JQUERY_PATH;
const require = createRequire(import.meta.url);
async function exists(path) { try { await access(path); return true; } catch { return false; } }
function between(source, start, end) {
    const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `Production source boundary missing: ${start}`);
    return source.slice(from, to);
}

async function playwrightRuntime() {
    try { return require('playwright'); } catch { /* Optional browser test dependency. */ }
    const packagePath = process.env.RPIG_PLAYWRIGHT_PATH || join(homedir(), '.cache', 'codex-runtimes',
        'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright');
    try { return require(packagePath); } catch { return null; }
}

function fixtureModule(source) {
    // Full production settings function and production model-control helper.
    // Only the SillyTavern host boundary and empty synthetic reference storage
    // are adapted; Comfy/identity/LoRA helpers and native jQuery run unchanged.
    return [
        `import {BACKENDS,getLocalRenderParameters} from '/src/backends.js';
        import {DEFAULT_SD_NEGATIVE,getCharacterVisualAnchor} from '/src/prompts.js';
        import {isLocalQwen,qwenSteps,activeReferenceViews} from '/src/qwen.js';
        import {escapeHtml,scrubSensitiveText,createAbortError} from '/src/utils.js';
        import {getCharacterIdentifier,MAX_UPLOAD_FILE_SIZE,MAX_BATCH_UPLOAD,MAX_REFS_PER_CHAR} from '/src/gallery.js';
        import {createComfySetupUI as realComfy} from '/src/comfy-setup-ui.js';
        import {createCharacterIdentityUI as realIdentity} from '/src/character-identity-ui.js';
        import {createCharacterLoraUI as realLora} from '/src/character-lora-ui.js';
        import {createCardCastUI} from '/src/card-cast-ui.js';
        import {createLocalPixelsUI} from '/src/local-pixels-ui.js';
        import {modifyReferenceViews} from '/src/reference-state.js';
        const $=window.jQuery;
        const state={saves:0,reads:[],toasts:[],references:{'alpha.png':[{label:'Alpha reference',refId:'alpha-ref',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII='}]},helpers:{comfy:{created:0,destroyed:0},identity:{created:0,destroyed:0},lora:{created:0,destroyed:0}}};
        const track=(factory,key)=>options=>{const handle=factory(options);state.helpers[key].created++;
            const destroy=handle.destroy;let done=false;handle.destroy=()=>{if(!done){done=true;state.helpers[key].destroyed++;}destroy();};return handle;};
        const createComfySetupUI=track(realComfy,'comfy');
        const createCharacterIdentityUI=track(realIdentity,'identity');
        const createCharacterLoraUI=track(realLora,'lora');
        const rpigAnnotationControllers=new Set();
        const toastr=Object.fromEntries(['success','info','warning','error'].map(type=>[type,(message)=>state.toasts.push({type,message})]));`,
        between(source, 'const defaultSettings = {', 'function getSettings()'),
        `const cards=[{name:'Alpha card',avatar:'alpha.png',description:'Synthetic first card'},
            {name:'Beta card',avatar:'beta.png',description:'Synthetic second card'}];
        const settings={...structuredClone(defaultSettings),backend:'comfyui',backendUrl:location.origin+'/comfy-one',
            characterIdentityOverrides:{'character:alpha.png':{name:'Alice',aliases:['A']},'character:beta.png':{name:'Bob',aliases:['B']}},
            characterLoras:{'character:alpha.png':{enabled:false,name:'alpha.safetensors',strengthModel:.8,strengthClip:.7,triggerWords:'alpha',family:'sd'},
                'character:beta.png':{enabled:false,name:'beta.safetensors',strengthModel:.6,strengthClip:.5,triggerWords:'beta',family:'sd'},
                user:{enabled:false,name:'user.safetensors',strengthModel:.4,strengthClip:.3,triggerWords:'user',family:'sd'}}};
        function getSettings(){return settings;}
        function saveSettingsDebounced(){state.saves++;}
        function getCurrentCharacter(){return cards.find(card=>card.avatar===settings.selectedTargetCharacter)||cards[0];}
        function getAllCharacters(){return cards.map((raw,index)=>({name:raw.name,avatar:raw.avatar,index,raw}));}
        function getContext(){return {name1:'Synthetic Player',chat:[],characters:cards};}
        async function getCharacterAvatarDataUrl(){return null;}
        async function getCharacterRefs(character){state.reads.push(getCharacterIdentifier(character));return state.references[getCharacterIdentifier(character)]||[];}
        async function updateCharacterRefs(character,update){const key=getCharacterIdentifier(character);return state.references[key]=update(state.references[key]||[]);}
        function resetAutoDetectState(){}
        function exportErrorReport(){}
        function fetchImageModelsFromUpstream(){throw new Error('Not part of this read-only settings test');}
        function fetchLlmModelsFromUpstream(){throw new Error('Not part of this read-only settings test');}`,
        between(source, 'function createUpstreamModelControl(', 'let rpigSettingsAuxCleanup'),
        between(source, 'let rpigSettingsAuxCleanup', 'function buildFloatingUI()'),
        `window.fixture={state,settings,cards,
            mount(){const panel=buildSettingsUI();$('#rpig_container').empty().append(panel);},
            destroy(){rpigSettingsAuxCleanup();$('#rpig_container').empty();},
            ready:false,error:null};
        try{window.fixture.mount();window.fixture.ready=true;}catch(error){window.fixture.error=error.stack;throw error;}`,
    ].join('\n');
}

test('full settings mount and helper lifecycle work in a real browser with host jQuery', {
    skip: !jqueryFile && 'Set RPIG_JQUERY_PATH to an installed SillyTavern jQuery file for the optional browser smoke test',
    timeout: 60000,
}, async t => {
    const runtime = await playwrightRuntime();
    if (!runtime) { t.skip('Optional Playwright runtime is unavailable; no browser dependency was installed'); return; }
    const executable = process.env.RPIG_BROWSER_EXECUTABLE || (process.platform === 'win32'
        ? join(process.env['PROGRAMFILES(X86)'] || process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '');
    if (executable && !await exists(executable)) { t.skip('Optional system browser executable is unavailable'); return; }
    const [source, jquery, stylesheet] = await Promise.all([
        readFile(join(root, 'index.js'), 'utf8'), readFile(jqueryFile, 'utf8'), readFile(join(root, 'style.css'), 'utf8'),
    ]);
    const moduleSource = fixtureModule(source), requests = [], externalRequests = [], pageErrors = [];
    const server = createServer(async (request, response) => {
        const path = new URL(request.url, 'http://localhost').pathname;
        requests.push({ path, method: request.method });
        if (path === '/') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end('<!doctype html><meta charset="utf-8"><title>Settings integration fixture</title><link rel="stylesheet" href="/style.css"><style>body{margin:0;padding:16px;background:#10131e;color:#eee;font:14px Arial,sans-serif}#rpig_container{max-width:1100px;margin:auto}</style><div id="rpig_container"></div><script src="/jquery.js"></script><script type="module" src="/fixture.js"></script>');
        } else if (path === '/jquery.js' || path === '/fixture.js' || path === '/style.css') {
            response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
            response.end(path === '/jquery.js' ? jquery : path === '/fixture.js' ? moduleSource : stylesheet);
        } else if (/^\/comfy-(?:one|two)\/object_info$/.test(path)) {
            assert.equal(request.method, 'GET', 'The fixture server must never receive a model submission');
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({
                CheckpointLoaderSimple: { input: { required: { ckpt_name: [['checkpoint.safetensors']] } } },
                LoraLoader: { input: { required: { lora_name: [path.includes('two') ? ['new-server.safetensors'] : ['alpha.safetensors', 'beta.safetensors', 'user.safetensors']] } } },
            }));
        } else if (path.startsWith('/src/') && path.endsWith('.js')) {
            const file = resolve(root, `.${path}`);
            if (!file.startsWith(root + sep)) { response.writeHead(400).end(); return; }
            try { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(file, 'utf8')); }
            catch { response.writeHead(404).end(); }
        } else response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await runtime.chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', route => {
        if (new URL(route.request().url()).origin !== origin) {
            externalRequests.push(route.request().url()); return route.abort();
        }
        return route.continue();
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.fixture?.ready || window.fixture?.error);
    assert.equal(await page.evaluate(() => window.fixture.error), null);
    await page.waitForFunction(() => document.querySelector('#rpig-char-selector')?.options.length === 3);
    assert.deepEqual(await page.evaluate(() => window.fixture.state.helpers), {
        comfy: { created: 1, destroyed: 0 }, identity: { created: 1, destroyed: 0 }, lora: { created: 2, destroyed: 0 },
    });
    assert.equal(await page.locator('.rpig-character-lora').count(), 2);
    assert.equal(await page.locator('[data-rpig-identity="name"]').inputValue(), 'Alice');
    assert.equal(await page.locator('.rpig-character-lora').first().locator('[data-rpig-lora="name"]').inputValue(), 'alpha.safetensors');
    assert.equal(await page.locator('#rpig-user-refs-box [data-rpig-lora="name"]').inputValue(), 'user.safetensors');
    assert.equal(await page.locator('#rpig-comfy-preset').inputValue(), 'custom');

    await page.locator('.rpig-ref-primary-btn').click();
    await page.waitForFunction(() => window.fixture.state.references['alpha.png'][0]?.isPrimaryIdentity === true);
    assert.equal(await page.evaluate(() => window.fixture.state.references['alpha.png'].length), 1, 'Primary button must never trigger delete');
    assert.equal(await page.locator('.rpig-ref-primary-btn').textContent(), '★');
    const hit = await page.locator('.rpig-ref-primary-btn').evaluate(button => {const r=button.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.className;});
    assert.match(hit, /rpig-ref-primary-btn/);
    await page.selectOption('#rpig-char-selector', 'beta.png');
    assert.equal(await page.locator('[data-rpig-identity="name"]').inputValue(), 'Bob');
    assert.equal(await page.locator('.rpig-character-lora').first().locator('[data-rpig-lora="name"]').inputValue(), 'beta.safetensors');
    await page.locator('[data-rpig-identity="name"]').fill('Renamed Bob');
    await page.locator('[data-rpig-identity="save"]').click();
    assert.equal(await page.evaluate(() => window.fixture.settings.characterIdentityOverrides['character:beta.png'].name), 'Renamed Bob');
    assert.equal(await page.locator('#rpig-char-selector').inputValue(), 'beta.png');
    assert.equal(await page.locator('#rpig-user-refs-box [data-rpig-lora="name"]').inputValue(), 'user.safetensors');

    await page.locator('#rpig-comfy-check').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-rpig-lora="models"]')].every(select => select.options.length === 4));
    assert.equal(await page.locator('.rpig-character-lora').first().locator('[data-rpig-lora="models"]').isDisabled(), false);
    await page.evaluate(url => {
        const input = [...document.querySelectorAll('input')].find(element => element.placeholder.startsWith('接口地址，如'));
        window.jQuery(input).val(url).trigger('input');
    }, origin + '/comfy-two');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-rpig-lora="models"]')].map(select => ({ disabled: select.disabled, count: select.options.length }))),
        [{ disabled: true, count: 1 }, { disabled: true, count: 1 }]);
    await page.evaluate(url => document.dispatchEvent(new CustomEvent('rpig:comfy-models', { detail: { url, models: { loras: ['late-old-server.safetensors'] } } })), origin + '/comfy-one');
    assert.equal(await page.locator('.rpig-character-lora').first().locator('[data-rpig-lora="models"] option').count(), 1);
    await page.locator('#rpig-comfy-check').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-rpig-lora="models"]')].every(select => select.options.length === 2));
    await page.selectOption('#rpig-comfy-preset', 'sd-text');
    assert.equal(await page.locator('#rpig-comfy-sampling-profile').isVisible(), true);
    await page.selectOption('#rpig-comfy-sampling-profile', 'lcm');
    assert.equal(await page.locator('#rpig-comfySteps').getAttribute('placeholder'), '8');
    assert.equal(await page.locator('#rpig-comfyCfg').getAttribute('placeholder'), '2');
    assert.equal(await page.evaluate(() => window.fixture.settings.stylePreset), 'reference');
    assert.equal(await page.evaluate(() => window.fixture.settings.comfySteps), '');
    assert.equal(await page.evaluate(() => window.fixture.settings.comfyCfg), '');
    if (process.env.RPIG_SETTINGS_SCREENSHOTS_DIR) {
        await mkdir(process.env.RPIG_SETTINGS_SCREENSHOTS_DIR, { recursive: true });
        await page.evaluate(() => { document.querySelector('.rpig-comfy-parameters').open = true; });
        await page.screenshot({ path: join(process.env.RPIG_SETTINGS_SCREENSHOTS_DIR, 'settings-lcm-desktop.png'), fullPage: true });
    }
    await page.selectOption('#rpig-comfy-preset', 'qwen-edit');
    assert.equal(await page.locator('#rpig-comfy-qwen-notice').isVisible(), true);
    assert.equal(await page.locator('#rpig-comfy-preset').inputValue(), 'qwen-edit');
    assert.equal(await page.locator('#rpig-comfy-sampling-profile').isVisible(), false);
    assert.equal(await page.locator('#rpig-comfySteps').getAttribute('placeholder'), '20');
    assert.equal(await page.locator('#rpig-comfyCfg').getAttribute('placeholder'), '4');

    await page.locator('#rpig_container').evaluate(element => {element.style.width='340px';element.style.maxWidth='100%';});
    assert.equal(await page.locator('.rpig-settings-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(/\s+/).length),1,
        'A narrow Tavern drawer must use one column even on desktop');
    assert.equal(await page.locator('#rpig_container').evaluate(element => element.scrollWidth<=element.clientWidth+1),true);
    await page.locator('#rpig_container').evaluate(element => {element.style.width='';element.style.maxWidth='';});
    const screenshots = process.env.RPIG_SETTINGS_SCREENSHOTS_DIR;
    if (screenshots) {
        await mkdir(screenshots, { recursive: true });
        await page.screenshot({ path: join(screenshots, 'settings-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: join(screenshots, 'settings-mobile.png'), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Mobile settings must not overflow horizontally');
    }
    await page.evaluate(() => window.fixture.mount());
    await page.waitForFunction(() => document.querySelector('#rpig-char-selector')?.options.length === 3);
    assert.deepEqual(await page.evaluate(() => window.fixture.state.helpers), {
        comfy: { created: 2, destroyed: 1 }, identity: { created: 2, destroyed: 1 }, lora: { created: 4, destroyed: 2 },
    });
    assert.equal(await page.evaluate(() => (window.jQuery._data(document, 'events')?.['rpig:comfy-models'] || []).length), 2);
    assert.equal(await page.locator('[data-rpig-identity="name"]').inputValue(), 'Renamed Bob');
    await page.evaluate(() => window.fixture.destroy());
    assert.deepEqual(await page.evaluate(() => window.fixture.state.helpers), {
        comfy: { created: 2, destroyed: 2 }, identity: { created: 2, destroyed: 2 }, lora: { created: 4, destroyed: 4 },
    });
    assert.equal(await page.evaluate(() => (window.jQuery._data(document, 'events')?.['rpig:comfy-models'] || []).length), 0);
    assert.equal(await page.locator('.rpig-settings').count(), 0);
    const readsAfterDestroy = await page.evaluate(() => window.fixture.state.reads.length);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.fixture.state.reads.length), readsAfterDestroy, 'Destroyed settings timers must not restart host reads');
    await page.evaluate(() => {
        Object.assign(window.fixture.settings,{backend:'gemini',backendUrl:'http://127.0.0.1:8055',backendModel:'qwen-image-2.1',
            qwenResolution:'512x288',qwenSceneDetail:true,qwenSteps:24,localImageWidth:'',localImageHeight:''});
        window.fixture.mount();
    });
    assert.equal(await page.getByLabel('Qwen 步数',{exact:true}).isVisible(),true,'Steps are available without opening advanced parameters');
    await page.getByLabel('常用本地像素',{exact:true}).selectOption('512x288');
    assert.deepEqual(await page.evaluate(() => ({width:window.fixture.settings.localImageWidth,height:window.fixture.settings.localImageHeight,
        sceneDetail:window.fixture.settings.qwenSceneDetail,identityDetail:window.fixture.settings.qwenIdentityDetailBoost})),
        {width:'512',height:'288',sceneDetail:false,identityDetail:false});
    assert.match(await page.locator('.rpig-local-pixels').innerText(),/512×288 像素 · 24 步/);
    await page.getByLabel('本地绘制高度',{exact:true}).fill('323');
    assert.equal(await page.locator('.rpig-local-pixels').isVisible(),true,'Invalid pixels must not hide the fields needed to fix them');
    assert.match(await page.locator('.rpig-local-pixels').innerText(),/32倍数/);
    await page.getByLabel('本地绘制高度',{exact:true}).fill('320');
    await page.getByLabel('Qwen 步数',{exact:true}).fill('23');
    assert.match(await page.locator('.rpig-local-pixels').innerText(),/512×320 像素 · 23 步/);
    await page.getByLabel('本地千问参考图容量',{exact:true}).fill('4');
    assert.equal(await page.evaluate(() => window.fixture.settings.qwenReferenceLimit),4,'Typing the capacity updates the saved setting immediately');
    await page.getByRole('button',{name:'使用画幅 / 工作流默认像素',exact:true}).click();
    await page.locator('.rpig-settings select').filter({has:page.locator('option[value="2.39:1"]')}).selectOption('9:16');
    assert.match(await page.locator('.rpig-local-pixels').innerText(),/288×512 像素 · 23 步/,'Default pixels refresh immediately when the aspect ratio changes');
    await page.evaluate(() => window.fixture.destroy());
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(requests.filter(request => request.path.endsWith('/object_info')).map(request => request.method), ['GET', 'GET']);
});
