import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {spawn} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const profile=process.argv[2]||'preview';
if(!['preview','production'].includes(profile))throw new Error('Choose preview or production.');
let privateEnv={};
try{privateEnv=parseEnv(await readFile(resolve(root,'.env'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const token=privateEnv.EXPO_TOKEN||process.env.EXPO_TOKEN;
if(!token)throw new Error('Add EXPO_TOKEN to the ignored root .env or your terminal environment.');
const env={...process.env,EXPO_TOKEN:token};
for(const name of Object.keys(privateEnv))if(name!=='EXPO_TOKEN')delete env[name];
const args=['--yes','eas-cli@24.12.1','build','--platform','android','--profile',profile,'--non-interactive','--no-wait','--json'];
const child=process.platform==='win32'
  ?spawn('cmd.exe',['/d','/s','/c','npx.cmd '+args.join(' ')],{cwd:resolve(root,'mobile'),env,stdio:'inherit',windowsHide:true})
  :spawn('npx',args,{cwd:resolve(root,'mobile'),env,stdio:'inherit'});
child.on('error',()=>{console.error('EAS CLI could not start. Install Node.js and npm first.');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
