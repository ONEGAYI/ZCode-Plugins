import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {parseActionUri,runAction} from "../toast-action.mjs";
import {encodeWorkspaceOpenUri,defaultFixWorkspace} from "../../suian-zcode-common/notification-action.mjs";
import {resolveTitleInstallRoot,renderFixPrompt,buildFixPrompt,deployToastTemplate,TOAST_TEMPLATE_FILE} from "../toast.mjs";
import {homedir} from "node:os";
import {FIXTURE_TITLE_ROOT} from "./common-fixture.mjs";

const writeTemplate=async (dir,text=["请帮我检查并修复 ZCode 自动命名插件的公共网关 RPC。","插件目录：{{plugin_root}}","数据目录：{{data_dir}}"].join("\n"))=>{
  await writeFile(join(dir,TOAST_TEMPLATE_FILE),text,"utf8");
};
const inject=()=>{
  const clipboard=[],opened=[];
  return {clipboard,opened,setClipboard:async text=>{clipboard.push(text);},openWorkspace:async uri=>{opened.push(uri);}};
};

test("协议处理器读取外置模板并插入当前安装根：先复制提示词再打开默认工作区",async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),"z-title-toast-"));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  await writeTemplate(dataDir);
  const scope=inject();
  const result=await runAction({uri:"suian-zcode-title://fix",dataDir,...scope});
  assert.deepEqual(result,{ok:true,action:"fix"});
  assert.ok(scope.clipboard[0].includes("修复 ZCode 自动命名插件"),"剪贴板收到外置模板生成的排障提示词");
  assert.ok(scope.clipboard[0].includes(FIXTURE_TITLE_ROOT),"提示词插入安装记录中的当前安装根");
  assert.ok(scope.clipboard[0].includes(dataDir),"{{data_dir}} 使用外置数据目录");
  assert.equal(scope.opened.length,1);
  assert.equal(scope.opened[0],"zcode://workspace/open?path="+encodeURIComponent(join(homedir(),".zcode","workspace","default")),"打开用户自带默认工作区，不随插件位置变化");
});

test("外置模板缺失时明确失败，不复制任何提示",async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),"z-title-toast-missing-"));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const scope=inject();
  assert.deepEqual(await runAction({uri:"suian-zcode-title://fix",dataDir,...scope}),{ok:false,reason:"template_missing"});
  assert.equal(scope.clipboard.length,0);
});

test("安装记录中 title 条目缺失时明确说明缺失，不输出旧根作为有效入口",async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),"z-title-toast-absent-"));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  await writeTemplate(dataDir);
  const emptyRegistry=join(dataDir,"registry-empty.json");
  await writeFile(emptyRegistry,JSON.stringify({version:1,plugins:[
    {id:"suian-zcode-common@suian-zcode-plugins",name:"suian-zcode-common",marketplace:"suian-zcode-plugins",version:"0.4.2",installPath:"D:/cache/common",scope:"user"}
  ]}));
  const scope=inject();
  const result=await runAction({uri:"suian-zcode-title://fix",dataDir,pluginsFile:emptyRegistry,...scope});
  assert.equal(result.ok,true);
  assert.match(scope.clipboard[0],/安装条目缺失/);
  assert.ok(!scope.clipboard[0].includes(FIXTURE_TITLE_ROOT),"不得把旧缓存根当作有效入口输出");
});

test("协议处理器拒绝非法 URI 与未知动作",async()=>{
  const calls=[];
  const noop=async()=>{calls.push(1);};
  assert.deepEqual(await runAction({uri:"file:///etc/passwd",dataDir:"d",setClipboard:noop,openWorkspace:noop}),{ok:false,reason:"invalid_uri"});
  assert.deepEqual(await runAction({uri:"suian-zcode-title://wipe",dataDir:"d",setClipboard:noop,openWorkspace:noop}),{ok:false,reason:"unknown_action"});
  assert.equal(calls.length,0);
});

test("resolveTitleInstallRoot：优先显式记录，条目缺失返回 null",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"z-title-toast-root-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const freshRoot=join(dir,"fresh","title","0.2.0");
  await mkdir(freshRoot,{recursive:true});
  const registry=join(dir,"installed_plugins.json");
  await writeFile(registry,JSON.stringify({version:1,plugins:[
    {id:"suian-zcode-title@suian-zcode-plugins",name:"suian-zcode-title",marketplace:"suian-zcode-plugins",version:"0.2.0",installPath:freshRoot,scope:"user"}
  ]}));
  assert.equal(await resolveTitleInstallRoot({pluginsFile:registry}),freshRoot);
  const noTitle=join(dir,"no-title.json");
  await writeFile(noTitle,JSON.stringify({version:1,plugins:[]}));
  assert.equal(await resolveTitleInstallRoot({pluginsFile:noTitle}),null);
  assert.equal(await resolveTitleInstallRoot({pluginsFile:join(dir,"absent.json")}),null);
});

test("renderFixPrompt：占位替换完整，installRoot 为空时插入缺失说明",()=>{
  const template="插件目录：{{plugin_root}}\n数据目录：{{data_dir}}";
  assert.equal(renderFixPrompt({template,installRoot:"D:/t",dataDir:"D:/d"}),"插件目录：D:/t\n数据目录：D:/d");
  const missing=renderFixPrompt({template,installRoot:null,dataDir:"D:/d"});
  assert.match(missing,/安装条目缺失/);
  assert.ok(!missing.includes("{{"));
});

test("buildFixPrompt 保留模板单一源语义并部署外置模板",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"z-title-toast-deploy-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const files=new Map();
  const shell={
    mkdir:async()=>{},
    readText:async path=>{if(!files.has(path))throw Object.assign(new Error("ENOENT"),{code:"ENOENT"});return files.get(path);},
    writeText:async(path,text)=>{files.set(path,text);},
    remove:async path=>{files.delete(path);}
  };
  const prompt=buildFixPrompt({installRoot:"D:/t",dataDir:"D:/d"});
  assert.ok(prompt.includes("修复 ZCode 自动命名插件"));
  const first=await deployToastTemplate({dataDir:dir,shell});
  assert.equal(first.action,"written");
  const deployed=files.get(join(dir,TOAST_TEMPLATE_FILE));
  assert.ok(deployed.includes("{{plugin_root}}"),"外置模板保留占位，点击时才解析当前根");
  const second=await deployToastTemplate({dataDir:dir,shell});
  assert.equal(second.action,"unchanged","内容一致不得重写");
});

test("工作区打开 URI 对路径做完整百分号编码",()=>{
  assert.equal(encodeWorkspaceOpenUri("D:\\CODE\\Project"),"zcode://workspace/open?path=D%3A%5CCODE%5CProject");
  assert.equal(encodeWorkspaceOpenUri("D:\\sp ace\\中文"),"zcode://workspace/open?path="+encodeURIComponent("D:\\sp ace\\中文"));
  assert.ok(defaultFixWorkspace().endsWith(join(".zcode","workspace","default")));
});
