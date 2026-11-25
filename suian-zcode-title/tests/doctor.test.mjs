import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../doctor.mjs';
import { buildHookCommand } from '../installer.mjs';

test('doctor 读取已安装 Stop Hook，配置就绪不表示已经真实触发', async t => {
  const root = await mkdtemp(join(tmpdir(), 'z-title-doctor-'));
  t.after(() => rm(root, { recursive: true }));
  const configFile = join(root, 'user-config.json'), pluginRoot = 'D:\\plugin';
  const command = buildHookCommand({ pluginRoot });
  const backend = {
    read: async () => ({ title: '测试标题', turnCount: 5, context: { recent_turns: [1, 2, 3] } }),
    models: async () => ({ providers: [{ providerId: 'fixture' }] })
  };
  const options = { backend, event: { session_id: 'sess_fixture' }, config: {}, pluginRoot, configFile };
  const write = value => writeFile(configFile, JSON.stringify(value));
  await write({ hooks: { enabled: true, events: { Stop: [{ hooks: [{ type: 'command', command, async: true }] }] } } });
  const before = await readFile(configFile, 'utf8');
  const ready = await runDoctor(options);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.hook, 'configured');
  assert.equal(ready.hookDetails.enabled, true);
  assert.equal(ready.hookDetails.async, true);
  assert.equal(ready.hookDetails.execution, 'not_verified');
  assert.equal(ready.hookDetails.configFile, configFile);
  assert.equal(ready.selectedTurns, 3);
  assert.equal(await readFile(configFile, 'utf8'), before);

  for (const globalDisabled of [true, false]) {
    await write({ hooks: { enabled: !globalDisabled, events: { Stop: [{ hooks: [{ type: 'command', command, async: true, enabled: globalDisabled }] }] } } });
    const disabled = await runDoctor(options);
    assert.equal(disabled.status, 'not_ready');
    assert.equal(disabled.hook, 'disabled');
  }
  await write({ hooks: { events: { Stop: [{ hooks: [{ type: 'command', command, async: true }] }] } } });
  assert.equal((await runDoctor(options)).status, 'ready', 'enabled 省略时遵循官方默认启用');
  assert.equal((await runDoctor({ ...options, config: { enabled: false } })).status, 'not_ready');

  await write({ hooks: { events: { Stop: [{ hooks: [{ type: 'command', command, async: false }] }] } } });
  const foreground = await runDoctor(options);
  assert.equal(foreground.hook, 'configured');
  assert.equal(foreground.hookDetails.async, false);
  assert.equal(foreground.status, 'not_ready');

  await write({ hooks: { events: { Stop: [{ hooks: [{ type: 'command', command: 'node other-plugin/hook.mjs', async: true }] }] } } });
  assert.equal((await runDoctor(options)).hook, 'not_configured');
  await rm(configFile);
  const missing = await runDoctor(options);
  assert.equal(missing.hook, 'not_configured');
  assert.equal(missing.status, 'not_ready');
  await writeFile(configFile, '{invalid');
  await assert.rejects(runDoctor(options), SyntaxError);
});

test('原生 doctor 检查插件 Hook 定义，区分静态配置和实际加载',async t=>{
  const pluginRoot=await mkdtemp(join(tmpdir(),'z-title-native-doctor-'));
  t.after(()=>rm(pluginRoot,{recursive:true}));
  const configFile=join(pluginRoot,'user.json'),hookFile=join(pluginRoot,'hooks','hooks.json');
  await mkdir(join(pluginRoot,'hooks'));
  await writeFile(configFile,'{}');
  await writeFile(hookFile,JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'node "${ZCODE_PLUGIN_ROOT}/hook.mjs"',async:true}]}]}}));
  const backend={read:async()=>({title:'fixture',turnCount:1,context:{recent_turns:[]}}),models:async()=>({providers:[]})};
  const result=await runDoctor({backend,event:{session_id:'sess_fixture'},config:{registration:'native'},pluginRoot,configFile});
  assert.equal(result.status,'ready');
  assert.equal(result.hookDetails.source,'plugin');
  assert.equal(result.hookDetails.configFile,hookFile);
  assert.equal(result.hookDetails.activation,'not_verified');
  assert.equal(result.hookDetails.execution,'not_verified');
  await writeFile(configFile,'{"plugins":{"enabled":false}}');
  assert.equal((await runDoctor({backend,event:{session_id:'sess_fixture'},config:{registration:'native'},pluginRoot,configFile})).status,'not_ready');
});

test('远端 doctor 只有可用的模型档位和已登记的会话才静态就绪',async t=>{
  const pluginRoot=await mkdtemp(join(tmpdir(),'z-title-source-doctor-'));
  t.after(()=>rm(pluginRoot,{recursive:true}));
  const configFile=join(pluginRoot,'user.json');
  await mkdir(join(pluginRoot,'hooks'));
  await writeFile(configFile,'{}');
  await writeFile(join(pluginRoot,'hooks','hooks.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',async:true}]}]}}));
  const selection={providerId:'fixture',modelId:'naming',options:{reasoningLevel:'low'}};
  const view={providers:[{providerId:'fixture',models:[{modelId:'naming',config:{optionSpecs:{reasoningLevel:{values:['low']}}}}]}]};
  const check=(selected,sourceTaskMissing=false)=>runDoctor({
    pluginRoot,configFile,event:{session_id:'sess_fixture'},config:{registration:'native',transport:'source-server',selection:selected},
    backend:{read:async()=>({title:'fixture',turnCount:1,context:{recent_turns:[]},sourceTaskMissing}),models:async()=>view},
  });
  for(const [selected,missing,expected] of [
    [undefined,false,'naming_selection_missing'],
    [{...selection,modelId:'removed'},false,'naming_model_unavailable'],
    [{...selection,options:{reasoningLevel:'removed'}},false,'naming_model_unavailable'],
    [selection,true,'source_task_unindexed'],
  ]) {
    const result=await check(selected,missing);
    assert.equal(result.status,'not_ready',expected);
    assert.equal(result.reasonCode,expected);
  }
  const ready=await check(selection);
  assert.equal(ready.status,'ready');
  assert.equal(ready.hookDetails.execution,'not_verified');
});
