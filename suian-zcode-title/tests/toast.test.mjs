import test from "node:test";
import assert from "node:assert/strict";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {buildFixPrompt,toastBodyFor} from "../toast.mjs";

test("修复提示词仅包含非秘密路径且模板可整体替换",()=>{
  const prompt=buildFixPrompt({pluginRoot:"D:\\CODE\\Project\\_VibeCoding\\ZCode-Plugins\\suian-zcode-title",dataDir:join(tmpdir(),"suian-zcode-title")});
  assert.ok(prompt.includes("suian-zcode-title"),"包含插件目录");
  assert.ok(prompt.includes("suian-zcode-title"),"包含数据目录");
  assert.ok(!prompt.includes("{{"),"/模板变量必须全部替换");
  for(const secret of ["sid=","hash=","mid=","https://zcode.z.ai/remote"])assert.ok(!prompt.includes(secret),"提示词不得携带授权片段");
});

test("命名模型缺失时提醒可诊断并提供模型修复提示",()=>{
  assert.match(toastBodyFor("naming_model_unavailable"),/命名模型或思考档位不可用/);
  assert.match(buildFixPrompt({installRoot:"D:/title",dataDir:"D:/data"}),/命名模型或思考档位不可用/);
});
