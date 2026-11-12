// Windows 3.18.1.10376 原版运行包适配；2026-11-12 逐锚点核对。独立修订号 1。
export const SUPPORTED_PACKAGE = Object.freeze({
  exeName: 'ZCode.exe',
  exeFileVersion: '3.18.1.10376',
  appAsarRelativePath: 'resources/app.asar',
  appAsarSha256: '1AF9CDD891F6BA3436BF289B387314819CEFDF09AA49EC736694C24E8000EAE4',
  appAsarBytes: 384827497,
  chromiumVersion: null,
  electronVersion: null, // 静态证据链未定 Electron 精确版本；运行时提取列为未验项
});

// 本发行包首个补丁修订；保留旧包行为语义（开关载体约定与 3.16.x/3.17.x 档案一致）。
export const PATCH_VERSION = 1;

// 主入口文件（asar 内路径）：本包 package.json main 实测仍为 out/main/index.js。
export const MAIN_ENTRY = 'out/main/index.js';

// ---- 运行时开关载体约定（与 P1 注入代码保持一致；改此处必须同步改渲染函数） ----
// 判定优先级：env ZCODE_LOCAL_ONLY（显式 1/0）> 数据根标志 > userData 标志 > 默认关。
// 主开关是标志文件（用户原快捷方式启动也能生效）；env 只作显式覆盖通道。
export const LOCAL_ONLY_ENV_OVERRIDE = 'ZCODE_LOCAL_ONLY';
export const LOCAL_ONLY_GATEWAY_ENV = 'ZCODE_LOCAL_ONLY_GATEWAY';
// 自动启动的工作区来源（P6 消费）：env 显式优先；否则取首个存在的标志文件首行（非空行）。
export const LOCAL_ONLY_WORKSPACE_ENV = 'ZCODE_LOCAL_ONLY_WORKSPACE';
export const LOCAL_ONLY_FLAG_PATHS = Object.freeze([
  '{dataBaseDir}/.zcode/local-only.flag', // dataBaseDir = ZCODE_DATA_BASE_DIR || HOME || USERPROFILE
  '{APPDATA}/ZCode/local-only.flag',
]);
export const LOCAL_ONLY_GATEWAY_DEFAULT_ORIGIN = 'http://127.0.0.1:17331'; // lab 默认端口，避开日常网关 17329
// 网关 WS 端点为 /ws（gateway.mjs upgrade 分流），不是官方 /api/v1/remote/ws2。
export const LOCAL_ONLY_GATEWAY_WS_PATH = '/ws';

// ---- 注入点定义 ----
// 每个注入点：id（对外报告）、kind（prepend：文件首部；replace：字节串替换）、
// find（唯一命中的精确字节串）/ replacement（完整替换文本）、semantic（人工核对新版本用）。

// P0：文件首行插入自包含命名 import（注入代码需要同步 existsSync/readFileSync 读标志文件）。
const P0_IMPORT = 'import{existsSync as __loExists,readFileSync as __loRead}from"node:fs";\n';

// P1：在 M_/O_ 的 var 语句结束后插入。两处 relayWsUrl 均读取 M_：manager 构造直接求值，
// getEndpointUrls 在回调内求值。ud 是 chunk-L5OJRMFK.js 的 e3：非空 overrideUrl trim 后直接返回，
// 空值才以 endpointOrigin 构造 /api/v1/remote/ws2。关模式保留原值；开模式仅接受回环覆盖。
export function renderP1GateCode() {
  const gatewayExpression = `(process.env.${LOCAL_ONLY_GATEWAY_ENV}||${JSON.stringify(LOCAL_ONLY_GATEWAY_DEFAULT_ORIGIN)}).trim()`;
  return [
    'var __LO_MODE=(function(){try{',
    `if(process.env.${LOCAL_ONLY_ENV_OVERRIDE}==="1")return true;`,
    `if(process.env.${LOCAL_ONLY_ENV_OVERRIDE}==="0")return false;`,
    'var c=[];var b=(process.env.ZCODE_DATA_BASE_DIR||process.env.HOME||process.env.USERPROFILE||"").trim();',
    'if(b)c.push(b.replace(/[\\/\\\\]+$/,"")+"/.zcode/local-only.flag");',
    'if(process.env.APPDATA)c.push(process.env.APPDATA+"/ZCode/local-only.flag");',
    'for(var i=0;i<c.length;i++){try{if(__loExists(c[i]))return true}catch(x){}}',
    '}catch(x){}return false})();',
    // __LO_WS：自动启动工作区（P6 消费）。env 显式优先；否则取首个存在的标志文件首行（非空）。
    // 整体收在 IIFE 内：内部变量（e/b/c/t/i）不提升到模块顶层——产物顶层已占用大量压缩名
    // （3.16.2 真实运行曾因 var b2 与产物顶层 let b2 冲突导致 SyntaxError，见 LO-03 原生验证）。
    'var __LO_WS=(function(){',
    'if(!__LO_MODE)return "";',
    `try{var e=(process.env.${LOCAL_ONLY_WORKSPACE_ENV}||"").trim();if(e)return e}catch(x){}`,
    'try{',
    'var c=[];var b=(process.env.ZCODE_DATA_BASE_DIR||process.env.HOME||process.env.USERPROFILE||"").trim();',
    'if(b)c.push(b.replace(/[\\/\\\\]+$/,"")+"/.zcode/local-only.flag");',
    'if(process.env.APPDATA)c.push(process.env.APPDATA+"/ZCode/local-only.flag");',
    'for(var i=0;i<c.length;i++){try{var t=__loRead(c[i],"utf8").split(/\\r?\\n/)[0].trim();if(t)return t}catch(x){}}',
    '}catch(x){}return "";})();',
    // URL 是外部环境输入；只捕获解析错误。内部变量全部保留在 IIFE 中。
    'if(__LO_MODE)M_=(function(){',
    'var local=function(v,p){var u;try{u=new URL(v)}catch(e){return null}',
    'var h=u.hostname;return p.indexOf(u.protocol)>=0&&!u.username&&!u.password&&(h==="localhost"||h==="[::1]"||/^127(?:\\.[0-9]{1,3}){3}$/.test(h))?u:null};',
    'var w=local(M_,["ws:","wss:"]);if(w)return w.href;',
    `var g=local(${gatewayExpression},["http:","https:"])||new URL(${JSON.stringify(LOCAL_ONLY_GATEWAY_DEFAULT_ORIGIN)});`,
    `g.protocol=g.protocol==="https:"?"wss:":"ws:";g.pathname="${LOCAL_ONLY_GATEWAY_WS_PATH}";g.search="";g.hash="";return g.href})();`,
    'var __LO_TOKEN=function(){var a="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",s="";',
    'for(var i=0;i<21;i++)s+=a.charAt(Math.floor(Math.random()*a.length));return s+"A"};',
  ].join('');
}

// P6：在 Mg.current=Gt; 之后、Gt.startNotifications() 之前插入。Ge() 排除 CUA 指示窗。
// 开模式且有工作区时，等 app ready 和窗口；仅对 idle 的 Gt 调 start，失败按原有间隔有界重试。
export function renderP6AutoStartCode() {
  return {
    imports: 'import{app as __loApp,BrowserWindow as __loBW}from"electron";',
    body: [
      'if(__LO_MODE&&__LO_WS){(function(){',
      'var n=0,t=function(){try{',
      'if(!__loApp.isReady()){if(++n>150)return;return setTimeout(t,2e3)}',
      'var w=typeof Ge==="function"?Ge():__loBW.getAllWindows().filter(function(x){try{return!x.isDestroyed()}catch(e){return!1}});',
      'if(!w.length){if(++n>150)return;return setTimeout(t,2e3)}',
      'var s=Gt.getStatus(w[0].id);',
      'if(s&&s.status!=="idle")return;',
      'Promise.resolve(Gt.start(w[0].id,{workspacePath:__LO_WS})).then(function(){},function(x){if(++n>150)return;setTimeout(t,2e3)})',
      '}catch(x){if(++n>150)return;setTimeout(t,2e3)}};',
      'setTimeout(t,2e3)})()}',
    ].join(''),
  };
}

// 原包 out/main/index.js 的精确锚点：P1、P6 以分号结束，其余保持原回调体或方法体。
const ANCHOR_ENV_OVERRIDE = 'M_=process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?.trim(),O_=process.env.ZCODE_WEB_REMOTE_CONTROL_URL?.trim();';
const ANCHOR_GET_LOGIN = 'getLogin:s(async()=>{let e=await w4(),t=await y4(e);return t?{userId:e,jwt:t.slice(7)}:void 0},"getLogin")';
const ANCHOR_GET_TOKEN = 'getToken:s(async ve=>{let At=await jn(),Qo=await m(jn,At,()=>ad.token(At.jwt,AbortSignal.any([de,ve])));return await jn(),e.logger.info("[web-remote-control] V2 device token acquired"),Qo},"getToken")';
const ANCHOR_RESOLVE_SID = 'resolveDeviceSid:s(async(ve,At)=>(je=await cd(At,ve),t.get(h)===ye&&(ye.deviceSid=je,ye.qrUrl=ye.connectUrl=""),je),"resolveDeviceSid")';
const ANCHOR_NOTIFY_AUTH = 'async notifyAuthStateChanged(h,y){let D=++_;if(y.state==="signed-in"){';
const ANCHOR_MANAGER_REF = 'disposeWorkspaceHostAttachmentsForRemoteSession:s(e=>xi.disposeRemoteSession(e),"disposeWorkspaceHostAttachmentsForRemoteSession")});Mg.current=Gt;';

// P1 替换文本：锚点语句（原样保留）之后追加门控语句序列。
function p1Replacement() {
  return ANCHOR_ENV_OVERRIDE + renderP1GateCode();
}

// P6 替换文本：锚点语句（原样保留）之后追加 electron import（ESM 顶层提升，位置合法）
// 与自动启动体。
function p6Replacement() {
  const { imports, body } = renderP6AutoStartCode();
  return ANCHOR_MANAGER_REF + imports + body;
}

export const INJECTIONS = Object.freeze([
  Object.freeze({
    id: 'P0-fs-import',
    kind: 'prepend',
    replacement: P0_IMPORT,
    semantic: '文件首行插入 node:fs existsSync/readFileSync 自包含命名 import（标志文件存在性与首行读取）',
  }),
  Object.freeze({
    id: 'P1-mode-gate',
    kind: 'replace',
    find: ANCHOR_ENV_OVERRIDE,
    replacement: p1Replacement(),
    semantic: 'M_/O_ 所在 var 语句结束后：判定开关、解析工作区、用回环地址覆写 M_、生成本地 token',
  }),
  Object.freeze({
    id: 'P2-login-short-circuit',
    kind: 'replace',
    find: ANCHOR_GET_LOGIN,
    replacement: `getLogin:s(async()=>{if(__LO_MODE)return{userId:"local-only-device",jwt:"local-only"};${ANCHOR_GET_LOGIN.slice('getLogin:s(async()=>{'.length)}`,
    semantic: 'getLogin 回调短路：本地模式返回固定凭据，放行 manager start 的登录检查与续检（05 C1/C3）',
  }),
  Object.freeze({
    id: 'P3-device-sid-short-circuit',
    kind: 'replace',
    find: ANCHOR_RESOLVE_SID,
    replacement: `resolveDeviceSid:s(async(ve,At)=>__LO_MODE?"local-only-device":${ANCHOR_RESOLVE_SID.slice('resolveDeviceSid:s(async(ve,At)=>'.length)}`,
    semantic: 'resolveDeviceSid 回调短路：本地模式返回常量 device_sid，跳过 HTTP 设备注册（POST /api/v1/remote/device，05 C2）；本包注册处位于每会话连接 options',
  }),
  Object.freeze({
    id: 'P4-token-short-circuit',
    kind: 'replace',
    find: ANCHOR_GET_TOKEN,
    replacement: `getToken:s(async ve=>{if(__LO_MODE)return __LO_TOKEN();${ANCHOR_GET_TOKEN.slice('getToken:s(async ve=>{'.length)}`,
    semantic: 'getToken 回调短路：本地模式返回 22 字符形状 token，跳过 HTTP 取令牌（POST /api/v1/remote/token，05 C2）；本包注册处位于每会话连接 options，内部单飞包装短路后不执行',
  }),
  Object.freeze({
    id: 'P5-signed-out-isolation',
    kind: 'replace',
    find: ANCHOR_NOTIFY_AUTH,
    replacement: `async notifyAuthStateChanged(h,y){if(__LO_MODE&&y&&y.state!=="signed-in")return;${ANCHOR_NOTIFY_AUTH.slice('async notifyAuthStateChanged(h,y){'.length)}`,
    semantic: 'signed-out/登出通知短路：本地模式直接返回，不撤销任何窗口的本地链路（05 C4 @409101）；开关关闭保留原撤销语义',
  }),
  Object.freeze({
    id: 'P6-auto-start',
    kind: 'replace',
    find: ANCHOR_MANAGER_REF,
    replacement: p6Replacement(),
    semantic: 'manager 引用挂接（Mg.current=Gt;）后注入自动启动：开关开启且解析到工作区时轮询触发 Gt.start（解 renderer 触发缺口 K9）；getStatus 非 idle 即停（幂等），失败重试上限 150 次',
  }),
]);

// 对 index.js 应用全部注入；返回 { content, applied }。
// 全部锚点必须唯一命中，任一失配/多重命中即抛错（anchor_mismatch），不写半成品。
export function applyInjections(source) {
  if (typeof source !== 'string') throw new Error('index.js 内容必须是字符串');
  if (source.includes('__LO_MODE')) {
    throw new Error('index.js 已含注入标记 __LO_MODE（疑似已应用补丁）');
  }
  let content = source;
  const applied = [];
  for (const injection of INJECTIONS) {
    if (injection.kind === 'prepend') {
      content = injection.replacement + content;
      applied.push({ id: injection.id, bytesAdded: Buffer.byteLength(injection.replacement, 'utf8') });
      continue;
    }
    const find = injection.find;
    const first = content.indexOf(find);
    if (first === -1) {
      throw new Error(`锚点 ${injection.id} 未命中（结构变化，需人工分析）：${find.slice(0, 60)}...`);
    }
    if (content.indexOf(find, first + 1) !== -1) {
      throw new Error(`锚点 ${injection.id} 命中多次（结构变化，需人工分析）`);
    }
    content = content.slice(0, first) + injection.replacement + content.slice(first + find.length);
    applied.push({
      id: injection.id,
      anchorOffset: first,
      bytesAdded: Buffer.byteLength(injection.replacement, 'utf8') - Buffer.byteLength(find, 'utf8'),
    });
  }
  return { content, applied };
}
