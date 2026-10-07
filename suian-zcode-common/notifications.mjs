import {runPowerShell} from "./windows.mjs";
import {shouldNotify,markShown,acquireDisplayLock} from "./cooldown.mjs";

const escapeXml=value=>String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));

export function buildToastXml({title,message,actionLabel,actionUri}) {
  return `<toast activationType="protocol" launch="${escapeXml(actionUri)}" scenario="default"><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(message)}</text></binding></visual><actions><action activationType="protocol" arguments="${escapeXml(actionUri)}" content="${escapeXml(actionLabel)}"/><action activationType="system" arguments="dismiss" content="忽略"/></actions></toast>`;
}

export async function notifyOnce({dataDir,title,message,reasonCode,appId,now=Date.now,display=showToastViaPowerShell,actionLabel="复制排障提示词并打开 ZCode",actionUri}) {
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
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId.replace(/'/g,"''")}').Show($toast)`
  ].join("\n");
  try {
    await runPowerShell(script,{timeout:15000});
    return{ok:true};
  } catch(error) {
    return{ok:false,detail:`exit ${error.code??error.errno??"?"}: ${String(error.stderr??error.message).slice(0,300)}`};
  }
}
