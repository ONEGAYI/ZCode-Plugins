import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {shouldNotify,markShown,acquireDisplayLock} from "./cooldown.mjs";

const escapeXml=value=>String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));

export function buildToastXml({title,message,actionLabel,actionUri}) {
  return `<toast activationType="protocol" launch="${escapeXml(actionUri)}" scenario="default"><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(message)}</text></binding></visual><actions><action activationType="protocol" arguments="${escapeXml(actionUri)}" content="${escapeXml(actionLabel)}"/><action activationType="system" arguments="dismiss" content="忽略"/></actions></toast>`;
}

const FIX_PROMPT_TEMPLATE=`请帮我检查并修复 ZCode 自动命名插件的远控配置。先读取插件 Skill 和 README，再运行 status/doctor/probe，区分网络、授权、原 Host 与工作区问题。需要时指导我取得当前窗口"移动端远程控制"的新链接，并安全更新配置，不回显或写入日志。保持已选 GLM-5.3-Flash / low，核对 Stop Hook 是否安装、启用、受信任及实际触发。只处理命名插件的配置与诊断；按当前授权验证修复结果。
插件目录：{{plugin_root}}
数据目录：{{data_dir}}`;

export function buildFixPrompt({pluginRoot,dataDir}) {
  return FIX_PROMPT_TEMPLATE
    .replace(/\{\{plugin_root\}\}/g,()=>pluginRoot)
    .replace(/\{\{data_dir\}\}/g,()=>dataDir);
}

export const reasonMessages={
  network_timeout:"远控网络超时",
  network_error:"远控连接中断",
  auth_failed:"远控授权被拒绝",
  device_offline:"原窗口远控未开启或已离线",
  kicked:"连接被新设备取代",
  pair_waiting:"远控配对未就绪",
  host_unreachable:"原 ZCode 窗口不可达",
  workspace_missing:"原窗口未打开目标工作区",
  session_missing:"原窗口没有目标会话",
  invalid_url:"远控链接格式无效",
  missing_authorization:"未提供远控授权链接",
  auth_link_rejected:"远控授权链接已失效",
  relay_rejected:"远控服务拒绝了连接"
};

export function toastBodyFor(reasonCode) {
  return `${reasonMessages[reasonCode]??"远控不可用"}（${reasonCode}），本轮跳过命名。点击按钮复制排障提示词并打开 ZCode（需确认打开工作区）。`;
}

export async function notifyOnce({dataDir,title,message,reasonCode,appId,now=Date.now,display=showToastViaPowerShell,actionLabel="复制排障提示词并打开 ZCode",actionUri="suian-zcode-title://fix"}) {
  const early=await shouldNotify({dataDir,now});
  if(!early.allowed)return{shown:false,...early};
  const lock=await acquireDisplayLock({dataDir,now});
  if(!lock.acquired)return{shown:false,reason:lock.reason};
  try {
    const recheck=await shouldNotify({dataDir,now});
    if(!recheck.allowed)return{shown:false,...recheck};
    const xml=buildToastXml({title,message,actionLabel,actionUri});
    const result=await display({title,message,xml,actionLabel,actionUri,appId});
    if(!result.ok)return{shown:false,reason:"display_failed",detail:result.detail};
    await markShown({dataDir,now,reasonCode});
    return{shown:true};
  } finally {await lock.release();}
}

export async function showToastViaPowerShell({xml,appId}) {
  const script=[
    "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]|Out-Null",
    "$doc=New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$doc.LoadXml(@'",
    xml,
    "'@)",
    "$toast=New-Object Windows.UI.Notifications.ToastNotification $doc",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show($toast)`
  ].join("\n");
  try {
    const encoded=Buffer.from(script,"utf16le").toString("base64");
    await promisify(execFile)("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",encoded],{windowsHide:true,timeout:15000});
    return{ok:true};
  } catch(error) {
    return{ok:false,detail:`exit ${error.code??error.errno??"?"}: ${String(error.stderr??error.message).slice(0,300)}`};
  }
}
