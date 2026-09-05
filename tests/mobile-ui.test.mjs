import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('mobile UI exposes direct generate and panel buttons', async () => {
  const source = await readFile(new URL('index.js', root), 'utf8');
  const css = await readFile(new URL('style.css', root), 'utf8');

  assert.match(source, /class="menu_button rpig-mobile-gen-now"/);
  assert.match(source, /class="menu_button rpig-mobile-open-panel"/);
  assert.match(source, /mobileActions\.find\('\.rpig-mobile-gen-now'\)\.on\('click', generateLatestAssistantMessage\)/);
  assert.match(source, /mobileActions\.find\('\.rpig-mobile-open-panel'\)\.on\('click', toggleFloatingPanel\)/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /\.rpig-mobile-actions[\s\S]*display: flex !important/);
  assert.match(css, /safe-area-inset-bottom/);
});
