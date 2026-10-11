import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const includeLocal = process.argv.includes('--local');
const extraArgs = process.argv.slice(2).filter(arg => arg !== '--local');
const files = readdirSync(new URL('../tests/', import.meta.url))
    .filter(name => name.endsWith('.test.mjs') && (includeLocal || !name.startsWith('local-scene-')))
    .sort().map(name => `tests/${name}`);
// Pass explicit filenames to support Windows and Node 18 without shell glob expansion.
const result = spawnSync(process.execPath, ['--test', ...extraArgs, ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
