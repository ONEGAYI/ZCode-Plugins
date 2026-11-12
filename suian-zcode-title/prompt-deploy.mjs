import {readFile,mkdir,writeFile,link,rename,unlink,rm} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";

export const NAMING_PROMPT_FILE="naming-prompt.md";

export async function requirePromptRecoveryToast({common,dataDir,appId,disabled=false}) {
  if(typeof common.checkPromptRecoveryToast!=="function")throw Object.assign(new Error("公共插件缺少提示词恢复通知能力，请升级 common 并运行 setup；原提示词未覆盖"),{reasonCode:"prompt_recovery_common_upgrade_required"});
  if(disabled)return;
  const checked=await common.checkPromptRecoveryToast({dataDir,appId});
  if(!checked.ready)throw Object.assign(new Error(`提示词恢复通知资产未就绪（${checked.reason}），请运行 setup；原提示词未覆盖`),{reasonCode:"prompt_recovery_toast_unavailable"});
}

function parsePrompt(bytes) {
  let text;
  try {text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);} catch {return null;}
  if(!text.startsWith("---\n")&&!text.startsWith("---\r\n"))return null;
  const match=/^---\r?\n([\s\S]*?)^---[ \t]*\r?\n([\s\S]*)$/m.exec(text);
  if(!match||!match[2].trim())return null;
  const key=/^(?:version|"version"|'version')[ \t]*:/;
  const lines=match[1].split(/\r?\n/).filter(line=>key.test(line));
  if(lines.length!==1)return null;
  const version=/^(?:version|"version"|'version')[ \t]*:[ \t]*([+-]?\d+)(?:[ \t]+#.*|[ \t]*)$/.exec(lines[0]);
  if(!version)return null;
  return {version:BigInt(version[1]),prompt:match[2]};
}

// 在调用方 worker 锁内运行，其他命令不读取或修复提示词。
export async function deployNamingPrompt({dataDir,mirror,requireRecoveryCapability=async()=>{},io={readFile,mkdir,writeFile,link,rename,unlink,rm}}) {
  const {readFile,mkdir,writeFile,link,rename,unlink,rm}=io;
  const source=await readFile(mirror),sourcePrompt=parsePrompt(source);
  if(!sourcePrompt)throw new Error("内置命名提示词镜像无效");
  const path=join(dataDir,NAMING_PROMPT_FILE);
  await mkdir(dataDir,{recursive:true});
  let local;
  try {local=await readFile(path);} catch(error) {if(error.code!=="ENOENT")throw error;}
  const parsed=local?parsePrompt(local):null;
  if(parsed&&(parsed.version<0n||parsed.version>=sourcePrompt.version))return {action:"unchanged",path,prompt:parsed.prompt};
  const action=!local?"deployed":parsed?"upgraded":"restored";
  if(action==="restored")await requireRecoveryCapability();
  const backupPath=local?join(dataDir,`${NAMING_PROMPT_FILE}.backup`):undefined;
  const temporaryBackup=local?join(dataDir,`.naming-prompt-backup-${randomUUID()}.tmp`):undefined;
  const temporary=join(dataDir,`.naming-prompt-${randomUUID()}.tmp`);
  const changed=(recoveryPath,cause)=>Object.assign(new Error(
    `命名提示词在部署期间发生变化，本轮跳过${recoveryPath?`；并发前稿保留于 ${recoveryPath}`:""}`,{cause}),
  {reasonCode:"prompt_changed",...(recoveryPath?{recoveryPath}:{})});
  try {
    await writeFile(temporary,source,{flag:"wx"});
    if(local) {
      // 先用硬链接占住同目录的临时备份名，确认文件系统支持无覆盖发布，再搬走实际前稿。
      await link(temporary,temporaryBackup);
      try {await rename(path,temporaryBackup);}
      catch(error) {
        await unlink(temporaryBackup);
        throw error.code==="ENOENT"?changed(undefined,error):error;
      }
    }
    try {
      if(local&&!(await readFile(temporaryBackup)).equals(local))throw changed();
      // 普通编辑器不参与 worker 锁：link 只在目标不存在时发布，绝不覆盖后来出现的稿。
      await link(temporary,path);
    } catch(error) {
      if(local) {
        try {await link(temporaryBackup,path);}
        catch(restoreError) {
          const cause=new AggregateError([error,restoreError]);
          if(restoreError.code==="EEXIST")throw changed(temporaryBackup,cause);
          throw Object.assign(new Error(`命名提示词未能恢复原路径；前稿保留于 ${temporaryBackup}`,{cause}),
            {reasonCode:"prompt_rollback_failed",recoveryPath:temporaryBackup});
        }
        await unlink(temporaryBackup);
      }
      throw error.code==="EEXIST"?changed(undefined,error):error;
    }
    if(local) {
      try {await rename(temporaryBackup,backupPath);}
      catch(error) {throw Object.assign(new Error(`命名提示词已换入，但备份提交失败；前稿保留于 ${temporaryBackup}`),{reasonCode:"prompt_backup_commit_failed",cause:error});}
      // 旧文件句柄可能仍在写；备份保留的是同一文件，不是较早时刻的字节副本。
      if(!(await readFile(backupPath)).equals(local))throw changed(backupPath);
    }
  } finally {await rm(temporary,{force:true});}
  // 模型始终读取部署副本，确保写入后 I/O 失败不会被镜像掩盖。
  const actual=parsePrompt(await readFile(path));
  if(!actual)throw new Error("部署后的命名提示词无效");
  return {action,path,backupPath,prompt:actual.prompt};
}
