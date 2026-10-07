import {projector,png} from './mirror-layout.js';
import {requestsReflection} from './visual-constraints.js';

const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

// Initial bounded adapter: a back-supported figure and a second figure leaning
// toward it with one working hand. Other scenes keep their own ordinary path.
export function supportedPosePlan(prompt,refs=[],settings={}) {
    if(settings.qwenSceneDetail!==true || (settings.shotMode || 'snapshot')!=='snapshot')return null;
    const primaries=refs.filter(r=>(r.role || r.kind)==='identity-primary');
    if(primaries.length!==2 || primaries.some(r=>!r.identityName))return null;
    const text=String(prompt),cast=text.match(/VISIBLE CAST \((\d+)\)/);
    if(!cast || Number(cast[1])!==2)return null;
    const story=text.match(/REQUESTED CHANGES:\s*([\s\S]*?)(?=DETAILS TO PRESERVE:|$)/i)?.[1]?.trim();
    if(!story || requestsReflection(story))return null;
    if(/\b(?:seated|sitting|kneeling|lying|crouching|squatting|walking|running|arch(?:ed|ing)?|twisting|floating|flying|tail|wings|hooves|close.up|partial|hand.only|off.camera|high.angle|low.angle|from behind|strict profile|crossed|one foot|thought.bubble|chibi)\b/i.test(story))return null;
    if(!/\b(?:basin|washbasin)\b/i.test(story))return null;
    const frontView=/\bfront three.quarter view\b/i.test(story);
    if(!frontView && /\b(?:from (?:behind|the front|the left|the right|above|below)|(?:rear|side|profile|overhead|front)[ -]view|camera|three.quarter)\b/i.test(story))return null;
    const a=escape(primaries[0].identityName),b=escape(primaries[1].identityName);
    if(!new RegExp(a+'[^.!?]{0,35}leaning (?:her|his|their) back against (?:a |the )?(?:wash)?basin','i').test(story))return null;
    if(!new RegExp(b+'[^.!?]{0,35}(?:bends? (?:the |her |his |their )?upper body forward|leans? (?:down|forward))','i').test(story))return null;
    if(!/\bhands (?:\w+\s+){0,2}(?:rest|hover)[^.!?]{0,35}\babdomen\b/i.test(story))return null;
    const hand=story.match(/\b(?:with (?:the |her |his |their )?|her |his |their )(right|left) hand\b/i)?.[1]?.toLowerCase();
    if(!/\b(?:offers?|reaches?)[^.!?]*\b(?:hand|towel)\b/i.test(story))return null;
    if(!hand && !/\bone hand\b/i.test(story))return null;
    return {kind:'supported-back-two-people',identityNames:primaries.map(r=>r.identityName),hand:hand || null,displayHand:hand || 'right',
        cameraSource:frontView?'explicit-front-three-quarter':'unspecified-neutral-camera',story,
        reachHeight:/\bupper thigh\b/i.test(story)?.72:1.10};
}

export function supportedPoseFixture(plan) {
    const a={head:[-.63,1.66,0],neck:[-.58,1.48,0],rib:[-.55,1.30,0],waist:[-.50,1.00,0],hip:[-.44,.83,0],
        leftShoulder:[-.58,1.44,.20],rightShoulder:[-.58,1.44,-.20],
        leftElbow:[-.49,1.15,.25],rightElbow:[-.49,1.15,-.25],
        leftWrist:[-.29,1.01,.10],rightWrist:[-.29,1.01,-.10],
        leftPalm:[-.25,1.01,.07],rightPalm:[-.25,1.01,-.07],
        leftKnee:[-.36,.46,.08],rightKnee:[-.36,.46,-.08],leftFoot:[-.29,.045,.08],rightFoot:[-.29,.045,-.08]};
    const b={head:[.24,1.66,0],neck:[.34,1.49,0],rib:[.42,1.30,0],waist:[.53,1.06,0],hip:[.60,.88,0],
        leftShoulder:[.36,1.46,.20],rightShoulder:[.36,1.46,-.20],
        leftElbow:[.47,1.15,.24],rightElbow:[.47,1.15,-.24],
        leftWrist:[.58,.91,.23],rightWrist:[.58,.91,-.23],leftPalm:[.58,.86,.23],rightPalm:[.58,.86,-.23],
        leftKnee:[.64,.47,.13],rightKnee:[.64,.47,-.13],leftFoot:[.67,.045,.13],rightFoot:[.67,.045,-.13]};
    const side=plan.displayHand || plan.hand,z=side==='right'?-.22:.22;
    b[side+'Elbow']=[.03,plan.reachHeight+.12,z];
    b[side+'Wrist']=[-.15,plan.reachHeight,z];b[side+'Palm']=[-.22,plan.reachHeight,z];
    return {camera:{position:[0,1.37,-4.5],target:[0,.98,0],verticalFov:29},people:[a,b],
        counter:[[-1.18,.99,-.5],[-.64,.99,-.5],[-.64,.99,.5],[-1.18,.99,.5]]};
}

export function supportedPoseReference(plan,width,height) {
    const fixture=supportedPoseFixture(plan),project=projector(fixture.camera,width,height);
    const pixels=new Uint8Array(width*height*4);
    const paint=(x,y,c)=>{if(x<0||y<0||x>=width||y>=height)return;const i=(y*width+x)*4;pixels[i]=c[0];pixels[i+1]=c[1];pixels[i+2]=c[2];pixels[i+3]=255;};
    const polygon=(points,c)=>{
        const p=points.map(project);
        const minX=Math.max(0,Math.floor(Math.min(...p.map(v=>v[0])))),maxX=Math.min(width-1,Math.ceil(Math.max(...p.map(v=>v[0]))));
        const minY=Math.max(0,Math.floor(Math.min(...p.map(v=>v[1])))),maxY=Math.min(height-1,Math.ceil(Math.max(...p.map(v=>v[1]))));
        for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
            let hit=false;for(let i=0,j=p.length-1;i<p.length;j=i++)if((p[i][1]>y)!==(p[j][1]>y)&&x<(p[j][0]-p[i][0])*(y-p[i][1])/(p[j][1]-p[i][1])+p[i][0])hit=!hit;
            if(hit)paint(x,y,c);
        }
    };
    const disc=(point,r,c)=>{const [cx,cy]=project(point);for(let y=Math.max(0,Math.floor(cy-r));y<=Math.min(height-1,cy+r);y++)for(let x=Math.max(0,Math.floor(cx-r));x<=Math.min(width-1,cx+r);x++)if((x-cx)**2+(y-cy)**2<=r*r)paint(x,y,c);};
    const tube=(a,b,r,c)=>{
        const pa=project(a),pb=project(b),steps=Math.ceil(Math.hypot(pb[0]-pa[0],pb[1]-pa[1]));
        for(let i=0;i<=steps;i++){const t=steps?i/steps:0;disc(a.map((v,k)=>v+(b[k]-v)*t),r,c);}
    };
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)paint(x,y,y>height*.87?[217,216,212]:[242,241,237]);
    polygon(fixture.counter.map(p=>[p[0],.02,p[2]]),[182,181,177]);
    polygon([fixture.counter[0],fixture.counter[1],[-.64,.02,-.5],[-1.18,.02,-.5]],[178,177,173]);
    polygon(fixture.counter,[203,202,198]);
    for(const [index,j] of fixture.people.entries()){
        // The torso follows one smooth ribcage-waist-pelvis chain.
        const contour=[];
        for(const [name,r] of [['neck',.085],['rib',.18],['waist',.115],['hip',.17]])contour.push([j[name][0]-r,j[name][1],j[name][2]]);
        for(const [name,r] of [['hip',.17],['waist',.115],['rib',.18],['neck',.085]])contour.push([j[name][0]+r,j[name][1],j[name][2]]);
        polygon(contour,[158+index*12,162+index*12,165+index*12]);
        for(const side of ['left','right']){
            const z=j[side+'Foot'][2];
            tube([j.hip[0],j.hip[1],z],j[side+'Knee'],height*.018,[171,174,176]);
            tube(j[side+'Knee'],j[side+'Foot'],height*.013,[185,187,188]);
            tube(j[side+'Foot'],[j[side+'Foot'][0]+(index?-.10:.10),.025,z],height*.009,[114,118,121]);
            for(const [from,to] of [['Shoulder','Elbow'],['Elbow','Wrist'],['Wrist','Palm']])tube(j[side+from],j[side+to],height*(to==='Palm'?.007:.013),[188,189,189]);
        }
        tube(j.neck,j.head,height*.014,[187,187,184]);
        const head=[];for(let i=0;i<36;i++){const angle=i*Math.PI/18;head.push([j.head[0]+Math.cos(angle)*.12,j.head[1]+Math.sin(angle)*.16,0]);}
        polygon(head,[199,198,192]);
        const sign=index?-1:1;
        polygon([[j.head[0]+sign*.10,j.head[1]+.03,-.01],[j.head[0]+sign*.155,j.head[1],-.01],[j.head[0]+sign*.10,j.head[1]-.035,-.01]],[187,186,181]);
    }
    const bytes=png(width,height,pixels);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return {dataUrl:'data:image/png;base64,'+btoa(binary),role:'scene-layout',kind:'scene-layout',source:'generated-supported-pose',
        label:'Two-person back support and working-arm geometry',posePlan:plan,
        projectedPeople:fixture.people.map(j=>Object.fromEntries(Object.entries(j).map(([n,p])=>[n,project(p)])))};
}
