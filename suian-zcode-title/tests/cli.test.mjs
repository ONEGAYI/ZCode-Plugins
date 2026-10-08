import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync,execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
const cli=fileURLToPath(new URL("../cli.mjs",import.meta.url));
test("probe 网关配置缺失时明确报错，不依赖远控链接",()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-gateway-probe-")),config=join(root,"config.json");
  try {
    writeFileSync(config,JSON.stringify({dataDir:join(root,"state"),gatewayConfigPath:join(root,"missing-gateway.json")}));
    const run=spawnSync(process.execPath,[cli,"probe","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_fixture",cwd:"D:\\fixture"}),windowsHide:true});
    assert.equal(run.status,0,run.stderr);
    assert.equal(JSON.parse(run.stdout).reasonCode,"gateway_not_configured");
  } finally {rmSync(root,{recursive:true});}
});
test("CLI 接收会话事件，无正文时跳过；非法事件不回显凭据",()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-cli-")),db=join(root,"session.sqlite"),index=join(root,"index.sqlite"),config=join(root,"config.json");
  const sqliteBin=process.env.SQLITE_BIN||"sqlite3";
  try {
    execFileSync(sqliteBin,[db,"CREATE TABLE session(id,title,directory,path,revert,title_source);CREATE TABLE message(id,session_id,time_created,time_updated,data,sequence);CREATE TABLE part(id,message_id,session_id,time_created,time_updated,data,sequence);INSERT INTO session VALUES('sess_fixture','原名','D:\\fixture',NULL,NULL,'custom');"]);
    execFileSync(sqliteBin,[index,"CREATE TABLE tasks(task_id,workspace_path,title,archived,deleted,task_status);INSERT INTO tasks VALUES('sess_fixture','D:\\fixture','原名',0,0,'completed');"]);
    writeFileSync(config,JSON.stringify({sessionDb:db,indexDb:index,sqliteBin,dataDir:join(root,"state")}));
    const run=spawnSync(process.execPath,[cli,"run","--apply","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_fixture",cwd:"D:\\fixture"}),windowsHide:true});
    assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).status,"empty");
    const invalid=spawnSync(process.execPath,[cli,"run","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"x';DELETE",authorization_url:"private-credential-fixture"}),windowsHide:true});
    assert.equal(invalid.status,1);assert.equal(JSON.parse(invalid.stdout).status,"failed");
    assert.ok(!invalid.stdout.includes("private-credential-fixture"));
  } finally {rmSync(root,{recursive:true});}
});
test("--help 不需要远控凭据，说明 run / doctor / models / probe",()=>{
  const run=spawnSync(process.execPath,[cli,"--help"],{encoding:"utf8",windowsHide:true});
  assert.equal(run.status,0);for(const name of ["run","doctor","models","probe","lock","unlock","policy"])assert.ok(run.stdout.includes(name));
});
test("CLI 实际使用 SQLITE_BIN，显式环境路径无效时不静默改用 PATH",()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-sqlite-env-")),config=join(root,"config.json");
  try {
    const missing=join(root,"missing-sqlite3.exe");
    for(const sqliteBin of [undefined,null]) {
      writeFileSync(config,JSON.stringify({sessionDb:join(root,"session.sqlite"),indexDb:join(root,"index.sqlite"),dataDir:join(root,"state"),sqliteBin}));
      const run=spawnSync(process.execPath,[cli,"run","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_fixture",cwd:"D:\\fixture"}),windowsHide:true,env:{...process.env,SQLITE_BIN:missing,OIL_ZCODE_TITLE_DISABLE_TOAST:"1"}});
      assert.equal(run.status,1);
      const result=JSON.parse(run.stdout);
      assert.equal(result.status,"failed");
      assert.ok(result.error.includes(missing),result.error);
      assert.match(result.error,/ENOENT/);
    }
  } finally {rmSync(root,{recursive:true});}
});
test("auth 子命令加密落盘不回显，unauth 清除",()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-auth-cli-")),config=join(root,"config.json");
  try {
    writeFileSync(config,JSON.stringify({dataDir:join(root,"state"),gatewayConfigPath:join(root,"missing-gateway.json")}));
    const save=spawnSync(process.execPath,[cli,"auth","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_auth",cwd:"D:\\fixture",authorization_url:"https://zcode.z.ai/remote/v4?sid=cli-secret&hash=h&mid=m"}),windowsHide:true});
    assert.equal(save.status,0,save.stderr);
    assert.equal(JSON.parse(save.stdout).status,"auth_saved");
    assert.ok(!save.stdout.includes("cli-secret"),"auth 输出不得回显链接");
    const blob=readFileSync(join(root,"state","remote.blob"),"utf8");
    assert.ok(!blob.includes("cli-secret"),"落盘必须是密文");
    const probe=spawnSync(process.execPath,[cli,"probe","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_auth",cwd:"D:\\fixture"}),windowsHide:true});
    assert.equal(JSON.parse(probe.stdout).reasonCode,"gateway_not_configured","旧授权不应触发官方 terminal 回退");
    const clear=spawnSync(process.execPath,[cli,"unauth","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_auth",cwd:"D:\\fixture"}),windowsHide:true});
    assert.equal(JSON.parse(clear.stdout).status,"auth_cleared");
    const again=spawnSync(process.execPath,[cli,"probe","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_auth",cwd:"D:\\fixture"}),windowsHide:true});
    assert.equal(JSON.parse(again.stdout).reasonCode,"gateway_not_configured");
  } finally {rmSync(root,{recursive:true});}
});
test("status 汇总本地状态，enable/disable 原子修改 enabled 且写前复核",()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-ctl-")),config=join(root,"config.json");
  const env={...process.env};delete env.OIL_ZCODE_REMOTE_URL;delete env.OIL_ZCODE_TITLE_DISABLE_TOAST;
  try {
    writeFileSync(config,JSON.stringify({dataDir:join(root,"state"),selection:{providerId:"p",modelId:"m",options:{reasoningLevel:"low"}}}));
    const status=spawnSync(process.execPath,[cli,"status","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_ctl",cwd:"D:\\fixture"}),windowsHide:true,env});
    assert.equal(status.status,0,status.stderr);
    const parsed=JSON.parse(status.stdout);
    assert.equal(parsed.status,"status");
    assert.equal(parsed.enabled,true);
    assert.equal(parsed.selection.modelId,"m");
    assert.ok(parsed.toast,"status 必须报告 Toast 资产状态");
    assert.ok(!status.stdout.includes("OIL_ZCODE_REMOTE_URL"));
    const off=spawnSync(process.execPath,[cli,"disable","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_ctl",cwd:"D:\\fixture"}),windowsHide:true,env});
    assert.equal(off.status,0,off.stderr);
    assert.equal(JSON.parse(off.stdout).status,"disabled_writing");
    assert.equal(JSON.parse(readFileSync(config,"utf8")).enabled,false,"disable 必须落盘到配置");
    const runOff=spawnSync(process.execPath,[cli,"run","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_ctl",cwd:"D:\\fixture"}),windowsHide:true,env});
    assert.equal(JSON.parse(runOff.stdout).status,"disabled");
    const on=spawnSync(process.execPath,[cli,"enable","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_ctl",cwd:"D:\\fixture"}),windowsHide:true,env});
    assert.equal(JSON.parse(on.stdout).status,"enabled_writing");
    assert.equal(JSON.parse(readFileSync(config,"utf8")).enabled,true);
  } finally {rmSync(root,{recursive:true});}
});
test("status 只报告旧凭据文件存在，不解密或验证其正文",()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-legacy-status-")),state=join(root,"state"),config=join(root,"config.json");
  try {
    mkdirSync(state);writeFileSync(join(state,"remote.blob"),"not-a-dpapi-blob-fixture");
    writeFileSync(config,JSON.stringify({dataDir:state}));
    const status=spawnSync(process.execPath,[cli,"status","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_fixture",cwd:"D:\\fixture"}),windowsHide:true});
    assert.equal(status.status,0,status.stderr);
    const parsed=JSON.parse(status.stdout);
    assert.equal(parsed.transport,"gateway");
    assert.equal(parsed.legacyAuthorizationFilePresent,true);
    assert.equal(Object.hasOwn(parsed,"authorization"),false,"不把旧凭据有效性作为默认连接状态");
    assert.equal(status.stdout.includes("not-a-dpapi-blob-fixture"),false);
  } finally {rmSync(root,{recursive:true});}
});

test("run 网关未配置时给出分层原因且可静音 Toast",()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-clip-")),db=join(root,"session.sqlite"),index=join(root,"index.sqlite"),config=join(root,"config.json");
  const sqliteBin=process.env.SQLITE_BIN||"sqlite3";
  const env={...process.env};delete env.OIL_ZCODE_REMOTE_URL;env.OIL_ZCODE_TITLE_DISABLE_TOAST="1";
  try {
    execFileSync(sqliteBin,[db,"CREATE TABLE session(id,title,directory,path,revert,title_source);CREATE TABLE message(id,session_id,time_created,time_updated,data,sequence);CREATE TABLE part(id,message_id,session_id,time_created,time_updated,data,sequence);INSERT INTO session VALUES('sess_fixture','原名','D:\\fixture',NULL,NULL,'custom');INSERT INTO message VALUES('u1','sess_fixture',1,1,'"+JSON.stringify({role:"user"})+"',1);INSERT INTO part VALUES('p1','u1','sess_fixture',1,1,'"+JSON.stringify({type:"text",text:"改进编辑体验"})+"',1);"]);
    execFileSync(sqliteBin,[index,"CREATE TABLE tasks(task_id,workspace_path,title,archived,deleted,task_status);INSERT INTO tasks VALUES('sess_fixture','D:\\fixture','原名',0,0,'completed');"]);
    writeFileSync(config,JSON.stringify({sessionDb:db,indexDb:index,sqliteBin,dataDir:join(root,"state"),probeTimeoutMs:2000,gatewayConfigPath:join(root,"missing-gateway.json")}));
    const run=spawnSync(process.execPath,[cli,"run","--apply","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_fixture",cwd:"D:\\fixture"}),windowsHide:true,env});
    assert.equal(run.status,1,run.stderr);
    const parsed=JSON.parse(run.stdout);
    assert.equal(parsed.status,"failed");
    assert.equal(parsed.stage,"config");
    assert.equal(parsed.reasonCode,"gateway_not_configured");
    assert.equal(parsed.toast,"disabled","静音变量必须被尊重");
    const logLines=readFileSync(join(root,"state","runner.log.jsonl"),"utf8").trim().split("\n");
    const entry=JSON.parse(logLines[logLines.length-1]);
    assert.equal(entry.command,"run");
    assert.equal(entry.status,"failed");
    assert.equal(entry.reasonCode,"gateway_not_configured");
    assert.ok(entry.durationMs!==undefined,"失败也必须留日志");
    const titles=execFileSync(sqliteBin,["-readonly",index,"SELECT title FROM tasks;"],{encoding:"utf8"});
    assert.ok(titles.includes("原名"),"失败时不得改动标题");
  } finally {rmSync(root,{recursive:true});}
});
test("probe 网关未配置时不建立连接且尊重共享锁",()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-probe-")),config=join(root,"config.json");
  const env={...process.env};delete env.OIL_ZCODE_REMOTE_URL;
  try {
    writeFileSync(config,JSON.stringify({dataDir:join(root,"state"),gatewayConfigPath:join(root,"missing-gateway.json")}));
    const noAuth=spawnSync(process.execPath,[cli,"probe","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_probe_case",cwd:"D:\\fixture"}),windowsHide:true,env});
    assert.equal(noAuth.status,0,noAuth.stderr);
    const parsed=JSON.parse(noAuth.stdout);
    assert.equal(parsed.status,"probe_failed");
    assert.equal(parsed.reasonCode,"gateway_not_configured");
    assert.equal(parsed.ok,false);
    const leaked=spawnSync(process.execPath,[cli,"probe","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_probe_case",cwd:"D:\\fixture",authorization_url:"secret-auth-fixture"}),windowsHide:true,env});
    assert.equal(JSON.parse(leaked.stdout).reasonCode,"gateway_not_configured");
    assert.ok(!leaked.stdout.includes("secret-auth-fixture"),"probe 输出不回显授权链接");
    mkdirSync(join(root,"state"),{recursive:true});
    writeFileSync(join(root,"state","worker.lock"),"{}");
    const busy=spawnSync(process.execPath,[cli,"probe","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_probe_case",cwd:"D:\\fixture"}),windowsHide:true,env});
    assert.equal(busy.status,1);
    assert.ok(JSON.parse(busy.stdout).error.includes("busy"),"持锁时 probe 应让位给命名进程");
  } finally {rmSync(root,{recursive:true});}
});
test("lock/unlock/policy 写公共策略：查询、幂等、读回复核与落盘格式",()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-policy-")),db=join(root,"session.sqlite"),index=join(root,"index.sqlite"),config=join(root,"config.json"),policyDir=join(root,"policy");
  const sqliteBin=process.env.SQLITE_BIN||"sqlite3";
  const invoke=(command,sessionId)=>spawnSync(process.execPath,[cli,command,"--config",config],{encoding:"utf8",input:JSON.stringify({session_id:sessionId,cwd:"D:\\fixture"}),windowsHide:true});
  try {
    execFileSync(sqliteBin,[db,"CREATE TABLE session(id,title,directory,path,revert,title_source);INSERT INTO session VALUES('sess_fixture','原名','D:\\fixture',NULL,NULL,'generated');"]);
    execFileSync(sqliteBin,[index,"CREATE TABLE tasks(task_id,workspace_path,title,archived,deleted,task_status);INSERT INTO tasks VALUES('sess_fixture','D:\\fixture','原名',0,0,'completed');"]);
    writeFileSync(config,JSON.stringify({sessionDb:db,indexDb:index,sqliteBin,dataDir:join(root,"state"),titlePolicyDirectory:policyDir}));
    const before=invoke("policy","sess_fixture");
    assert.equal(before.status,0,before.stderr);
    assert.deepEqual(JSON.parse(before.stdout),{status:"policy",sessionId:"sess_fixture",policy:null},"未设置策略时 policy 为 null");
    const lock=invoke("lock","sess_fixture");
    assert.equal(lock.status,0,lock.stderr);
    assert.deepEqual(JSON.parse(lock.stdout),{status:"locked",sessionId:"sess_fixture",previous:null,policy:{version:1,locked:true}},"首次固定 previous 为 null，policy 透传公共策略结构");
    assert.deepEqual(JSON.parse(readFileSync(join(policyDir,"sess_fixture.json"),"utf8")),{version:1,locked:true},"落盘必须是公共策略 v1 格式");
    const reread=invoke("policy","sess_fixture");
    assert.deepEqual(JSON.parse(reread.stdout).policy,{version:1,locked:true},"查询须反映写入结果");
    const again=invoke("lock","sess_fixture");
    assert.equal(again.status,0,again.stderr);
    assert.deepEqual(JSON.parse(again.stdout),{status:"locked",sessionId:"sess_fixture",previous:{version:1,locked:true},policy:{version:1,locked:true}},"重复固定幂等成功且 previous 如实");
    const unlock=invoke("unlock","sess_fixture");
    assert.equal(unlock.status,0,unlock.stderr);
    assert.deepEqual(JSON.parse(unlock.stdout),{status:"unlocked",sessionId:"sess_fixture",previous:{version:1,locked:true},policy:{version:1,locked:false}},"解除固定返回 previous 与新策略");
    assert.deepEqual(JSON.parse(readFileSync(join(policyDir,"sess_fixture.json"),"utf8")),{version:1,locked:false},"解除固定落盘 locked:false 而非删除文件");
  } finally {rmSync(root,{recursive:true});}
});
test("lock/unlock/policy 目标会话不存在时报错，不静默写策略",()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-policy-missing-")),db=join(root,"session.sqlite"),index=join(root,"index.sqlite"),config=join(root,"config.json"),policyDir=join(root,"policy");
  const sqliteBin=process.env.SQLITE_BIN||"sqlite3";
  const invoke=(command,sessionId)=>spawnSync(process.execPath,[cli,command,"--config",config],{encoding:"utf8",input:JSON.stringify({session_id:sessionId,cwd:"D:\\fixture"}),windowsHide:true});
  try {
    execFileSync(sqliteBin,[db,"CREATE TABLE session(id,title,directory,path,revert,title_source);INSERT INTO session VALUES('sess_other','他者','D:\\fixture',NULL,NULL,'generated');"]);
    execFileSync(sqliteBin,[index,"CREATE TABLE tasks(task_id,workspace_path,title,archived,deleted,task_status);INSERT INTO tasks VALUES('sess_other','D:\\fixture','他者',0,0,'completed');"]);
    writeFileSync(config,JSON.stringify({sessionDb:db,indexDb:index,sqliteBin,dataDir:join(root,"state"),titlePolicyDirectory:policyDir}));
    for(const command of ["lock","unlock","policy"]) {
      const run=invoke(command,"sess_missing");
      assert.equal(run.status,1,run.stderr);
      const parsed=JSON.parse(run.stdout);
      assert.equal(parsed.status,"failed",command+" 对不存在会话必须显式失败");
      assert.ok(parsed.error.includes("不存在"),command+" 的报错须说明目标会话不存在");
    }
    assert.ok(!existsSync(join(policyDir,"sess_missing.json")),"失败后不得残留策略文件");
  } finally {rmSync(root,{recursive:true});}
});
test("lock 双库不可读时上抛失败，不把“查不了”误报为“不存在”",()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-policy-unreadable-")),config=join(root,"config.json"),policyDir=join(root,"policy");
  const sqliteBin=process.env.SQLITE_BIN||"sqlite3";
  try {
    writeFileSync(config,JSON.stringify({sessionDb:join(root,"missing-session.sqlite"),indexDb:join(root,"missing-index.sqlite"),sqliteBin,dataDir:join(root,"state"),titlePolicyDirectory:policyDir}));
    const run=spawnSync(process.execPath,[cli,"lock","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_fixture",cwd:"D:\\fixture"}),windowsHide:true});
    assert.equal(run.status,1,run.stderr);
    const parsed=JSON.parse(run.stdout);
    assert.equal(parsed.status,"failed");
    assert.ok(!parsed.error.includes("不存在"),"查询异常不得误报为会话不存在");
    assert.ok(!existsSync(join(policyDir,"sess_fixture.json")),"查询失败不得写策略");
  } finally {rmSync(root,{recursive:true});}
});
test("run 双库标题不一致时以 index_title_mismatch 显式失败，不弹 Toast",()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-mismatch-")),db=join(root,"session.sqlite"),index=join(root,"index.sqlite"),config=join(root,"config.json");
  const sqliteBin=process.env.SQLITE_BIN||"sqlite3";
  const env={...process.env,OIL_ZCODE_TITLE_DISABLE_TOAST:"1"};delete env.OIL_ZCODE_REMOTE_URL;
  try {
    execFileSync(sqliteBin,[db,"CREATE TABLE session(id,title,directory,path,revert,title_source);CREATE TABLE message(id,session_id,time_created,time_updated,data,sequence);CREATE TABLE part(id,message_id,session_id,time_created,time_updated,data,sequence);INSERT INTO session VALUES('sess_fixture','CLI 库标题','D:\\fixture',NULL,NULL,'generated');INSERT INTO message VALUES('u1','sess_fixture',1,1,'"+JSON.stringify({role:"user"})+"',1);INSERT INTO part VALUES('p1','u1','sess_fixture',1,1,'"+JSON.stringify({type:"text",text:"调研内容"})+"',1);"]);
    execFileSync(sqliteBin,[index,"CREATE TABLE tasks(task_id,workspace_path,title,archived,deleted,task_status);INSERT INTO tasks VALUES('sess_fixture','D:\\fixture','索引标题',0,0,'completed');"]);
    writeFileSync(config,JSON.stringify({sessionDb:db,indexDb:index,sqliteBin,dataDir:join(root,"state"),gatewayConfigPath:join(root,"missing-gateway.json")}));
    const run=spawnSync(process.execPath,[cli,"run","--apply","--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_fixture",cwd:"D:\\fixture"}),windowsHide:true,env});
    assert.equal(run.status,1,run.stderr);
    const parsed=JSON.parse(run.stdout);
    assert.equal(parsed.status,"failed");
    assert.equal(parsed.reasonCode,"index_title_mismatch","双库不一致须带可诊断 reasonCode");
    assert.ok(parsed.error.includes("不一致"));
    assert.equal(parsed.toast,undefined,"本地校验失败不弹 Toast");
  } finally {rmSync(root,{recursive:true});}
});

