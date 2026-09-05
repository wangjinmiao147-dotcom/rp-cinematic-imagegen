import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
const installerPath = 'installers/rp-cinematic-imagegen-tavern-helper-installer.json';

for (const field of ['display_name', 'loading_order', 'requires', 'optional', 'js', 'css', 'author', 'version', 'description']) {
    if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
        errors.push(`manifest.json 缺少字段：${field}`);
    }
}

if (!Array.isArray(manifest.requires) || !Array.isArray(manifest.optional)) {
    errors.push('manifest.json 的 requires 和 optional 必须是数组');
}
if (!Number.isInteger(manifest.loading_order)) {
    errors.push('manifest.json 的 loading_order 必须是整数');
}
if (manifest.version !== pkg.version) {
    errors.push(`版本不一致：manifest=${manifest.version}, package=${pkg.version}`);
}
if (!read(manifest.js).includes(`v${manifest.version}`)) {
    errors.push(`${manifest.js} 中未找到界面版本 v${manifest.version}`);
}
if (!manifest.homePage) {
    warnings.push('manifest.json 的 homePage 仍为空；上传 GitHub 后请运行 npm run prepare:repo');
}

const runtimeFiles = [manifest.js, manifest.css, 'manifest.json'];
for (const file of runtimeFiles) {
    if (!existsSync(join(root, file))) errors.push(`运行文件不存在：${file}`);
}

if (!existsSync(join(root, installerPath))) {
    errors.push(`酒馆助手安装器不存在：${installerPath}`);
} else {
    try {
        const installer = JSON.parse(read(installerPath));
        if (installer.type !== 'script' || installer.enabled !== true) {
            errors.push('酒馆助手安装器必须是导入后立即运行的已启用 script JSON');
        }
        if (!installer.content?.includes(pkg.repository.url.replace(/\.git$/, ''))) {
            errors.push('酒馆助手安装器未指向 package.json 中的公开仓库');
        }
        if (!installer.button?.buttons?.some(button => button.visible && button.name)) {
            errors.push('酒馆助手安装器缺少可见的安装/更新按钮');
        }
        new Function(installer.content);
    } catch (error) {
        errors.push(`酒馆助手安装器格式或脚本语法无效：${error.message}`);
    }
}

const sourceFiles = [manifest.js, ...readdirSync(join(root, 'src'))
    .filter((name) => extname(name) === '.js')
    .map((name) => join('src', name))];

for (const file of sourceFiles) {
    const result = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' });
    if (result.status !== 0) errors.push(`${file} 语法检查失败：${result.stderr.trim()}`);

    const content = read(file);
    for (const match of content.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        const target = resolve(dirname(join(root, file)), match[1]);
        // ../../../ 等路径由 SillyTavern 宿主提供；只校验仓库内部相对模块。
        if (target.startsWith(`${root}${sep}`) && !existsSync(target)) {
            errors.push(`${file} 引用了不存在的模块：${match[1]}`);
        }
    }
}

const forbiddenNames = [
    /^\.env(?:\.|$)/i,
    /^backup/i,
    /\.backup(?:-|$)/i,
    /^index\.v\d+\.js$/i,
    /\.(?:pem|key|p12|pfx)$/i,
];

function walk(relativePath = '') {
    for (const entry of readdirSync(join(root, relativePath), { withFileTypes: true })) {
        if (['.git', 'dist', 'node_modules'].includes(entry.name)) continue;
        const child = join(relativePath, entry.name);
        if (forbiddenNames.some((pattern) => pattern.test(entry.name))) {
            errors.push(`发现禁止发布的文件或目录：${child}`);
        }
        if (entry.isDirectory()) walk(child);
    }
}
walk();

const secretPatterns = [
    ['OpenAI 风格密钥', /sk-[A-Za-z0-9_-]{16,}/g],
    ['Google API Key', /AIza[0-9A-Za-z_-]{20,}/g],
    ['GitHub Token', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
    ['AWS Access Key', /AKIA[0-9A-Z]{16}/g],
    ['私钥', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ['Bearer Token', /Bearer\s+[A-Za-z0-9._-]{16,}/g],
    ['Windows 绝对路径', /[A-Za-z]:\\(?:Users|Documents|Desktop|酒馆|deepseek桌面)\\/g],
];

for (const file of [...sourceFiles, manifest.css, 'manifest.json', installerPath]) {
    const content = read(file);
    for (const [label, pattern] of secretPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(content)) errors.push(`${file} 疑似包含${label}`);
    }
}

for (const warning of warnings) console.warn(`WARN: ${warning}`);
if (errors.length) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exit(1);
}
console.log(`OK: v${manifest.version} 发布校验通过（${sourceFiles.length} 个 JavaScript 文件）`);
