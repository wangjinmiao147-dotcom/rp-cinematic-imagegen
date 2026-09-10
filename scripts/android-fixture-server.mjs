import http from 'node:http';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=','base64');
http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(!url.pathname.startsWith('/cors-denied')){
        res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:8000');
        res.setHeader('Access-Control-Allow-Methods','POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers','authorization,content-type');
    }
    if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
    if(url.pathname==='/reference.png'){res.setHeader('content-type','image/png');return res.end(png);}
    if(url.pathname==='/expired.png'){res.writeHead(410);return res.end('expired');}
    if(url.pathname.includes('/images/generations'))console.log('GENERATIONS_REQUEST '+url.pathname);
    const parts=[];for await(const chunk of req)parts.push(chunk);
    const body=Buffer.concat(parts).toString();
    if(url.pathname.includes('/images/edits')&&!body.includes('filename="reference.png"')){res.writeHead(400);return res.end('missing multipart image');}
    const status=Number(url.pathname.split('/')[1])||200;res.writeHead(status,{'content-type':'application/json'});
    res.end(JSON.stringify(status===200?{data:[{b64_json:png.toString('base64') }]}:{error:{message:'fixture edits rejection'}}));
}).listen(18765,'127.0.0.1',()=>console.log('PHONE_TEST_SERVER_READY'));
