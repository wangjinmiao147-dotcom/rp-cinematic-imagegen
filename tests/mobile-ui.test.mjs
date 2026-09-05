import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('mobile UI reuses the full desktop floating workbench', async () => {
  const source = await readFile(new URL('index.js', root), 'utf8');
  const css = await readFile(new URL('style.css', root), 'utf8');

  assert.match(source, /class="rpig-fab"/);
  assert.match(source, /id="rpig-gen-now"/);
  assert.match(source, /id="rpig-gallery-btn"/);
  assert.match(source, /id="rpig-open-settings"/);
  assert.doesNotMatch(source, /rpig-mobile-actions/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /\.rpig-fab[\s\S]*position: fixed !important;[\s\S]*display: flex !important/);
  assert.match(css, /\.rpig-fab-panel[\s\S]*max-height: calc\(100dvh - 100px\)/);
  assert.match(css, /safe-area-inset-bottom/);
});

test('mobile prompt review keeps confirmation visible without forcing the keyboard open', async () => {
  const source = await readFile(new URL('index.js', root), 'utf8');
  const css = await readFile(new URL('style.css', root), 'utf8');

  assert.match(source, /shouldAutofocusPromptReview/);
  assert.match(source, /\(min-width: 601px\) and \(pointer: fine\)/);
  assert.match(source, /addClass\('rpig-review-open'\)/);
  assert.match(source, /removeClass\('rpig-review-open'\)/);
  assert.match(css, /\.rpig-prompt-review-actions[\s\S]*position: sticky;[\s\S]*bottom: -12px/);
  assert.match(css, /\.rpig-review-confirm[\s\S]*order: -1;[\s\S]*flex-basis: 100%/);
  assert.match(css, /height: 100dvh/);
});
