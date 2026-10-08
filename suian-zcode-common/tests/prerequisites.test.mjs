import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkRuntime } from '../prerequisites.mjs';

test('SQLite 安装检查实际验证只读 JSON 查询，使用指定的带空格程序路径',async()=>{
  const calls=[];
  const result=await checkRuntime({sqliteBin:'D:/SQLite tools/sqlite3.exe',run:async(command,args,options)=>{calls.push({command,args,options});return '[{"ready":1}]';}});
  assert.equal(result.sqlite_bin,'D:/SQLite tools/sqlite3.exe');
  assert.equal(calls.length,1);
  assert.equal(calls[0].command,result.sqlite_bin);
  assert.deepEqual(calls[0].args.slice(0,3),['-readonly','-json',':memory:']);
  assert.match(calls[0].args[3],/json_extract/);
  assert.equal(calls[0].options.timeout,5000);
});

test('SQLite 缺失、选项不兼容与无效输出都明确失败，并保留原因',async()=>{
  const failures=[Object.assign(new Error('spawn sqlite3 ENOENT'),{code:'ENOENT'}),new Error('unknown option: -json')];
  for(const failure of failures) {
    await assert.rejects(checkRuntime({sqliteBin:'fixture',run:async()=>{throw failure;}}),error=>{
      assert.match(error.message,/sqlite3 CLI/);
      assert.match(error.message,/sqliteBin \/ SQLITE_BIN/);
      assert.equal(error.cause,failure);
      return true;
    });
  }
  for(const output of ['not JSON','[{"ready":0}]'])
    await assert.rejects(checkRuntime({sqliteBin:'fixture',run:async()=>output}),/sqlite3 CLI/);
});

test('公共 npm 依赖缺失时明确提示 npm ci，不把检查报为成功',async t=>{
  const root=await mkdtemp(join(tmpdir(),'zcode-missing-common-deps-'));
  t.after(()=>rm(root,{recursive:true}));
  for(const name of ['prerequisites.mjs','windows.mjs'])await copyFile(new URL('../'+name,import.meta.url),join(root,name));
  const probe=join(root,'probe.mjs');
  await writeFile(probe,`import {checkRuntime} from ${JSON.stringify(pathToFileURL(join(root,'prerequisites.mjs')).href)};await checkRuntime();`);
  await assert.rejects(promisify(execFile)(process.execPath,[probe],{windowsHide:true}),error=>{
    assert.match(error.stderr,/suian-zcode-common/);
    assert.match(error.stderr,/npm ci/);
    return true;
  });
});
