import { hydrateReferenceImages } from './backends.js';
import { blobToDataUrl, dataUrlToBlob, RpigError } from './utils.js';

export const MAX_REFERENCE_ARCHIVE_BYTES = 30 * 1024 * 1024;

export async function readReferenceImport(file, convert = blobToDataUrl) {
    if (!file || !file.size || file.size > MAX_REFERENCE_ARCHIVE_BYTES) throw new RpigError('REFERENCE_IMPORT_INVALID', '导入文件为空或超过 30MB');
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const ascii = (start, end) => String.fromCharCode(...head.slice(start, end));
    const mime = head[0] === 255 && head[1] === 216 && head[2] === 255 ? 'image/jpeg'
        : [137,80,78,71,13,10,26,10].every((n,i) => head[i] === n) ? 'image/png'
        : /GIF8[79]a/.test(ascii(0,6)) ? 'image/gif'
        : ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP' ? 'image/webp' : '';
    if (mime) {
        if (file.size > 15 * 1024 * 1024) throw new RpigError('REFERENCE_IMPORT_INVALID', '单张参考图不能超过 15MB');
        // Android file providers may omit MIME types; identify bytes instead.
        const dataUrl = await convert(new Blob([file], { type: mime }));
        return [{ label: String(file.name || '导入图片').replace(/\.[^.]+$/, '').slice(0,160), dataUrl }];
    }
    if (/\.json$/i.test(file.name || '') || file.type === 'application/json') return parseReferenceArchive(await file.text());
    throw new RpigError('REFERENCE_IMPORT_INVALID', '请选择 JPG、PNG、WebP、GIF 图片或导出的 JSON 参考图包；文件内容不是支持的图片格式');
}

export async function exportReferenceArchive(refs, fetchImage) {
    const hydrated = await hydrateReferenceImages(refs, fetchImage, 50);
    const text = JSON.stringify({ format: 'rpig-references', version: 1,
        views: hydrated.map(ref => ({ label: String(ref.label || '参考图'), dataUrl: ref.dataUrl })) });
    if (new Blob([text]).size > MAX_REFERENCE_ARCHIVE_BYTES) throw new RpigError('REFERENCE_ARCHIVE_TOO_LARGE', '参考图包超过 30MB，请分批迁移');
    return text;
}

export function parseReferenceArchive(text) {
    if (typeof text !== 'string' || new Blob([text]).size > MAX_REFERENCE_ARCHIVE_BYTES) throw new RpigError('REFERENCE_ARCHIVE_INVALID', '参考图包无效或超过 30MB');
    let archive;
    try { archive = JSON.parse(text); } catch { throw new RpigError('REFERENCE_ARCHIVE_INVALID', '参考图包不是有效 JSON'); }
    if (archive?.format !== 'rpig-references' || archive.version !== 1 || !Array.isArray(archive.views) || archive.views.length > 50) throw new RpigError('REFERENCE_ARCHIVE_INVALID', '参考图包格式或版本不支持');
    return archive.views.map(ref => {
        if (typeof ref?.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/.test(ref.dataUrl)) throw new RpigError('REFERENCE_ARCHIVE_INVALID', '参考图包必须包含完整图片数据，不能只包含另一设备的文件地址');
        try { if (!dataUrlToBlob(ref.dataUrl).size) throw new Error('empty'); }
        catch { throw new RpigError('REFERENCE_ARCHIVE_INVALID', '参考图 Base64 数据无效'); }
        return { label: String(ref.label || '导入参考图').slice(0, 160), dataUrl: ref.dataUrl };
    });
}
