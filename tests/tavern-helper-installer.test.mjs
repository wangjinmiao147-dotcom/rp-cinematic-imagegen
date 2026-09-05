import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const installerPath = new URL('../installers/rp-cinematic-imagegen-tavern-helper-installer.json', import.meta.url);

test('Tavern Helper installer is valid, disabled-by-default script JSON', async () => {
  const installer = JSON.parse(await readFile(installerPath, 'utf8'));

  assert.equal(installer.type, 'script');
  assert.equal(installer.enabled, false);
  assert.equal(installer.name, 'RP 电影配图 · 一键安装/更新');
  assert.equal(installer.button.enabled, true);
  assert.deepEqual(installer.button.buttons, [
    { name: '安装 / 更新 RP 电影配图', visible: true },
  ]);
  assert.deepEqual(installer.data, {});
  assert.deepEqual(installer.export_with, { data: true, button: true });
});

test('Tavern Helper installer targets the public repository and has valid JavaScript', async () => {
  const installer = JSON.parse(await readFile(installerPath, 'utf8'));

  assert.match(installer.content, /https:\/\/github\.com\/wangjinmiao147-dotcom\/rp-cinematic-imagegen/);
  assert.match(installer.content, /installExtension\(REPOSITORY_URL, 'local'\)/);
  assert.match(installer.content, /updateExtension\(EXTENSION_ID\)/);
  assert.match(installer.content, /getButtonEvent\(BUTTON_NAME\)/);
  assert.doesNotThrow(() => new Function(installer.content));
});

test('Tavern Helper installer migrates the legacy directory only after the full version installs', async () => {
  const installer = JSON.parse(await readFile(installerPath, 'utf8'));
  const installIndex = installer.content.indexOf("installExtension(REPOSITORY_URL, 'local')");
  const uninstallIndex = installer.content.indexOf('uninstallExtension(LEGACY_EXTENSION_ID)');

  assert.ok(installIndex >= 0, 'installer must install the full GitHub extension');
  assert.ok(uninstallIndex > installIndex, 'legacy removal must happen only after the full install succeeds');
  assert.match(installer.content, /完整正式版/);
});
