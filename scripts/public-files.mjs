import fs from 'node:fs';
import path from 'node:path';
export function publicSourceFiles(root){
    const files=['.gitattributes','.gitignore','README.md','CHANGELOG.md','LICENSE','THIRD_PARTY_NOTICES.md','CONTRIBUTING.md','SECURITY.md','manifest.json','index.js','style.css','package.json','package-lock.json'];
    const walk=relative=>{
        for(const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){
            if(['node_modules','runtime','models'].includes(entry.name))continue;
            const child=relative+'/'+entry.name;
            if(child==='tools/local-scene-llm/local-scene-config.json')continue;
            if(entry.isSymbolicLink())throw Error('Symbolic link is not a release input: '+child);
            if(entry.isDirectory())walk(child);else files.push(child);
        }
    };
    for(const folder of ['.github','docs','installers','scripts','src','tests','tools/local-scene-llm'])walk(folder);
    return files.sort();
}
export function auditPublicFiles(root,files){
    const issues=[];
    const patterns=[
        ['API key',/sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}/g],
        ['GitHub token',/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g],
        ['AWS key',/AKIA[0-9A-Z]{16}/g],
        ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
        ['machine path',/(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![\\/])/g],
    ];
    for(const file of files){
        if(/(^|\/)(?:\.env(?:\.|$)|settings\.json$|local-scene-config\.json$|debug.*\.mjs$|executeGenerationTask_body.*|tests?_out(?:put)?.*|backup[^/]*|chat[^/]*\.jsonl$)|\.(?:gguf|safetensors|ckpt|pth|zip|log|pem|p12|pfx)$/i.test(file))issues.push({file,risk:'forbidden release input'});
        const content=fs.readFileSync(path.join(root,file),'utf8');
        for(const [risk,pattern] of patterns){pattern.lastIndex=0;if(pattern.test(content))issues.push({file,risk});}
    }
    return issues;
}
