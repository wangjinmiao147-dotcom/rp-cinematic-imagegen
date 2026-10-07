// Bounded geometric reference for simple single-palm wall-mirror scenes.
// Unrecognized actions keep the ordinary story path; no fixed pose is imposed on them.
const add=(a,b)=>a.map((n,i)=>n+b[i]), sub=(a,b)=>a.map((n,i)=>n-b[i]);
const scale=(a,s)=>a.map(n=>n*s), dot=(a,b)=>a.reduce((v,n,i)=>v+n*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>scale(a,1/Math.hypot(...a));

export function reflectPoint(point, planePoint=[0,0,0], planeNormal=[0,0,1]) {
    const n=unit(planeNormal);
    return sub(point,scale(n,2*dot(sub(point,planePoint),n)));
}

export function mirrorFixture(side='right') {
    if (!['right','left'].includes(side)) throw Error('Fixture requires an explicit contact side');
    const sign=side==='right'?1:-1;
    const camera={position:[-2.8*sign,1.55,-4.5],target:[0,1,0],verticalFov:36};
    const z=-0.58;
    const joints={head:[0,1.67,z],neck:[0,1.48,z],hip:[0,.83,z],
        rightShoulder:[.22,1.43,z],leftShoulder:[-.22,1.43,z],
        rightElbow:[.25,1.08,z],leftElbow:[-.25,1.08,z],
        rightWrist:[.27,.79,z],leftWrist:[-.27,.79,z],
        rightPalm:[.27,.73,z],leftPalm:[-.27,.73,z],
        rightFoot:[.1,.035,z],leftFoot:[-.1,.035,z]};
    joints[side+'Elbow']=[sign*.34,1.21,-.27];
    joints[side+'Wrist']=[sign*.36,1.44,0];
    joints[side+'Palm']=[sign*.36,1.51,0];
    const reflected=Object.fromEntries(Object.entries(joints).map(([name,p])=>[name,reflectPoint(p)]));
    return {side,camera,joints,reflected,mirror:[[-.85,0,0],[.85,0,0],[.85,2.14,0],[-.85,2.14,0]]};
}

export function projector(camera,width=512,height=288) {
    const forward=unit(sub(camera.target,camera.position));
    const right=unit(cross([0,1,0],forward));
    const up=unit(cross(forward,right));
    const focal=height/(2*Math.tan(camera.verticalFov*Math.PI/360));
    return point=>{
        const v=sub(point,camera.position),depth=dot(v,forward);
        if(depth<=0) throw Error('Geometry is behind the camera');
        return [width/2+focal*dot(v,right)/depth,height/2-focal*dot(v,up)/depth];
    };
}

function crc32(data) {
    let crc=0xffffffff;
    for(const b of data){crc^=b;for(let k=0;k<8;k++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}
    return (crc^0xffffffff)>>>0;
}
function concat(parts) {
    const output=new Uint8Array(parts.reduce((size,p)=>size+p.length,0));
    let offset=0;for(const part of parts){output.set(part,offset);offset+=part.length;}return output;
}
function uint32(value) {return new Uint8Array([value>>>24,(value>>>16)&255,(value>>>8)&255,value&255]);}
export function png(width,height,pixels) {
    const chunk=(name,bytes)=>{
        const type=new Uint8Array([...name].map(c=>c.charCodeAt(0)));
        return concat([uint32(bytes.length),type,bytes,uint32(crc32(concat([type,bytes])))]);
    };
    const ihdr=concat([uint32(width),uint32(height),new Uint8Array([8,6,0,0,0])]);
    const rows=new Uint8Array(height*(width*4+1));
    for(let y=0;y<height;y++)rows.set(pixels.subarray(y*width*4,(y+1)*width*4),y*(width*4+1)+1);
    // PNG supports stored DEFLATE blocks: portable in browsers and Node,
    // without native dependencies, an external renderer or another AI call.
    const blocks=[new Uint8Array([0x78,0x01])];
    for(let offset=0;offset<rows.length;offset+=65535){
        const size=Math.min(65535,rows.length-offset),last=offset+size===rows.length;
        blocks.push(new Uint8Array([last?1:0,size&255,size>>>8,(~size)&255,((~size)>>>8)&255]),rows.subarray(offset,offset+size));
    }
    let a=1,b=0;for(const byte of rows){a=(a+byte)%65521;b=(b+a)%65521;}
    blocks.push(uint32(((b<<16)|a)>>>0));
    return concat([new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',concat(blocks)),chunk('IEND',new Uint8Array(0))]);
}

const inside=(x,y,poly)=>{
    let hit=false;
    for(let i=0,j=poly.length-1;i<poly.length;j=i++){
        const [ax,ay]=poly[i],[bx,by]=poly[j];
        if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)hit=!hit;
    }return hit;
};

export function renderGuide(fixture,width=512,height=288) {
    const project=projector(fixture.camera,width,height);
    const pixels=new Uint8Array(width*height*4),commands=[];
    let clip=null;
    const paint=(x,y,color)=>{
        x=Math.round(x);y=Math.round(y);
        if(x<0||y<0||x>=width||y>=height||(clip&&!inside(x+.5,y+.5,clip)))return;
        const pos=(y*width+x)*4;for(let c=0;c<3;c++)pixels[pos+c]=color[c];pixels[pos+3]=255;
    };
    const polygon=(points,color)=>{
        commands.push(`<polygon points="${points.map(p=>p.map(n=>n.toFixed(2)).join(',')).join(' ')}" fill="rgb(${color})"/>`);
        const minX=Math.max(0,Math.floor(Math.min(...points.map(p=>p[0])))),maxX=Math.min(width-1,Math.ceil(Math.max(...points.map(p=>p[0]))));
        const minY=Math.max(0,Math.floor(Math.min(...points.map(p=>p[1])))),maxY=Math.min(height-1,Math.ceil(Math.max(...points.map(p=>p[1]))));
        for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++)if(inside(x+.5,y+.5,points))paint(x,y,color);
    };
    const disc=(point,r,color)=>{
        const [cx,cy]=point;
        commands.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="rgb(${color})"/>`);
        for(let y=Math.floor(cy-r);y<=cy+r;y++)for(let x=Math.floor(cx-r);x<=cx+r;x++)if((x-cx)**2+(y-cy)**2<=r*r)paint(x,y,color);
    };
    const line=(a,b,r,color)=>{
        const steps=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1]));
        for(let i=0;i<=steps;i++){
            const t=steps?i/steps:0;disc([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t],r,color);
        }
    };
    polygon([[0,0],[width,0],[width,height],[0,height]],[245,241,235]);
    polygon([[0,height*.80],[width,height*.80],[width,height],[0,height]],[218,211,201]);
    const mirror=fixture.mirror.map(project);
    polygon(mirror,[224,232,233]);
    for(let i=0;i<4;i++)line(mirror[i],mirror[(i+1)%4],2.5,[132,111,91]);
    const drawBody=(joints,reflected)=>{
        const map=p=>project(reflected?reflectPoint(p):p);
        const baseZ=fixture.joints.hip[2];
        const silhouette=[[-.20,1.44,baseZ],[.20,1.44,baseZ],[.16,.87,baseZ],[.33,.095,baseZ],[-.33,.095,baseZ],[-.16,.87,baseZ]].map(map);
        polygon(silhouette,reflected?[165,171,177]:[153,161,167]);
        for(const side of ['left','right']){
            const p=['Shoulder','Elbow','Wrist','Palm'].map(n=>project(joints[side+n]));
            for(let i=0;i<3;i++)line(p[i],p[i+1],i===2?2.8:4.8,[187,185,180]);
            line(project(joints[side+'Foot']),map([side==='right'?.16:-.16,.025,baseZ+.11]),4,[89,93,99]);
        }
        const head=[];
        for(let i=0;i<30;i++){const a=i*Math.PI/15;head.push(map([Math.cos(a)*.11,1.67+Math.sin(a)*.16,baseZ]));}
        polygon(head,[193,192,186]);
        line(map([0,1.52,baseZ]),map([0,1.44,baseZ]),4,[187,185,180]);
        if(reflected){disc(map([-.035,1.70,baseZ]),1.3,[81,83,85]);disc(map([.035,1.70,baseZ]),1.3,[81,83,85]);}
    };
    clip=mirror;commands.push('<g clip-path="url(#mirror)">');drawBody(fixture.reflected,true);commands.push('</g>');
    clip=null;drawBody(fixture.joints,false);
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><clipPath id="mirror"><polygon points="${mirror.map(p=>p.join(',')).join(' ')}"/></clipPath></defs>${commands.join('')}</svg>`;
    return {png:png(width,height,pixels),svg,projectedPhysical:Object.fromEntries(Object.entries(fixture.joints).map(([n,p])=>[n,project(p)])),projectedReflection:Object.fromEntries(Object.entries(fixture.reflected).map(([n,p])=>[n,project(p)])),mirror};
}

export function mirrorLayoutPlan(prompt, refs=[], settings={}) {
    if ((settings.shotMode || 'snapshot') !== 'snapshot') return null;
    const primaries=refs.filter(r=>(r.role || r.kind)==='identity-primary');
    if (primaries.length!==1) return null;
    const cast=String(prompt).match(/VISIBLE CAST \((\d+)\)/i);
    if (cast && Number(cast[1])!==1) return null;
    const story=String(prompt).match(/REQUESTED CHANGES:\s*([\s\S]*?)(?=DETAILS TO PRESERVE:|$)/i)?.[1]?.trim();
    if (!story || (!cast && !/\b(?:alone|single.person|only one (?:person|woman|man))\b/i.test(story))) return null;
    // This initial adapter covers only the geometry actually validated in images.
    if (!/\b(?:wall mirror|vertical (?:wall )?mirror)\b/i.test(story)) return null;
    if (/\b(?:not standing|no mirror|without (?:a )?mirror|seated|sitting|kneeling|walking|running|lying|reclining|crouching|squatting|leaning|bending|close.up|partial|portrait|waist.up|chest.up|shoulders.up|hand.only|torso.only|head.only|off.camera|out.of.frame|outside the frame|tilted|curved|broken|supernatural|independent|holding|carrying|gripping|tail|wings|hooves|snout|tentacles|chibi|thought.bubble|crossed|stepping|tiptoe|one foot|wide stance|high.angle|low.angle|from above|from below|fully extended|straight arm|arm straight|head tilted|head bowed)\b/i.test(story)) return null;
    if (/\bon (?:the |a )?(?:bench|chair|bed|floor)|\bon (?:her|his|their) knees|\bon all fours|\bon (?:one|a single) (?:foot|leg)|\bon (?:her|his|their) toes/i.test(story)) return null;
    if (/\b(?:hovering|floating|flying|levitating|inverted|upside.down|second mirror|another mirror|two mirrors|multiple mirrors|several mirrors)|\b(?:round|oval|circular)\b[^.!?]*\bmirror\b/i.test(story)) return null;
    if (!/\b(?:body and head|head and body)\b[^.!?]*\b(?:toward|facing|directed)[^.!?]*\bmirror\b/i.test(story)) return null;
    const hand=story.match(/\b(?:raised\s+)?(right|left)\s+palm\s+(?:touches|presses (?:against|on))\s+(?:the |a )?mirror\s+at\s+shoulder(?:-| )height\b/i)?.[1]?.toLowerCase();
    const cameraSide=story.match(/\bfrom behind and slightly to (?:her|his|their|the character's) (left|right)\b/i)?.[1]?.toLowerCase();
    if (!hand || !cameraSide || hand===cameraSide) return null;
    const other=hand==='right'?'left':'right';
    if (!new RegExp(other+' arm (?:hangs|rests) (?:down )?(?:at|by) (?:her|his|their) side','i').test(story)) return null;
    return {kind:'standing-palm-contact',hand,cameraSide,
        postureSource:/\b(?:standing|stands|stand)\b/i.test(story)?'explicit':'unspecified-simple-contact',
        identityName:primaries[0].identityName || '',story};
}

export function mirrorLayoutReference(plan,width,height) {
    if (!plan || plan.kind!=='standing-palm-contact' || !['left','right'].includes(plan.hand)) return null;
    const rendered=renderGuide(mirrorFixture(plan.hand),width,height);
    let binary='';for(let offset=0;offset<rendered.png.length;offset+=8192)binary+=String.fromCharCode(...rendered.png.subarray(offset,offset+8192));
    return {dataUrl:'data:image/png;base64,'+btoa(binary),role:'mirror-layout',kind:'mirror-layout',
        source:'single-pose-plane-projection',label:'Mirror geometry',mirrorPlan:plan,
        geometryContact:rendered.projectedPhysical[plan.hand+'Palm'],reflectedContact:rendered.projectedReflection[plan.hand+'Palm']};
}
