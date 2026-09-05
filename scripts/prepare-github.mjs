import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flagIndex = process.argv.indexOf('--repository-url');
const repositoryUrl = flagIndex >= 0 ? process.argv[flagIndex + 1]?.trim().replace(/\/$/, '') : '';

if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(repositoryUrl)) {
    console.error('Usage: npm run prepare:repo -- --repository-url https://github.com/OWNER/REPOSITORY');
    process.exit(1);
}

function updateJson(relativePath, update) {
    const path = join(root, relativePath);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    update(data);
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

updateJson('manifest.json', (manifest) => { manifest.homePage = repositoryUrl; });
updateJson('package.json', (pkg) => { pkg.repository.url = `${repositoryUrl}.git`; });
updateJson(join('docs', 'community-entry.json'), (entry) => { entry.url = repositoryUrl; });

console.log(`Repository metadata updated: ${repositoryUrl}`);
console.log('Next step: npm run check');
