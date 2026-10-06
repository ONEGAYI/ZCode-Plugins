import test from "node:test";
import assert from "node:assert/strict";
import {parseActionUri,runAction,encodeWorkspaceOpenUri,defaultFixWorkspace} from "../toast-action.mjs";
import {homedir} from "node:os";
import {join} from "node:path";
// 注意：runAction 的真实默认 openWorkspace 会弹 ZCode 官方确认模态框；测试一律注入 mock，严禁触达真实打开链路。
test("协议处理器解析 fix 动作：先复制提示词再打开默认工作区",async()=>{
  const did=[];
  const result=await runAction({
    uri:"suian-zcode-title://fix",
    pluginRoot:"D:\\CODE\\Project\\_VibeCoding\\ZCode-Plugins\\suian-zcode-title",
    dataDir:"C:\\Users\\u\\.zcode\\suian-zcode-title",
    setClipboard:async text=>{did.push({copy:text});},
    openWorkspace:async uri=>{did.push({open:uri});}
  });
  assert.deepEqual(result,{ok:true,action:"fix"});
  assert.equal(did.length,2);
  assert.ok(did[0].copy.includes("修复 ZCode 自动命名插件"),"剪贴板收到排障提示词");
  assert.equal(did[1].open,"zcode://workspace/open?path="+encodeURIComponent(join(homedir(),".zcode","workspace","default")),"打开用户自带默认工作区，不随插件位置变化");
});
test("协议处理器拒绝非法 URI 与未知动作",async()=>{
  const calls=[];
  const noop=async()=>{calls.push(1);};
  assert.deepEqual(await runAction({uri:"file:///etc/passwd",pluginRoot:"p",dataDir:"d",setClipboard:noop,openWorkspace:noop}),{ok:false,reason:"invalid_uri"});
  assert.deepEqual(await runAction({uri:"suian-zcode-title://wipe",pluginRoot:"p",dataDir:"d",setClipboard:noop,openWorkspace:noop}),{ok:false,reason:"unknown_action"});
  assert.equal(calls.length,0);
});
test("工作区打开 URI 对路径做完整百分号编码",()=>{
  assert.equal(encodeWorkspaceOpenUri("D:\\CODE\\Project"),"zcode://workspace/open?path=D%3A%5CCODE%5CProject");
  assert.equal(encodeWorkspaceOpenUri("D:\\sp ace\\中文"),"zcode://workspace/open?path="+encodeURIComponent("D:\\sp ace\\中文"));
  assert.ok(defaultFixWorkspace().endsWith(join(".zcode","workspace","default")));
});
