import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {writeFile,readFile,unlink,mkdir} from "node:fs/promises";
import {join} from "node:path";

const psRun=async(script,env={})=>{
  const {stdout}=await promisify(execFile)("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{windowsHide:true,env:{...process.env,...env}});
  return stdout;
};

// 授权链接仅以当前用户 DPAPI 密文落盘；明文只在函数返回值中存在，不写日志与配置。
export async function saveAuthorization({dataDir,url}) {
  if(!/^https:\/\/zcode\.z\.ai\/remote\//.test(url??""))throw new Error("拒绝保存非官方远控链接");
  await mkdir(dataDir,{recursive:true});
  const stdout=await psRun([
    "Add-Type -AssemblyName System.Security",
    "$enc=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:OIL_SECRET), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($enc)"
  ].join(";"),{OIL_SECRET:url});
  await writeFile(join(dataDir,"remote.blob"),stdout.trim(),"utf8");
  return{ok:true};
}

export async function loadAuthorization({dataDir}) {
  let blob;
  try {blob=(await readFile(join(dataDir,"remote.blob"),"utf8")).trim();}
  catch {return null;}
  try {
    const stdout=await psRun([
      "Add-Type -AssemblyName System.Security",
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
      "$dec=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:OIL_BLOB), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[Text.Encoding]::UTF8.GetString($dec)"
    ].join(";"),{OIL_BLOB:blob});
    const url=stdout.replace(/\r\n$/,"");
    return /^https:\/\/zcode\.z\.ai\/remote\//.test(url)?url:null;
  } catch {
    throw new Error("DPAPI 解密失败：remote.blob 不是当前用户的有效密文");
  }
}

export async function clearAuthorization({dataDir}) {
  await unlink(join(dataDir,"remote.blob")).catch(()=>{});
  return{ok:true};
}

