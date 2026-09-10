import fs from 'node:fs/promises';
import { connect } from './android-cdp.mjs';

// Uses the installed plugin's actual settings DOM and host styles on Android.
// No upload, generation, storage changes or page reload is performed.
const timer = setTimeout(() => { console.error('Android CDP timed out'); process.exit(2); }, 15000);
const c = await connect();
try {
    const css = await fs.readFile(new URL('../style.css', import.meta.url), 'utf8');
    const response = await c.send('Runtime.evaluate', { expression: `(async()=>{
        const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);await new Promise(r=>setTimeout(r,500));
        try {
            const buttons=[...document.querySelectorAll('#rpig_container button')].filter(e=>/参考图包|上传本地|开始以原图/.test(e.textContent));
            return buttons.map(e=>{const r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return {
                id:e.id,classes:e.className,text:e.textContent.trim(),width:r.width,height:r.height,parentWidth:p.width,
                pass:r.width>=150&&r.height>0&&r.height<=90&&r.width<=p.width+1
            }});
        } finally {style.remove();}
    })()`, returnByValue: true, awaitPromise: true });
    const result = response.result?.value;
    console.log(JSON.stringify(result || response, null, 2));
    if (!Array.isArray(result) || result.length!==4 || result.some(r=>!r.pass)) process.exitCode=1;
} finally { c.ws.close(); clearTimeout(timer); }


