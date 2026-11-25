#!/usr/bin/env node
// 安装命令入口（PKG-02 拆薄）：只做参数解析、布局解析与退出码；可复用逻辑在 ./installer.mjs。
// 不得从这里导入其他命令入口，也不被其他命令入口导入：bundle 内联会复制主模块判定。
import {join,resolve} from "node:path";
import {homedir} from "node:os";
import {pathToFileURL} from "node:url";
import {parseArgs} from "node:util";
import {resolvePluginLayout} from "./release-layout.mjs";
import {commonInstaller,commonAnchorOptions} from "./common-access.mjs";
import {installPlugin,removeStopHook,removeSkill,removeToastAssets,removeToastTemplate,defaultShell,PROTOCOL} from "./installer.mjs";

export * from "./installer.mjs";

const isMain=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(isMain) {
  const layout=resolvePluginLayout();
  const pluginRoot=layout.root;
  const {values,positionals}=parseArgs({allowPositionals:true,options:{remove:{type:"boolean"},config:{type:"string"},"check-only":{type:"boolean"},"native-plugin":{type:"boolean"},"source-server":{type:"boolean"},"legacy-root":{type:"string"},"common-root":{type:"string"},"installed-plugins":{type:"string"}}});
  if(values.remove&&values["check-only"]) {console.error("--remove 与 --check-only 不能同时使用");process.exit(2);}
  if(values["source-server"]&&(!values["native-plugin"]||values.remove)) {console.error("--source-server 仅用于原生安装和检查；卸载由宿主管理");process.exit(2);}
  const dataDir=positionals[0];
  const remove=values.remove;
  const configFile=join(homedir(),".zcode","cli","config.json");
  if(!dataDir||positionals.length!==1) {console.error("用法：node install.mjs <dataDir> [--config 文件] [--check-only | --remove]\n      可选 --common-root / --installed-plugins 在无宿主注入时显式提供 common 位置");process.exit(2);}
  const run=remove
    ?async()=>{
      await commonInstaller(commonAnchorOptions({commonRoot:values["common-root"],installedPlugins:values["installed-plugins"]}));
      const hook=values["native-plugin"]?{action:"plugin_managed"}:await removeStopHook({pluginRoot,entrySubdir:layout.entrySubdir,configFile});
      // 卸载只清理归属匹配的自有资产：协议键、快捷方式、vbs、AppID 缓存与外置身份/模板；
      // 共享 Toast 运行目录、common 身份与网关不受影响。
      await removeToastAssets({dataDir,homeDir:homedir()});
      await removeToastTemplate({dataDir,shell:defaultShell});
      const skill=values["native-plugin"]?{action:"plugin_managed"}:await removeSkill({skillFile:join(homedir(),".zcode","skills",PROTOCOL,"SKILL.md")});
      return{ok:true,actions:{hook:hook.action,toast:"removed",template:"removed",skill:skill.action}};
    }
    :()=>installPlugin({pluginRoot,entrySubdir:layout.entrySubdir,dataDir,configPath:values.config?resolve(values.config):undefined,checkOnly:values["check-only"],nativePlugin:values["native-plugin"],sourceServer:values["source-server"],legacyRoot:values["legacy-root"]?resolve(values["legacy-root"]):undefined,commonRoot:values["common-root"]?resolve(values["common-root"]):undefined,installedPlugins:values["installed-plugins"]?resolve(values["installed-plugins"]):undefined});
  run()
    .then(result=>{console.log(JSON.stringify(result));})
    .catch(error=>{console.log(JSON.stringify({ok:false,error:error.name==="SyntaxError"?"配置 JSON 格式无效":error.message}));process.exit(1);});
}
