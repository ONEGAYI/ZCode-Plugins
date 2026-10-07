#!/usr/bin/env node
import {appendFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import {homedir} from "node:os";
import {fileURLToPath,pathToFileURL} from "node:url";
import {buildFixPrompt} from "./toast.mjs";
import {copyPromptAndOpenWorkspace} from "../suian-zcode-common/notification-action.mjs";

export function parseActionUri(uri) {
  const match=/^suian-zcode-title:\/\/([a-z]+)$/i.exec(String(uri??""));
  return match?{action:match[1].toLowerCase()}:null;
}

export async function runAction({uri,pluginRoot,dataDir,workspacePath,setClipboard,openWorkspace}) {
  const parsed=parseActionUri(uri);
  if(!parsed)return{ok:false,reason:"invalid_uri"};
  if(parsed.action!=="fix")return{ok:false,reason:"unknown_action"};
  await copyPromptAndOpenWorkspace({prompt:buildFixPrompt({pluginRoot,dataDir}),dataDir,workspacePath,setClipboard,openWorkspace});
  return{ok:true,action:"fix"};
}

const isMain=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(isMain) {
  const pluginRoot=dirname(fileURLToPath(import.meta.url));
  const dataDir=process.argv[3]??process.env.OIL_ZCODE_TITLE_DATA??join(homedir(),".zcode","suian-zcode-title");
  const logAction=entry=>appendFile(join(dataDir,"toast-action-log.jsonl"),JSON.stringify({at:new Date().toISOString(),...entry})+"\n","utf8").catch(()=>{});
  runAction({uri:process.argv[2],pluginRoot,dataDir})
    .then(async result=>{
      console.log(JSON.stringify(result));
      await logAction({uri:process.argv[2],ok:result.ok,reason:result.reason??null});
      process.exit(result.ok?0:1);
    })
    .catch(async error=>{
      console.log(JSON.stringify({ok:false,reason:"error",detail:error.message}));
      await logAction({uri:process.argv[2],ok:false,reason:"error",detail:String(error.message).slice(0,200)});
      process.exit(1);
    });
}
