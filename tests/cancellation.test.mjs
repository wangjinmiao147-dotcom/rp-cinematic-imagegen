import test from 'node:test';
import assert from 'node:assert/strict';

import { generateOpenAIImage, generateTavernSD, hydrateReferenceImages } from '../src/backends.js';
import { createAbortError, raceWithAbort, sleep } from '../src/utils.js';

test('raceWithAbort rejects a pending operation immediately', async () => {
    const controller = new AbortController();
    const pending = new Promise(() => {});
    const result = raceWithAbort(pending, controller.signal);
    controller.abort(createAbortError());
    await assert.rejects(result, error => error.name === 'AbortError');
});

test('sleep can be cancelled', async () => {
    const controller = new AbortController();
    const result = sleep(10_000, controller.signal);
    controller.abort(createAbortError());
    await assert.rejects(result, error => error.name === 'AbortError');
});

test('reference hydration forwards cancellation', async () => {
    const controller = new AbortController();
    const fetchReference = (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    const result = hydrateReferenceImages([{ url: 'https://example.invalid/reference.png' }], fetchReference, 5, controller.signal);
    controller.abort(createAbortError());
    await assert.rejects(result, error => error.name === 'AbortError');
});

test('OpenAI-compatible image request forwards cancellation', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    try {
        const controller = new AbortController();
        const result = generateOpenAIImage(
            { backendUrl: 'https://example.invalid/v1', backendModel: 'image-test', backendKey: '' },
            'test prompt',
            '1024x1024',
            [],
            { signal: controller.signal },
        );
        controller.abort(createAbortError());
        await assert.rejects(result, error => error.name === 'AbortError');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('SillyTavern SD callback can be cancelled while pending', async () => {
    const controller = new AbortController();
    const parser = { commands: { sd: { callback: () => new Promise(() => {}) } } };
    const result = generateTavernSD('test prompt', parser, { signal: controller.signal });
    controller.abort(createAbortError());
    await assert.rejects(result, error => error.name === 'AbortError');
});
