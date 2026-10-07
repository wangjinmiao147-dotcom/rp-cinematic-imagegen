import { createAbortError, throwIfAborted, RpigError } from './utils.js';

// Reduce the complete generated scene once, without a crop or another pass.
export async function resizeSceneOutput(dataUrl, plan, {signal, document:doc=globalThis.document, Image:ImageType=globalThis.Image}={}) {
    throwIfAborted(signal);
    if (!doc?.createElement || typeof ImageType !== 'function') throw new RpigError('SCENE_RESIZE_UNAVAILABLE', '清晰绘制完成，但当前环境无法缩小成最终尺寸；请使用酒馆浏览器');
    const image = new ImageType();
    await new Promise((resolve,reject)=>{
        const finish = error => {
            image.onload=null;image.onerror=null;signal?.removeEventListener('abort',cancel);
            error ? reject(error) : resolve();
        };
        const cancel = () => {finish(createAbortError());image.src='';};
        image.onload=()=>finish();
        image.onerror=()=>finish(new RpigError('SCENE_RESIZE_DECODE', '清晰绘制图片无法读取，未保存错误尺寸'));
        signal?.addEventListener('abort',cancel,{once:true});
        image.src=dataUrl;
    });
    throwIfAborted(signal);
    if (image.naturalWidth !== plan.renderSize[0] || image.naturalHeight !== plan.renderSize[1]) {
        throw new RpigError('SCENE_RENDER_SIZE_MISMATCH', '桥接返回尺寸与清晰绘制请求不一致，未保存错误尺寸');
    }
    const canvas=doc.createElement('canvas');
    [canvas.width,canvas.height]=plan.outputSize;
    const context=canvas.getContext('2d');
    if (!context) throw new RpigError('SCENE_RESIZE_UNAVAILABLE', '无法建立最终图片画布');
    context.imageSmoothingEnabled=true;
    context.imageSmoothingQuality='high';
    context.drawImage(image,0,0,canvas.width,canvas.height);
    throwIfAborted(signal);
    return canvas.toDataURL('image/png');
}
