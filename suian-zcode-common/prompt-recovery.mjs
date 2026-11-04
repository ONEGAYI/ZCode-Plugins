import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

async function queryProtocolCommand() {
  const {stdout}=await promisify(execFile)('reg.exe',['query','HKCU\\Software\\Classes\\suian-zcode-title\\shell\\open\\command','/ve'],{windowsHide:true});
  return /REG_SZ\s+(.+)$/m.exec(stdout)?.[1]?.trim()??null;
}

// 只读核验安装器已登记的目标，不改写身份、启动器、快捷方式或系统注册。
export async function checkPromptRecoveryToast({dataDir,appId,homeDir=homedir(),readProtocolCommand=queryProtocolCommand}) {
  const root=join(homeDir,'.zcode','tools','suian-zcode-common','toast');
  let identity,launcher,forward,executor;
  try {
    const values=await Promise.all([
      readFile(join(root,'identities','suian-zcode-title.json'),'utf8'),
      readFile(join(root,'launch.vbs'),'utf8'),
      readFile(join(dataDir,'toast-launch.vbs'),'utf8'),
      readFile(join(root,'executor.mjs'),'utf8')
    ]);
    try {identity=JSON.parse(values[0]);}catch{return {ready:false,reason:'identity_invalid'};}
    [,launcher,forward,executor]=values;
  } catch(error) {if(error.code==='ENOENT')return {ready:false,reason:'toast_assets_missing'};throw error;}
  const canonical=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
  if(identity?.protocol!=='suian-zcode-title'||typeof identity.dataDir!=='string'||canonical(identity.dataDir)!==canonical(dataDir)||appId&&identity.appId!==appId)return {ready:false,reason:'identity_mismatch'};
  if(!launcher.includes('suian-zcode-title://prompt')||!launcher.includes('suian-zcode-title://mute')||!forward.includes('suian-zcode-title://prompt')||!forward.includes('suian-zcode-title://mute')||!executor.includes('PROMPT_RECOVERY_TOAST_CAPABILITY=1'))return {ready:false,reason:'toast_assets_outdated'};
  const quoted=path=>`"${path.replace(/"/g,'""')}"`;
  if(!forward.includes(quoted(join(root,'launch.vbs')))||!launcher.includes(quoted(join(root,'executor.mjs'))))return {ready:false,reason:'toast_assets_misdirected'};
  let registered;
  try {registered=await readProtocolCommand();}catch{return {ready:false,reason:'protocol_unavailable'};}
  const expected=`wscript.exe "${join(dataDir,'toast-launch.vbs')}" "%1"`;
  if(typeof registered!=='string'||registered.toLowerCase()!==expected.toLowerCase())return {ready:false,reason:'protocol_mismatch'};
  return {ready:true};
}
