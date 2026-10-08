import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync,execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from "node:fs";
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
  assert.equal(run.status,0);for(const name of ["run","doctor","models","probe"])assert.ok(run.stdout.includes(name));
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

