export async function connect() {
    const targets=await(await fetch((process.env.RPIG_CDP_URL || 'http://127.0.0.1:9223') + '/json/list')).json();
    const target=targets.find(t=>t.title==='SillyTavern');if(!target)throw new Error('SillyTavern is not open');
    const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
    let seq=0;const pending=new Map();const listeners=[];
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(m.error):p?.resolve(m.result)}else for(const fn of listeners)fn(m)};
    return {ws, listeners, send:(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})};
}
