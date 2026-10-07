import assert from 'node:assert/strict';
import test from 'node:test';
import {loadConfig,validateConfig,startServer} from '../tools/local-scene-llm/local-scene-llm.mjs';
const config=loadConfig(new URL('../tools/local-scene-llm/local-scene-config.example.json',import.meta.url));
const sampleResources=async()=>({usedMiB:1000,freeMiB:5000,temperatureC:60,systemFreeGiB:8});
const input={model:config.model,messages:[{role:'system',content:'Only JSON.'},{role:'user',content:'林岚在车站举手示意。'}],response_format:{type:'json_object'}};
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
async function fixture(run,ollamaFetch=async()=>json({models:[]})){
    const server=await startServer(config,{sampleResources,ollamaFetch,listenPort:0});
    try{await run('http://127.0.0.1:'+server.address().port,server);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('public configuration rejects non-loopback upstreams and invalid limits',()=>{
    assert.equal(validateConfig(config),config);
    for(const ollamaUrl of ['http://0.0.0.0:11434','https://127.0.0.1:11434','http://user:secret@127.0.0.1:11434','http://example.test'])assert.throws(()=>validateConfig({...config,ollamaUrl}));
    assert.throws(()=>validateConfig({...config,allowedOrigins:['*']}));
    assert.throws(()=>validateConfig({...config,numPredict:-1}));
    assert.throws(()=>validateConfig({...config,startTemperatureC:config.abortTemperatureC}));
});
test('loopback HTTP server enforces origins, handles preflight and rejects unknown models without inference',async()=>{
    let upstreamCalls=0;
    await fixture(async(base,server)=>{
        assert.equal(server.address().address,'127.0.0.1');
        const allowed=config.allowedOrigins[0];
        const health=await fetch(base+'/health',{headers:{Origin:allowed}});
        assert.equal(health.status,200);assert.equal((await health.json()).status,'ready');assert.equal(health.headers.get('access-control-allow-origin'),allowed);
        const denied=await fetch(base+'/health',{headers:{Origin:'https://untrusted.example'}});assert.equal(denied.status,403);
        const preflight=await fetch(base+'/v1/chat/completions',{method:'OPTIONS',headers:{Origin:allowed}});assert.equal(preflight.status,204);
        const result=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,model:'unknown'})});
        assert.equal(result.status,400);assert.equal(upstreamCalls,0);
    },async()=>{upstreamCalls++;return json({models:[]});});
});
test('successful HTTP request returns complete JSON only after model release',async()=>{
    const calls=[];
    await fixture(async base=>{
        const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
        assert.equal(response.status,200);
        assert.equal((await response.json()).choices[0].message.content,'{"scene":"station"}');
        assert.deepEqual(calls.map(x=>new URL(x.url).pathname),['/api/chat','/api/ps']);
        assert.equal(calls[0].body.keep_alive,0);assert.equal(calls[0].body.model,config.model);
        const health=await (await fetch(base+'/health')).json();assert.equal(health.active,null);assert.equal(health.last.modelReleased,true);
        assert.equal(JSON.stringify(health.last).includes(input.messages[1].content),false);
    },async(url,options)=>{calls.push({url,body:options.body?JSON.parse(options.body):null});return new URL(url).pathname==='/api/chat'?json({message:{content:'{"scene":"station"}'},done_reason:'stop'}):json({models:[]});});
});
test('disconnect cancels upstream inference and attempts model unload',async()=>{
    let started,aborted,unloaded;
    const start=new Promise(resolve=>started=resolve),abort=new Promise(resolve=>aborted=resolve),unload=new Promise(resolve=>unloaded=resolve);
    await fixture(async base=>{
        const controller=new AbortController();
        const request=fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:controller.signal}).catch(error=>error);
        await start;controller.abort();await request;await abort;await unload;
        let health;
        for(let i=0;i<30;i++){health=await (await fetch(base+'/health')).json();if(!health.active)break;await new Promise(resolve=>setTimeout(resolve,10));}
        assert.equal(health.active,null);assert.match(health.last.error,/取消/);assert.equal(health.last.modelReleased,true);
    },async(url,options)=>{
        const pathname=new URL(url).pathname;
        if(pathname==='/api/chat'){started();return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>{aborted();reject(options.signal.reason);},{once:true});});}
        if(pathname==='/api/generate')unloaded();return json({models:[]});
    });
});
