import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {writeFile,readFile,unlink,mkdir} from "node:fs/promises";

export function runPowerShell(script,{env={},timeout}={}) {
  return promisify(execFile)("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{windowsHide:true,timeout,env:{...process.env,...env}});
}

export const fileShell={
  run:(cmd,args)=>promisify(execFile)(cmd,args,{windowsHide:true}).then(r=>r.stdout),
  ps:script=>runPowerShell(script),
  writeText:(path,text)=>writeFile(path,text,"utf8"),
  readText:path=>readFile(path,"utf8"),
  remove:async path=>{try{await unlink(path);}catch(error){if(error.code!=="ENOENT")throw error;}},
  mkdir:path=>mkdir(path,{recursive:true})
};
