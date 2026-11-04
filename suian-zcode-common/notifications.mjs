import {runPowerShell} from "./windows.mjs";
import {shouldNotify,markShown,acquireDisplayLock,STALE_LOCK_MS} from "./cooldown.mjs";

const RECOVERY_POLL_MS=100;
export const RECOVERY_LOCK_WAIT_MS=STALE_LOCK_MS+2*RECOVERY_POLL_MS;

const escapeXml=value=>String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));

export function buildToastXml({title,message,actionLabel,actionUri}) {
  return `<toast activationType="protocol" launch="${escapeXml(actionUri)}" scenario="default"><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(message)}</text></binding></visual><actions><action activationType="protocol" arguments="${escapeXml(actionUri)}" content="${escapeXml(actionLabel)}"/><action activationType="protocol" arguments="${escapeXml(actionUri.replace(/[^/]+$/, "mute"))}" content="免打扰 24 小时"/></actions></toast>`;
}

export async function notifyOnce({dataDir,title,message,reasonCode,appId,now=Date.now,display=showToastViaPowerShell,actionLabel="复制排障提示词并打开 ZCode",actionUri,bypassCooldown=false}) {
  const early=await shouldNotify({dataDir,now});
  if(!early.allowed&&!(bypassCooldown&&early.reason==="cooldown"))return{shown:false,...early};
  let lock=await acquireDisplayLock({dataDir,now});
  // 已发生的覆盖不能被正在显示的旧故障压掉；等待锁后仍检查用户静音。
  const waitDeadline=Date.now()+RECOVERY_LOCK_WAIT_MS;
  while(bypassCooldown&&!lock.acquired&&lock.reason==="inflight"&&Date.now()<waitDeadline) {
    await new Promise(resolve=>setTimeout(resolve,RECOVERY_POLL_MS));
    lock=await acquireDisplayLock({dataDir,now});
  }
  if(!lock.acquired)return{shown:false,reason:lock.reason};
  try {
    const recheck=await shouldNotify({dataDir,now});
    if(!recheck.allowed&&!(bypassCooldown&&recheck.reason==="cooldown"))return{shown:false,...recheck};
    const xml=buildToastXml({title,message,actionLabel,actionUri});
    const result=await display({title,message,xml,actionLabel,actionUri,appId});
    if(!result.ok)return{shown:false,reason:"display_failed",detail:result.detail};
    if(!bypassCooldown)await markShown({dataDir,now,reasonCode});
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
