import { hydrateReferenceImages } from './backends.js';
import { dataUrlToBlob, RpigError } from './utils.js';

export const MAX_REFERENCE_ARCHIVE_BYTES = 30 * 1024 * 1024;

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
