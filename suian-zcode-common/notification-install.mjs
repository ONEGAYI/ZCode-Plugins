import {join} from "node:path";
import {fileShell} from "./windows.mjs";

export function buildVbsContent({nodeExe,toastActionPath,dataDir,protocol}) {
  return [
    `' ${protocol} 按钮激活桥（安装器生成，请勿手改）：隐藏窗口转发协议 URI`,
    "If WScript.Arguments.Count = 0 Then WScript.Quit 1",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """" & "${nodeExe}" & """ """ & "${toastActionPath}" & """ """ & WScript.Arguments(0) & """ """ & "${dataDir}" & """", 0, False`
  ].join("\r\n")+"\r\n";
}

export function buildProtocolCommand({vbsPath}) {
  return `wscript.exe "${vbsPath}" "%1"`;
}

// 创建调用方自己的 Toast 身份；协议和通知标识由调用方提供。
const shortcutScript=({nodeExe,pluginRoot,shortcutName,description,appId})=>[
  "$ErrorActionPreference='Stop'",
  `$lnkPath=Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\${shortcutName.replace(/'/g,"''")}'`,
  "$ws=New-Object -ComObject WScript.Shell",
  "$s=$ws.CreateShortcut($lnkPath)",
  `$s.TargetPath='${nodeExe.replace(/'/g,"''")}'`,
  "$s.Arguments=''",
  `$s.WorkingDirectory='${pluginRoot.replace(/'/g,"''")}'`,
  `$s.Description='${description.replace(/'/g,"''")}'`,
  "$s.Save()",
  "[System.Runtime.InteropServices.Marshal]::ReleaseComObject($s)|Out-Null",
  "[System.Runtime.InteropServices.Marshal]::ReleaseComObject($ws)|Out-Null",
  "Start-Sleep -Milliseconds 500",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class AppUserModelId {",
  "  [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }",
  "  [StructLayout(LayoutKind.Explicit)] struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr pointer; }",
  "  [ComImport, Guid(\"886d8eeb-8cf2-4446-8d02-cdba1dbdcf99\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
  "  interface IPropertyStore {",
  "    [PreserveSig] int GetCount(out uint count);",
  "    [PreserveSig] int GetAt(uint index, out PROPERTYKEY key);",
  "    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);",
  "    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);",
  "    [PreserveSig] int Commit();",
  "  }",
  "  [DllImport(\"shell32.dll\", CharSet=CharSet.Unicode, PreserveSig=true)] static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bindContext, uint flags, ref Guid iid, out IPropertyStore store);",
  "  [DllImport(\"ole32.dll\")] static extern int PropVariantClear(ref PROPVARIANT variant);",
  "  static readonly Guid IID_IPropertyStore = new Guid(\"886d8eeb-8cf2-4446-8d02-cdba1dbdcf99\");",
  "  static readonly PROPERTYKEY PKEY_AppUserModel_ID = new PROPERTYKEY { fmtid = new Guid(\"9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3\"), pid = 5 };",
  "  public static void Set(string shortcutPath, string appId) {",
  "    IPropertyStore store;",
  "    Guid iid = IID_IPropertyStore;",
  "    int hr = SHGetPropertyStoreFromParsingName(shortcutPath, IntPtr.Zero, 2 /* GPS_READWRITE */, ref iid, out store);",
  "    if (hr != 0) Marshal.ThrowExceptionForHR(hr);",
  "    PROPERTYKEY key = PKEY_AppUserModel_ID;",
  "    PROPVARIANT value = new PROPVARIANT();",
  "    value.vt = 31;",
  "    value.pointer = Marshal.StringToCoTaskMemUni(appId);",
  "    try {",
  "      hr = store.SetValue(ref key, ref value);",
  "      if (hr != 0) Marshal.ThrowExceptionForHR(hr);",
  "      store.Commit();",
  "    } finally {",
  "      PropVariantClear(ref value);",
  "      Marshal.ReleaseComObject(store);",
  "    }",
  "  }",
  "}",
  "'@",
  `[AppUserModelId]::Set($lnkPath,'${appId.replace(/'/g,"''")}')`,
  "Write-Output AUMID_SET_OK"
].join("\n");

export async function ensureToastAppId({dataDir,appId,shell=fileShell}) {
  const cachePath=join(dataDir,"toast-appid.txt");
  try {
    const cached=(await shell.readText(cachePath)).trim();
    if(cached===appId)return cached;
  }catch(error){if(error.code!=="ENOENT")throw error;}
  await shell.writeText(cachePath,appId);
  return appId;
}

export async function installToastAssets({pluginRoot,dataDir,protocol,appId,shortcutName,description,nodeExe=process.execPath,shell=fileShell}) {
  await shell.mkdir(dataDir);
  const vbsPath=join(dataDir,"toast-launch.vbs");
  const desired=buildVbsContent({nodeExe,toastActionPath:join(pluginRoot,"toast-action.mjs"),dataDir,protocol});
  let current=null;
  try {current=await shell.readText(vbsPath);}catch(error){if(error.code!=="ENOENT")throw error;}
  let vbsAction;
  if(current===desired)vbsAction="unchanged";
  else {await shell.writeText(vbsPath,desired);vbsAction="written";}
  const command=buildProtocolCommand({vbsPath});
  await shell.run("reg.exe",["add",`HKCU\\Software\\Classes\\${protocol}`,"/ve","/d","URL:"+description,"/f"]);
  await shell.run("reg.exe",["add",`HKCU\\Software\\Classes\\${protocol}`,"/v","URL Protocol","/d","","/f"]);
  await shell.run("reg.exe",["add",`HKCU\\Software\\Classes\\${protocol}\\shell\\open\\command`,"/ve","/d",command,"/f"]);
  await shell.ps(shortcutScript({nodeExe,pluginRoot,shortcutName,description,appId}));
  await ensureToastAppId({dataDir,appId,shell});
  return{ok:true,appId,actions:{vbs:vbsAction,protocol:"ensured",shortcut:"ensured",appId:"cached"}};
}

export async function removeToastAssets({dataDir,protocol,shortcutName,shell=fileShell}) {
  await shell.run("reg.exe",["delete",`HKCU\\Software\\Classes\\${protocol}`,"/f"]);
  await shell.ps(["$ErrorActionPreference='Stop'",`Remove-Item -LiteralPath (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\${shortcutName.replace(/'/g,"''")}') -ErrorAction SilentlyContinue`].join("\n"));
  await shell.remove(join(dataDir,"toast-launch.vbs"));
  await shell.remove(join(dataDir,"toast-appid.txt"));
  return{ok:true};
}
