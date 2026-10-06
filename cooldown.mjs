import {open,writeFile,rename,unlink,mkdir,readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {join} from "node:path";
import process from "node:process";

export const TOAST_COOLDOWN_SECONDS=7200;
export const STALE_LOCK_MS=30000;

const defaultAlive=pid=>{
  if(pid===process.pid)return true;
  try {process.kill(pid,0);return true;}
  catch(error) {return error.code!=="ESRCH";}
};

const readJson=async path=>{
  try {return JSON.parse(await readFile(path,"utf8"));}
  catch {return null;}
};

export async function shouldNotify({dataDir,now=Date.now}) {
  const stored=await readJson(join(dataDir,"toast-cooldown.json"));
  const last=stored&&Date.parse(stored.lastShownAt);
  if(!Number.isFinite(last))return{allowed:true};
  const nextAllowedAt=last+TOAST_COOLDOWN_SECONDS*1000;
  if(now()<nextAllowedAt)return{allowed:false,reason:"cooldown",lastShownAt:stored.lastShownAt,nextAllowedAt};
  return{allowed:true};
}

export async function markShown({dataDir,now=Date.now,reasonCode}) {
  await mkdir(dataDir,{recursive:true});
  const temporary=join(dataDir,"toast-cooldown.tmp-"+randomUUID());
  await writeFile(temporary,JSON.stringify({lastShownAt:new Date(now()).toISOString(),reasonCode:reasonCode??"unknown"})+"\n","utf8");
  await rename(temporary,join(dataDir,"toast-cooldown.json"));
}

export async function acquireDisplayLock({dataDir,now=Date.now,isProcessAlive=defaultAlive,staleAfterMs=STALE_LOCK_MS}) {
  const lockPath=join(dataDir,"toast.lock");
  await mkdir(dataDir,{recursive:true});
  const tryAcquire=async()=>{
    try {
      const handle=await open(lockPath,"wx");
      await handle.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date(now()).toISOString()})+"\n","utf8");
      await handle.close();
      return{acquired:true,release:async()=>{try{await unlink(lockPath);}catch{}}};
    } catch(error) {
      if(error.code!=="EEXIST")throw error;
      return null;
    }
  };
  let state=await tryAcquire();
  if(!state) {
    const held=await readJson(lockPath);
    const created=held&&Date.parse(held.createdAt);
    if(held&&Number.isFinite(created)&&now()-created>staleAfterMs&&!isProcessAlive(held.pid)) {
      try{await unlink(lockPath);}catch{}
      state=await tryAcquire();
    }
  }
  return state??{acquired:false,reason:"inflight"};
}
