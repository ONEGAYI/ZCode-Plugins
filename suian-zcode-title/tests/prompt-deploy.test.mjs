import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import * as fs from "node:fs/promises";
import {deployNamingPrompt} from "../prompt-deploy.mjs";

test("部署外置提示词，版本升级与损坏恢复均保留旧文件",async t=>{
  const root=await mkdtemp(join(tmpdir(),"z-title-prompt-"));
  t.after(()=>rm(root,{recursive:true}));
  const mirror=join(root,"mirror.md"),dataDir=join(root,"data");
  await writeFile(mirror,"---\nversion: 1\n---\n默认正文\n");
  const first=await deployNamingPrompt({dataDir,mirror});
  assert.equal(first.action,"deployed");assert.equal(first.prompt,"默认正文\n");
  await writeFile(first.path,"---\nname: 自定义\nversion: -3 # 锁定更新\nnotes: [保留, 字段]\n---\n自定义\n");
  await writeFile(mirror,"---\nversion: 2\n---\n新正文\n");
  assert.equal((await deployNamingPrompt({dataDir,mirror})).prompt,"自定义\n");
  await writeFile(first.path,"---\nversion: 1\n---\n旧正文\n");
  const upgrade=await deployNamingPrompt({dataDir,mirror});
  assert.equal(upgrade.action,"upgraded");assert.match(await readFile(upgrade.backupPath,"utf8"),/旧正文/);
  await writeFile(first.path,"损坏");
  const restored=await deployNamingPrompt({dataDir,mirror});
  assert.equal(restored.action,"restored");assert.equal(restored.prompt,"新正文\n");
  assert.equal(await readFile(restored.backupPath,"utf8"),"损坏");
  await writeFile(first.path,"---\nversion: -99999999999999999999999999\n---\n锁定正文\n");
  assert.equal((await deployNamingPrompt({dataDir,mirror})).prompt,"锁定正文\n");
  await writeFile(first.path,"---\nversion: 2\nversion: 3\n---\n重复版本\n");
  const duplicate=await deployNamingPrompt({dataDir,mirror});
  assert.equal(duplicate.action,"restored");assert.match(await readFile(duplicate.backupPath,"utf8"),/重复版本/);
  assert.equal((await readdir(dataDir)).filter(name=>name.startsWith("naming-prompt.md.backup")).length,1);
  assert.equal(duplicate.backupPath,upgrade.backupPath);
  await writeFile(first.path,"---\nversion: -1#不是注释\n---\n正文\n");
  assert.equal((await deployNamingPrompt({dataDir,mirror})).action,"restored");
});

test("恢复前要求通知能力，拒绝时保留原文件；引号 version 键及重复键按契约处理",async t=>{
  const root=await mkdtemp(join(tmpdir(),"z-title-prompt-cap-"));t.after(()=>rm(root,{recursive:true}));
  const mirror=join(root,"mirror.md"),dataDir=join(root,"data");
  await writeFile(mirror,"---\nversion: 2\n---\n默认\n");
  const first=await deployNamingPrompt({dataDir,mirror});
  await writeFile(first.path,'---\n"version": -1\n---\n用户正文\n');
  assert.equal((await deployNamingPrompt({dataDir,mirror})).prompt,"用户正文\n");
  await writeFile(first.path,'---\n"version": 1\nversion: 2\n---\n用户正文\n');
  await assert.rejects(deployNamingPrompt({dataDir,mirror,requireRecoveryCapability:async()=>{throw Error("请升级 common");}}),/请升级 common/);
  assert.match(await readFile(first.path,"utf8"),/"version": 1/);
});

for(const [stage,prior] of [["首次部署",null],["升级","---\nversion: 1\n---\n旧提示词\n"],["恢复","损坏旧稿"]]) {
  test(`${stage}在最后一次校验后并发保存，不覆盖用户稿和已有滚动备份`,async t=>{
    const root=await mkdtemp(join(tmpdir(),"z-title-prompt-race-"));t.after(()=>rm(root,{recursive:true}));
    const mirror=join(root,"mirror.md"),dataDir=join(root,"data"),path=join(dataDir,"naming-prompt.md"),backup=path+".backup";
    const userSaved="---\nversion: -1\n---\n用户刚保存的正文\n";
    await fs.mkdir(dataDir);
    await writeFile(mirror,"---\nversion: 2\n---\n默认正文\n");
    await writeFile(backup,"此前的滚动备份");
    if(prior!==null)await writeFile(path,prior);
    let saved=false;
    const saveOnce=async()=>{
      if(saved)return;
      saved=true;
      const edited=join(dataDir,"editor-save.tmp");
      await writeFile(edited,userSaved);
      await fs.rename(edited,path);
    };
    const io={...fs,
      rename:async(from,to)=>{if(from===path||to===path)await saveOnce();return fs.rename(from,to);},
      link:async(from,to)=>{if(to===path)await saveOnce();return fs.link(from,to);},
    };
    await assert.rejects(deployNamingPrompt({dataDir,mirror,io}),{reasonCode:"prompt_changed"});
    assert.equal(saved,true);
    assert.equal(await readFile(path,"utf8"),userSaved);
    assert.equal(await readFile(backup,"utf8"),"此前的滚动备份");
    assert.deepEqual((await readdir(dataDir)).sort(),["naming-prompt.md","naming-prompt.md.backup"]);
  });
}

test("原稿已移走后编辑器抢先写入时不覆盖，冲突错误指出保留下来的原稿位置",async t=>{
  const root=await mkdtemp(join(tmpdir(),"z-title-prompt-collision-"));t.after(()=>rm(root,{recursive:true}));
  const mirror=join(root,"mirror.md"),dataDir=join(root,"data"),path=join(dataDir,"naming-prompt.md");
  await fs.mkdir(dataDir);
  await writeFile(mirror,"---\nversion: 2\n---\n默认正文\n");
  await writeFile(path,"被移走的损坏稿");
  await writeFile(path+".backup","更早的备份");
  const userSaved="---\nversion: -1\n---\n用户在换入前保存\n";
  const io={...fs,link:async(from,to)=>{
    if(to===path&&!(await readdir(dataDir)).includes("naming-prompt.md"))await writeFile(path,userSaved,{flag:"wx"});
    return fs.link(from,to);
  }};
  await assert.rejects(deployNamingPrompt({dataDir,mirror,io}),asyncError=>
    asyncError.reasonCode==="prompt_changed"&&typeof asyncError.recoveryPath==="string"&&asyncError.message.includes(asyncError.recoveryPath));
  assert.equal(await readFile(path,"utf8"),userSaved);
  assert.equal(await readFile(path+".backup","utf8"),"更早的备份");
  const saved=(await readdir(dataDir)).filter(name=>name.startsWith(".naming-prompt-backup-"));
  assert.equal(saved.length,1);
  assert.equal(await readFile(join(dataDir,saved[0]),"utf8"),"被移走的损坏稿");
});

test("编辑器的已打开句柄在换入前写完时，实际保存内容进入滚动备份并报告冲突",async t=>{
  const root=await mkdtemp(join(tmpdir(),"z-title-prompt-open-writer-"));t.after(()=>rm(root,{recursive:true}));
  const mirror=join(root,"mirror.md"),dataDir=join(root,"data"),path=join(dataDir,"naming-prompt.md");
  await fs.mkdir(dataDir);
  await writeFile(mirror,"---\nversion: 2\n---\n默认正文\n");
  await writeFile(path,"损坏旧稿");
  const userSaved="---\nversion: -1\n---\n编辑器句柄写入\n";
  const editor=await fs.open(path,"r+");
  try {
    const io={...fs,link:async(from,to)=>{
      if(to===path&&!from.includes(".naming-prompt-backup-")){
        await editor.truncate();
        await editor.writeFile(userSaved);
      }
      return fs.link(from,to);
    }};
    await assert.rejects(deployNamingPrompt({dataDir,mirror,io}),error=>error.reasonCode==="prompt_changed"&&error.recoveryPath===path+".backup");
  } finally {await editor.close();}
  assert.equal(await readFile(path+".backup","utf8"),userSaved);
});

test("旧 common 或错误通知身份均阻止恢复覆盖",async()=>{
  const {requirePromptRecoveryToast}=await import('../prompt-deploy.mjs');
  assert.equal(typeof requirePromptRecoveryToast,'function');
  await assert.rejects(requirePromptRecoveryToast({common:{},dataDir:'fixture',disabled:true}),{reasonCode:'prompt_recovery_common_upgrade_required'});
  await assert.rejects(requirePromptRecoveryToast({common:{checkPromptRecoveryToast:async()=>({ready:false,reason:'identity_mismatch'})},dataDir:'fixture'}),{reasonCode:'prompt_recovery_toast_unavailable'});
});
test("恢复预检期间本地稿变化时不覆盖，换入失败保留旧滚动备份",async t=>{
  const root=await mkdtemp(join(tmpdir(),"z-title-prompt-transaction-"));t.after(()=>rm(root,{recursive:true}));
  const mirror=join(root,"mirror.md"),dataDir=join(root,"data");
  await writeFile(mirror,"---\nversion: 2\n---\n默认\n");
  const first=await deployNamingPrompt({dataDir,mirror});
  await writeFile(first.path,"损坏旧稿");
  await assert.rejects(deployNamingPrompt({dataDir,mirror,requireRecoveryCapability:async()=>writeFile(first.path,"---\nversion: -1\n---\n用户修复\n")}),{reasonCode:"prompt_changed"});
  assert.match(await readFile(first.path,"utf8"),/用户修复/);
  await writeFile(first.path,"损坏当前稿");
  const backupPath=join(dataDir,"naming-prompt.md.backup");await writeFile(backupPath,"更早的备份");
  const io={...fs,link:async(from,to)=>{
    if(to===first.path&&!from.includes(".naming-prompt-backup-"))throw Object.assign(Error('模拟换入失败'),{code:'EACCES'});
    return fs.link(from,to);
  }};
  await assert.rejects(deployNamingPrompt({dataDir,mirror,io}),/模拟换入失败/);
  assert.equal(await readFile(first.path,"utf8"),"损坏当前稿");assert.equal(await readFile(backupPath,"utf8"),"更早的备份");
  const backupIo={...fs,rename:async(from,to)=>{if(to===backupPath)throw Object.assign(Error('模拟备份失败'),{code:'EACCES'});return fs.rename(from,to);}};
  await assert.rejects(deployNamingPrompt({dataDir,mirror,io:backupIo}),error=>error.reasonCode==='prompt_backup_commit_failed'&&error.message.includes(dataDir));
  assert.match(await readFile(first.path,'utf8'),/默认/);assert.equal(await readFile(backupPath,'utf8'),"更早的备份");
  const staged=(await readdir(dataDir)).filter(name=>name.startsWith('.naming-prompt-backup-'));
  assert.equal(staged.length,1);assert.equal(await readFile(join(dataDir,staged[0]),'utf8'),"损坏当前稿");
});
