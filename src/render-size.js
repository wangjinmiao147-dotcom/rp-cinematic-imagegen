import { RpigError } from './utils.js';

// User-selected sizes are sent unchanged. Reject unsupported values rather
// than rounding them or switching to a more expensive rendering preset.
export function configuredLocalImageSize(settings = {}) {
    const raw = [settings.localImageWidth, settings.localImageHeight];
    const empty = value => value == null || value === '' || (typeof value === 'string' && !value.trim());
    if (raw.every(empty)) return null;
    const validType = value => typeof value === 'number' || typeof value === 'string';
    const size = raw.map(Number);
    if (raw.some(value => empty(value) || !validType(value))
        || size.some(value => !Number.isInteger(value) || value < 256 || value > 2048 || value % 32 !== 0)) {
        throw new RpigError('LOCAL_RENDER_SIZE_INVALID', '本地绘制宽度与高度都须填写为256–2048之间、且为32倍数的整数；没有自动改像素。');
    }
    return size;
}
