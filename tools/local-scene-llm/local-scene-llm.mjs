import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {sceneAdapter,normalizeSceneOutput} from './scene-output-adapter.mjs';

export function validateConfig(config){
    if(!config||typeof config.model!=='string'||!config.model.trim())throw Error('Configured model is required');
    if(!Number.isInteger(config.listenPort)||config.listenPort<1||config.listenPort>65535)throw Error('Invalid listenPort');
    const upstream=new URL(config.ollamaUrl);
    if(upstream.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(upstream.hostname)||upstream.username||upstream.password||upstream.pathname!=='/'||upstream.search||upstream.hash)throw Error('Ollama URL must be an HTTP loopback origin');
    for(const key of ['numGpu','numThread','numBatch','numCtx','numPredict'])if(!Number.isInteger(config[key])||config[key]<(key==='numGpu'?0:1))throw Error('Invalid '+key);
    for(const key of ['temperature','maxStageSeconds','startTemperatureC','finishTemperatureC','abortTemperatureC','maxGpuUsedMiB','minSystemFreeGiB'])if(!Number.isFinite(config[key])||config[key]<(key==='temperature'?0:0.001))throw Error('Invalid '+key);
    if(config.startTemperatureC>=config.abortTemperatureC||config.finishTemperatureC>=config.abortTemperatureC)throw Error('Cooling temperatures must be below the abort threshold');
    if(typeof config.think!=='boolean')throw Error('think must be a boolean');
    if(!Array.isArray(config.allowedOrigins)||!config.allowedOrigins.length||config.allowedOrigins.some(origin=>{try{const url=new URL(origin);return !['http:','https:'].includes(url.protocol)||url.origin!==origin;}catch{return true;}}))throw Error('allowedOrigins must contain exact HTTP origins');
    return config;
}
export function loadConfig(configPath=''){
    const directory=path.dirname(fileURLToPath(import.meta.url));
    const local=path.join(directory,'local-scene-config.json');
    const selected=configPath||process.env.RP_SCENE_CONFIG||(fs.existsSync(local)?local:path.join(directory,'local-scene-config.example.json'));
    return validateConfig(JSON.parse(fs.readFileSync(selected,'utf8').replace(/^\uFEFF/,'')));
}

export function makeNativeRequest(input,config){
    if(input.model!==config.model&&input.model!==config.model+':latest')throw Error('请使用已配置的本地剧情模型：'+config.model);
    if(!Array.isArray(input.messages)||!input.messages.length||input.messages.some(m=>!['system','user','assistant'].includes(m.role)||typeof m.content!=='string'))throw Error('剧情消息格式不正确');
    const check='【本地剧情分析输出前复核】人物规范姓名逐字保留中文，不翻译或拼音化；英文指令的专名也逐字复制 visible_characters 的 canonical_name，只有其余描述译为英文。身体在场证据引用包含该人物身份和当前身体动作的完整连续原文。保留否定、先后、左右手和可见范围，区分物品总数与各人的持物数量。指向、伸手、持有和已完成交接不能互换；指向不证明触碰，没有身体接触依据时不能写接触。前、侧、背只是观察方向，不证明半身或特写。剧情模式未指定局部裁切时按原规则完整主角从头到脚入画，保留头饰和脚边余量；已有的局部入镜限制仍优先。不能自创人物画面左右位置。保留项和排除项不能互相矛盾。只在最终回答输出原任务规定的 JSON。';
    const messages=input.messages.map(m=>['system','user'].includes(m.role)?{...m,content:m.content+'\n\n'+check}:m);
    const adapter=sceneAdapter(input);
    if(adapter)for(const message of messages)if(['system','user'].includes(message.role))message.content+='\n\n'+adapter.protocol;
    return {model:config.model,messages,stream:false,think:config.think,keep_alive:0,
        options:{num_gpu:config.numGpu,num_thread:config.numThread,num_batch:config.numBatch,num_ctx:config.numCtx,num_predict:config.numPredict,temperature:config.temperature,repeat_penalty:1.0,top_k:20,top_p:.95},
        ...(adapter?{format:adapter.schema}:input.response_format?.type==='json_object'?{format:'json'}:{})};
}
export function makeOpenAIResult(data,model,id,adapter=null){
    if(data.done_reason==='length')throw Error('本地分析输出达到长度上限，未将不完整的结果送去生图');
    const content=data.message?.content;
    if(typeof content!=='string'||!content.trim())throw Error('本地模型未返回完整分析结果');
    return {id:'chatcmpl-'+id,object:'chat.completion',created:Math.floor(Date.now()/1000),model,
        choices:[{index:0,message:{role:'assistant',content:normalizeSceneOutput(content,adapter)},finish_reason:'stop'}],
        usage:{prompt_tokens:data.prompt_eval_count||0,completion_tokens:data.eval_count||0,total_tokens:(data.prompt_eval_count||0)+(data.eval_count||0)}};
}
export function resourceFailure(sample,config){
    if(sample.temperatureC>=config.abortTemperatureC)return 'GPU 温度达到保护阈值，已停止本次剧情分析';
    if(sample.usedMiB>=config.maxGpuUsedMiB)return 'GPU 显存达到保护阈值，已停止本次剧情分析';
    if(sample.systemFreeGiB<config.minSystemFreeGiB)return '系统可用内存不足，已停止本次剧情分析';
    return '';
}
const exec=promisify(execFile);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function startServer(config,{sampleResources,ollamaFetch=fetch,listenPort=config.listenPort}={}){
    validateConfig(config);
    let active=null,last=null,gpu=null;
    const sample=async()=>{
        const {stdout}=sampleResources?{stdout:''}:await exec('nvidia-smi',['--query-gpu=memory.used,memory.free,temperature.gpu','--format=csv,noheader,nounits'],{windowsHide:true,timeout:5000});
        const measured=sampleResources?await sampleResources():null;
        const [usedMiB,freeMiB,temperatureC]=measured?[measured.usedMiB,measured.freeMiB,measured.temperatureC]:stdout.trim().split(/\r?\n/)[0].split(',').map(Number);
        if(![usedMiB,freeMiB,temperatureC].every(Number.isFinite))throw Error('GPU 监测数据不可用');
        gpu={usedMiB,freeMiB,temperatureC,systemFreeGiB:measured?.systemFreeGiB??os.freemem()/2**30,time:new Date().toISOString()};
        if(active){active.peakGpuUsedMiB=Math.max(active.peakGpuUsedMiB,usedMiB);active.peakTemperatureC=Math.max(active.peakTemperatureC,temperatureC);active.minimumSystemFreeGiB=Math.min(active.minimumSystemFreeGiB,gpu.systemFreeGiB);}
        return gpu;
    };
    const isLoaded=async()=>{
        const response=await ollamaFetch(config.ollamaUrl+'/api/ps',{signal:AbortSignal.timeout(5000)});
        if(!response.ok)throw Error('Ollama 状态不可读');
        const data=await response.json();return data.models.some(m=>m.name===config.model||m.name===config.model+':latest');
    };
    const unload=async()=>{
        await ollamaFetch(config.ollamaUrl+'/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:config.model,stream:false,keep_alive:0}),signal:AbortSignal.timeout(10000)});
    };
    const send=(res,status,value)=>{
        if(res.destroyed)return;
        res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));
    };
    const server=http.createServer(async(req,res)=>{
        const origin=req.headers.origin;
        if(origin&&!config.allowedOrigins.includes(origin)){send(res,403,{error:{message:'此来源未被允许连接本地剧情服务'}});return;}
        if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
        res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
        if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
        if(req.method==='GET'&&req.url==='/v1/models'){send(res,200,{object:'list',data:[{id:config.model,object:'model',owned_by:'local'}]});return;}
        if(req.method==='GET'&&req.url==='/health'){try{await sample();send(res,200,{status:'ready',model:config.model,limits:config,gpu,active,last});}catch(error){send(res,503,{error:{message:error.message}});}return;}
        if(req.method!=='POST'||req.url!=='/v1/chat/completions'){send(res,404,{error:{message:'Unknown endpoint'}});return;}
        if(active){send(res,429,{error:{message:'本地剧情模型正在分析，请等待当前任务结束'}});return;}
        let body,adapter;
        try{const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>2_000_000)throw Error('剧情输入过长');chunks.push(chunk);}const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));adapter=sceneAdapter(input);body=makeNativeRequest(input,config);}catch(error){send(res,400,{error:{message:error.message}});return;}
        // Recheck after reading the body to avoid concurrent requests taking the same slot.
        if(active){send(res,429,{error:{message:'本地剧情模型正在分析'}});return;}
        const controller=new AbortController(),id=Date.now().toString(36);
        active={id,startedAt:new Date().toISOString(),peakGpuUsedMiB:0,peakTemperatureC:0,minimumSystemFreeGiB:os.freemem()/2**30,status:'cooling'};
        const record=active,started=Date.now();let reason='',timer,polling=false,submitted=false;
        const abort=message=>{reason=message;controller.abort();};
        const deadline=setTimeout(()=>abort('本阶段超过 '+config.maxStageSeconds+' 秒，已停止；未将不完整分析送去生图'),config.maxStageSeconds*1000);
        res.on('close',()=>{if(!res.writableEnded)abort('用户已取消本次分析');});
        try{
            while(true){
                if(controller.signal.aborted)throw Error(reason);
                const current=await sample();
                const failure=resourceFailure(current,config);if(failure)throw Error(failure);
                if(current.temperatureC<=config.startTemperatureC&&current.usedMiB<2048)break;
                await wait(1000);
            }
            record.status='analyzing';submitted=true;
            timer=setInterval(async()=>{
                if(polling)return;polling=true;
                try{const failure=resourceFailure(await sample(),config);if(failure)abort(failure);}catch(error){abort('资源监测不可用：'+error.message);}finally{polling=false;}
            },1000);
            const response=await ollamaFetch(config.ollamaUrl+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
            if(!response.ok)throw Error('Ollama HTTP '+response.status+': '+(await response.text()).slice(0,200));
            const data=await response.json();
            const result=makeOpenAIResult(data,config.model,id,adapter);
            record.engineSeconds=data.total_duration/1e9;record.promptTokens=data.prompt_eval_count;record.outputTokens=data.eval_count;record.thinkingCharacters=data.message?.thinking?.length||0;
            if(timer){clearInterval(timer);timer=null;}
            record.status='releasing';
            while(await isLoaded()){
                if(controller.signal.aborted)throw Error(reason);
                await wait(200);
            }
            record.modelReleased=true;record.status='cooling-for-next-task';
            while((await sample()).temperatureC>config.finishTemperatureC){
                if(controller.signal.aborted)throw Error(reason);
                await wait(1000);
            }
            if(controller.signal.aborted)throw Error(reason);
            record.status='success';record.seconds=(Date.now()-started)/1000;
            last={...record};active=null;clearTimeout(deadline);send(res,200,result);
        }catch(error){
            if(timer)clearInterval(timer);
            if(submitted)await unload().catch(()=>{});
            record.status='failed';record.seconds=(Date.now()-started)/1000;record.error=reason||error.message;
            record.modelReleased=!(await isLoaded().catch(()=>true));last={...record};active=null;clearTimeout(deadline);
            send(res,502,{error:{message:record.error}});
        }
        // Operational metrics only. Story text, thinking text, and keys are never logged.
        console.log(JSON.stringify(last));
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(listenPort,'127.0.0.1',resolve);});
    console.log(JSON.stringify({status:'listening',url:'http://127.0.0.1:'+server.address().port+'/v1',model:config.model}));
    return server;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===fs.realpathSync(process.argv[1])){
    const args=process.argv.slice(2),index=args.indexOf('--config');
    if(index>=0&&!args[index+1])throw Error('--config requires a file path');
    const config=loadConfig(index>=0?args[index+1]:'');
    if(args.includes('--check-config'))console.log('Local scene configuration is valid.');
    else await startServer(config);
}
