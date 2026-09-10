import fs from 'node:fs/promises';import {connect} from './android-cdp.mjs';
const index=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
const lightbox=index.slice(index.indexOf('function openLightbox('),index.indexOf('\nasync function openGallery('));
const gallery=index.slice(index.indexOf('async function openGallery('),index.indexOf('\nlet rpigGenerating'));
const ui='data:text/javascript;base64,'+Buffer.from(await fs.readFile(new URL('../src/floating-ui.js',import.meta.url),'utf8')).toString('base64');
const css=await fs.readFile(new URL('../style.css',import.meta.url),'utf8');
const c=await connect();const result=await c.send('Runtime.evaluate',{expression:`(async()=>{
 const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);
 const {fitViewportOverlay}=await import(${JSON.stringify(ui)});document.querySelector('#rpig-gallery-close')?.click();
 const character={name:'移动图库测试',avatar:'fixture'};const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=';
 const deps={$:jQuery,document,fitViewportOverlay,getContext:()=>({characters:[character]}),getCurrentCharacter:()=>character,
 getAllImagesForCharacter:async()=>Array.from({length:18},(_,i)=>({url:png,title:'测试图片 '+i})),toastr,deleteImageCompletely:()=>{throw new Error('test must not delete user media')},escapeHtml:s=>s};
 const open=new Function(...Object.keys(deps),${JSON.stringify(lightbox+'\n'+gallery+';return openGallery;')})(...Object.values(deps));
 await open(character);const e=document.querySelector('.rpig-gallery-overlay');const grid=e.querySelector('.rpig-gallery-grid');
 const images=[...grid.querySelectorAll('img')];images.forEach(i=>i.loading='eager');await Promise.all(images.map(i=>i.decode().catch(()=>{})));
 const galleryRect=e.getBoundingClientRect().toJSON();const gridRect=grid.getBoundingClientRect().toJSON();grid.scrollTop=100;const scrolled=grid.scrollTop>0;const cs=getComputedStyle(images[0]);const gs=getComputedStyle(grid);const scrollDebug={scrollHeight:grid.scrollHeight,clientHeight:grid.clientHeight,overflow:gs.overflowY,rows:gs.gridTemplateRows,cardHeight:images[0].parentElement.getBoundingClientRect().height,imageStyle:{height:cs.height,maxHeight:cs.maxHeight,display:cs.display,flexShrink:cs.flexShrink},scrollTop:grid.scrollTop};
 images[0].click();const preview=document.querySelector('.rpig-lightbox');const previewRect=preview?.getBoundingClientRect().toJSON();preview?.click();e.querySelector('#rpig-gallery-close').click();
 style.remove();return {galleryRect,gridRect,imageCount:images.length,loaded:images.filter(i=>i.naturalWidth>0).length,scrolled,scrollDebug,previewRect,closed:!document.querySelector('.rpig-gallery-overlay')&&!document.querySelector('.rpig-lightbox')};
})()`,awaitPromise:true,returnByValue:true});console.log(JSON.stringify(result.result.value||result,null,2));await fs.writeFile('android-gallery-results.json',JSON.stringify(result.result.value||result,null,2));c.ws.close();

const report=result.result.value;
if(!report||report.imageCount!==18||report.loaded!==18||!report.scrolled||!report.closed||report.galleryRect.height<100||report.previewRect.height<100)process.exitCode=1;
