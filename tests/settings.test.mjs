import assert from 'node:assert/strict';
import test from 'node:test';

import { hasConfiguredGenerationSettings } from '../src/utils.js';

test('recognizes an actually configured generation profile', () => {
  assert.equal(hasConfiguredGenerationSettings({ backendUrl: 'https://relay.example/v1', backendModel: 'image-model' }), true);
  assert.equal(hasConfiguredGenerationSettings({ llmModel: 'director-model' }), true);
});

test('does not treat untouched defaults as a configured profile', () => {
  assert.equal(hasConfiguredGenerationSettings({ backend: 'openai', backendUrl: '', backendKey: '', backendModel: '', characterAnchors: {} }), false);
});

test('recognizes saved character anchors without exposing any credentials', () => {
  assert.equal(hasConfiguredGenerationSettings({ characterAnchors: { heroine: 'black hair, red eyes' } }), true);
});
