import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage, generateOpenAIImage, hydrateReferenceImages } from '../src/backends.js';
import { callLLM } from '../src/llm.js';
import { fetchToDataUrl, requestFailure, RpigError, timeoutSignal, combineAbortSignals } from '../src/utils.js';
import { persistMediaUrl } from '../src/gallery.js';
import { clampFloatingPoint, initializeFloatingUI, placeFloatingElement, viewportBounds } from '../src/floating-ui.js';
import { exportReferenceArchive, parseReferenceArchive } from '../src/reference-transfer.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=';
const settings = { backend: 'openai', backendUrl: 'https://api.test/v1', backendModel: 'image', backendKey: 'private-test-key' };
const response = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('floating initialization reports the original exception', () => {
    const failure = new TypeError('WebView API unavailable'); const errors = [];
    assert.equal(initializeFloatingUI(() => { throw failure; }, e => errors.push(e)), false);
    assert.equal(errors[0], failure);
});

test('zero-height transformed root no longer positions FAB at y=-126', () => {
    const style = { setProperty(k, v) { this[k] = v; } };
    const element = { style, offsetWidth: 44, offsetHeight: 44, getBoundingClientRect() {
        return { left: parseFloat(style.left) || 340, top: style.top ? parseFloat(style.top) : -126, width: 44, height: 44 };
    } };
    placeFloatingElement(element, { left: 340, top: 563 }, { innerWidth: 394, innerHeight: 689 });
    assert.equal(element.getBoundingClientRect().top, 563);
    assert.equal(style.bottom, 'auto');
});

test('keyboard, panning, orientation and oversize panel bounds', () => {
    const win = { innerWidth: 800, innerHeight: 900, visualViewport: { width: 394, height: 280, offsetLeft: 20, offsetTop: 100 } };
    assert.deepEqual(clampFloatingPoint({ left: 700, top: 700 }, { width: 44, height: 44 }, viewportBounds(win)), { left: 362, top: 328 });
    assert.deepEqual(clampFloatingPoint({ left: -100, top: -100 }, { width: 400, height: 400 }, viewportBounds(win)), { left: 28, top: 108 });
});

test('failed reference download stops before calling a billed image endpoint', async t => {
    let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return response(200, {}); });
    await assert.rejects(generateImage(settings, 'test', '', [{ url: 'https://image.test/expired' }], {
        fetchToDataUrl: async () => { throw new Error('HTTP 410'); },
    }), e => e.code === 'REFERENCE_DOWNLOAD_FAILED' && /410/.test(e.message));
    assert.equal(calls, 0);
});

test('partial reference failure cannot silently discard identity or continuity', async () => {
    await assert.rejects(hydrateReferenceImages([{ dataUrl: png }, { url: '/missing.png' }], async () => { throw new Error('404'); }), { code: 'REFERENCE_DOWNLOAD_FAILED' });
    await assert.rejects(hydrateReferenceImages([{}]), { code: 'REFERENCE_MISSING' });
    await assert.rejects(generateOpenAIImage(settings, 'test', '1024x1024', [{}]), { code: 'REFERENCE_MISSING' });
});

for (const [status, code] of [[400, 'EDITS_HTTP'], [401, 'EDITS_HTTP'], [403, 'EDITS_HTTP'], [404, 'EDITS_NOT_FOUND'], [405, 'EDITS_UNSUPPORTED'], [429, 'EDITS_HTTP'], [500, 'EDITS_HTTP'], [501, 'EDITS_UNSUPPORTED']]) {
    test(`edits HTTP ${status} preserves reason and never calls generations`, async t => {
        const calls = []; t.mock.method(globalThis, 'fetch', async (url, options) => {
            calls.push(url); assert.ok(options.body instanceof FormData);
            assert.ok(options.body.get('image') instanceof Blob);
            assert.equal(options.headers['Content-Type'], undefined);
            return response(status, { error: { message: 'upstream reason private-test-key' } });
        });
        await assert.rejects(generateOpenAIImage(settings, 'test', '1024x1024', [{ dataUrl: png }]), e => e.code === code && /upstream reason/.test(e.message) && !e.message.includes('private-test-key'));
        assert.deepEqual(calls, ['https://api.test/v1/images/edits']);
    });
}

test('edits fetch rejection stays network-unknown; does not claim CORS or unsupported', async t => {
    const calls=[];t.mock.method(globalThis, 'fetch', async url => { calls.push(url); throw new TypeError('Failed to fetch'); });
    await assert.rejects(generateOpenAIImage(settings, 'test', '1024x1024', [{ dataUrl: png }]), { code: 'NETWORK_FAILED' });
    assert.equal(calls.length, 1);
});

test('successful edits returns usedRefs, empty edits response fails without generations', async t => {
    t.mock.method(globalThis, 'fetch', async () => response(200, { data: [{ b64_json: 'YWJj' }] }));
    assert.equal((await generateOpenAIImage(settings, 'test', '1024x1024', [{ dataUrl: png }])).usedRefs, true);
    t.mock.method(globalThis, 'fetch', async () => response(200, { data: [] }));
    await assert.rejects(generateOpenAIImage(settings, 'test', '1024x1024', [{ dataUrl: png }]), { code: 'EDITS_EMPTY_RESPONSE' });
});

test('independent LLM fetch error identifies the text request stage', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(callLLM('test','test',{ llmSource:'custom',llmUrl:'https://api.test',llmModel:'text' }), e=>e.code==='NETWORK_FAILED'&&/chat\/completions/.test(e.message));
});

test('temporary output URL download failure is separate from an edits failure', async () => {
    let saves=0;
    await assert.rejects(persistMediaUrl('https://cdn.test/expired.png', 'test', {
        fetchToDataUrl: async () => { throw new RpigError('IMAGE_DOWNLOAD_HTTP','HTTP 410'); }, saveBase64AsFile:()=>{saves++;},
    }), e=>e.code==='TEMP_IMAGE_DOWNLOAD_FAILED'&&e.details.reason==='IMAGE_DOWNLOAD_HTTP');
    assert.equal(saves,0);
});

test('download rejects HTTP errors, HTML login pages and empty image bodies', async t => {
    t.mock.method(globalThis,'fetch',async()=>new Response('expired',{status:410}));
    await assert.rejects(fetchToDataUrl('https://cdn.test/file'),{code:'IMAGE_DOWNLOAD_HTTP'});
    t.mock.method(globalThis,'fetch',async()=>new Response('<html>login</html>',{headers:{'content-type':'text/html'}}));
    await assert.rejects(fetchToDataUrl('https://cdn.test/file'),{code:'IMAGE_DOWNLOAD_INVALID'});
    t.mock.method(globalThis,'fetch',async()=>new Response('',{headers:{'content-type':'image/png'}}));
    await assert.rejects(fetchToDataUrl('https://cdn.test/file'),{code:'IMAGE_DOWNLOAD_INVALID'});
});

test('portable archive embeds bytes, omits URLs/extra settings, rejects URL-only imports', async () => {
    const archive=await exportReferenceArchive([{url:'/pc-only/image.png',label:'front',apiKey:'secret'}],async()=>png);
    assert.equal(archive.includes('pc-only'),false); assert.equal(archive.includes('secret'),false);
    assert.deepEqual(parseReferenceArchive(archive),[{label:'front',dataUrl:png}]);
    assert.throws(()=>parseReferenceArchive(JSON.stringify({format:'rpig-references',version:1,views:[{url:'/pc-only.png'}]})),{code:'REFERENCE_ARCHIVE_INVALID'});
});

test('network diagnostics redact keys and URL query credentials', () => {
    const error=requestFailure(new TypeError('Failed private-key-value'), 'https://api.test/edits?token=secret', 'edits', ['private-key-value']);
    assert.equal(error.message.includes('private-key-value'),false);assert.equal(error.message.includes('token=secret'),false);
});

test('older WebView without AbortSignal.timeout/any preserves timeout and cancellation', async t => {
    const timeout=Object.getOwnPropertyDescriptor(AbortSignal,'timeout');const any=Object.getOwnPropertyDescriptor(AbortSignal,'any');
    Object.defineProperty(AbortSignal,'timeout',{value:undefined,configurable:true});Object.defineProperty(AbortSignal,'any',{value:undefined,configurable:true});
    t.after(()=>{Object.defineProperty(AbortSignal,'timeout',timeout);Object.defineProperty(AbortSignal,'any',any);});
    const signal=timeoutSignal(5);await new Promise(r=>setTimeout(r,20));
    assert.equal(signal.aborted,true);assert.equal(signal.reason.name,'TimeoutError');
    assert.equal(requestFailure(signal.reason,'https://api.test','test').code,'REQUEST_TIMEOUT');
    const a=new AbortController();const b=new AbortController();const combined=combineAbortSignals(a.signal,b.signal);b.abort();assert.equal(combined.aborted,true);
});

test('input_fidelity retry only occurs when that field is explicitly rejected', async t => {
    const bodies=[];t.mock.method(globalThis,'fetch',async(_url,options)=>{bodies.push(options.body);return bodies.length===1?response(400,{error:'unsupported input_fidelity'}):response(200,{data:[{b64_json:'YWJj'}]});});
    const result=await generateOpenAIImage(settings,'test','1024x1024',[{dataUrl:png}],{continuityReference:true});
    assert.equal(result.usedRefs,true);assert.equal(bodies.length,2);assert.equal(bodies[0].get('input_fidelity'),'high');assert.equal(bodies[1].has('input_fidelity'),false);
    let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return response(400,{error:'invalid model'});});
    await assert.rejects(generateOpenAIImage(settings,'test','1024x1024',[{dataUrl:png}],{continuityReference:true}),{code:'EDITS_HTTP'});assert.equal(calls,1);
});
