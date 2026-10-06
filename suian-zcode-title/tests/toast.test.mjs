import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {shouldNotify,markShown,acquireDisplayLock,TOAST_COOLDOWN_SECONDS} from "../cooldown.mjs";
import {buildToastXml,notifyOnce,buildFixPrompt} from "../toast.mjs";

const freshDir=()=>{const root=mkdtempSync(join(tmpdir(),"z-title-toast-"));return root;};
test("冷却 7199 秒内抑制、7200 秒整点恢复，且跨进程持久",async()=>{
  const dataDir=freshDir();const t0=Date.parse("2026-10-06T12:00:00Z");
  const clock={value:t0};const now=()=>clock.value;
  try {
    assert.deepEqual(await shouldNotify({dataDir,now}),{allowed:true});
    await markShown({dataDir,now,reasonCode:"pair_waiting"});
    clock.value=t0+(TOAST_COOLDOWN_SECONDS-1)*1000;
    const suppressed=await shouldNotify({dataDir,now});
    assert.equal(suppressed.allowed,false);assert.equal(suppressed.reason,"cooldown");
    assert.equal(suppressed.nextAllowedAt,t0+TOAST_COOLDOWN_SECONDS*1000);
    clock.value=t0+TOAST_COOLDOWN_SECONDS*1000;
    assert.deepEqual(await shouldNotify({dataDir,now}),{allowed:true},"整点必须恢复");
  } finally {rmSync(dataDir,{recursive:true});}
});
test("冷却时间戳原子写入，损坏文件视作未冷却",async()=>{
  const dataDir=freshDir();const t0=Date.parse("2026-10-06T12:00:00Z");const now=()=>t0;
  try {
    writeFileSync(join(dataDir,"toast-cooldown.json"),"{broken json");
    assert.deepEqual(await shouldNotify({dataDir,now}),{allowed:true});
    await markShown({dataDir,now,reasonCode:"kicked"});
    const stored=JSON.parse(readFileSync(join(dataDir,"toast-cooldown.json"),"utf8"));
    assert.equal(stored.lastShownAt,new Date(t0).toISOString());
    assert.equal(stored.reasonCode,"kicked");
  } finally {rmSync(dataDir,{recursive:true});}
});
test("并发失败同时到达时互斥锁只放行一个",async()=>{
  const dataDir=freshDir();const t0=Date.parse("2026-10-06T12:00:00Z");const now=()=>t0;
  try {
    const displays=[];
    const display=async()=>{displays.push(Date.now());await new Promise(r=>setTimeout(r,30));return{ok:true};};
    const [first,second]=await Promise.all([
      notifyOnce({dataDir,title:"t",message:"m",reasonCode:"pair_waiting",now,display}),
      notifyOnce({dataDir,title:"t",message:"m",reasonCode:"pair_waiting",now,display})
    ]);
    assert.equal(displays.length,1,"多路失败合并为一次显示");
    const outcomes=[first,second].filter(r=>r.shown);
    assert.equal(outcomes.length,1,"恰好一路完成显示");
    const other=[first,second].find(r=>!r.shown);
    assert.equal(other.reason,"inflight");
    const third=await notifyOnce({dataDir,title:"t",message:"m",reasonCode:"pair_waiting",now,display});
    assert.equal(third.reason,"cooldown","显示成功的进程写入冷却，后续直接冷却抑制");
  } finally {rmSync(dataDir,{recursive:true});}
});
test("显示失败不进入冷却且释放互斥",async()=>{
  const dataDir=freshDir();const t0=Date.parse("2026-10-06T12:00:00Z");const now=()=>t0;
  try {
    const failed=await notifyOnce({dataDir,title:"t",message:"m",reasonCode:"pair_waiting",now,display:async()=>({ok:false,detail:"exit 1"})});
    assert.equal(failed.shown,false);assert.equal(failed.reason,"display_failed");
    assert.equal(failed.detail,"exit 1");
    const retry=await notifyOnce({dataDir,title:"t",message:"m",reasonCode:"pair_waiting",now,display:async()=>({ok:true})});
    assert.deepEqual(retry,{shown:true},"显示失败后下一次允许立即重试");
  } finally {rmSync(dataDir,{recursive:true});}
});
test("持有进程死亡留下的陈旧锁会被回收",async()=>{
  const dataDir=freshDir();const t0=Date.parse("2026-10-06T12:00:00Z");const clock={value:t0};
  try {
    const dead=await acquireDisplayLock({dataDir,now:()=>clock.value,isProcessAlive:()=>false});
    assert.equal(dead.acquired,true);
    await new Promise(r=>setTimeout(r,10));
    clock.value=t0+60000;
    const next=await acquireDisplayLock({dataDir,now:()=>clock.value,isProcessAlive:()=>false});
    assert.equal(next.acquired,true,"锁内 pid 不存活且超时后应回收");
    const inflight=await acquireDisplayLock({dataDir,now:()=>clock.value,isProcessAlive:()=>true});
    assert.equal(inflight.acquired,false);assert.equal(inflight.reason,"inflight");
    next.release();
  } finally {rmSync(dataDir,{recursive:true});}
});
test("不注入时钟时默认路径可用（回归：默认参数必须是函数引用）",async()=>{
  const dataDir=freshDir();
  try {
    const shown=await notifyOnce({dataDir,title:"t",message:"m",reasonCode:"pair_waiting",appId:"a",display:async()=>({ok:true})});
    assert.deepEqual(shown,{shown:true},"不传 now 必须走通真实时钟路径");
    const suppressed=await notifyOnce({dataDir,title:"t",message:"m",reasonCode:"pair_waiting",appId:"a",display:async()=>({ok:true})});
    assert.equal(suppressed.reason,"cooldown");
  } finally {rmSync(dataDir,{recursive:true});}
});
test("Toast XML 使用协议激活按钮并正确转义",()=>{
  const xml=buildToastXml({title:"自动命名暂停",message:"远控不可用：<网络超时> & 已跳过",actionLabel:"复制排障提示词并打开 ZCode",actionUri:"suian-zcode-title://fix"});
  assert.ok(xml.includes('activationType="protocol"'));
  assert.ok(xml.includes('launch="suian-zcode-title://fix"'));
  assert.ok(xml.includes("<action "),"按钮必须是 action 元素，否则平台丢弃不显示");
  assert.ok(xml.includes("复制排障提示词并打开 ZCode"));
  assert.ok(xml.includes("&lt;网络超时&gt;"));
  assert.ok(xml.includes("&amp;"));
  assert.ok(!xml.includes("<网络超时>"),"原始文本不能破坏 XML 结构");
});
test("修复提示词仅包含非秘密路径且模板可整体替换",()=>{
  const prompt=buildFixPrompt({pluginRoot:"D:\\CODE\\Project\\_VibeCoding\\ZCode-Plugins\\suian-zcode-title",dataDir:join(tmpdir(),"suian-zcode-title")});
  assert.ok(prompt.includes("suian-zcode-title"),"包含插件目录");
  assert.ok(prompt.includes("suian-zcode-title"),"包含数据目录");
  assert.ok(!prompt.includes("{{"),"/模板变量必须全部替换");
  for(const secret of ["sid=","hash=","mid=","https://zcode.z.ai/remote"])assert.ok(!prompt.includes(secret),"提示词不得携带授权片段");
});
