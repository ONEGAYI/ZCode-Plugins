import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {saveAuthorization,loadAuthorization,clearAuthorization} from "../auth-store.mjs";

const freshDir=()=>mkdtempSync(join(tmpdir(),"z-title-auth-"));
test("授权经当前用户 DPAPI 加密落盘并可往返解密，明文不落盘",async()=>{
  const dataDir=freshDir();
  try {
    await saveAuthorization({dataDir,url:"https://zcode.z.ai/remote/v4?sid=secret-sid&hash=secret-hash&mid=secret-mid"});
    const restored=await loadAuthorization({dataDir});
    assert.equal(restored,"https://zcode.z.ai/remote/v4?sid=secret-sid&hash=secret-hash&mid=secret-mid");
    const {readFileSync}=await import("node:fs");
    const blob=readFileSync(join(dataDir,"remote.blob"),"utf8");
    assert.ok(!blob.includes("secret-sid")&&!blob.includes("secret-hash"),"落盘内容必须是密文");
    assert.ok(/^[A-Za-z0-9+/=\r\n]+$/.test(blob),"DPAPI 输出应为 base64");
  } finally {rmSync(dataDir,{recursive:true});}
});
test("未配置返回 null，清除后回到未配置，损坏密文报错而非返回明文猜测",async()=>{
  const dataDir=freshDir();
  const {writeFileSync}=await import("node:fs");
  try {
    assert.equal(await loadAuthorization({dataDir}),null);
    await saveAuthorization({dataDir,url:"https://zcode.z.ai/remote/v4?sid=a&hash=b&mid=c"});
    await clearAuthorization({dataDir});
    assert.equal(await loadAuthorization({dataDir}),null);
    writeFileSync(join(dataDir,"remote.blob"),"not-valid-base64!!!");
    await assert.rejects(loadAuthorization({dataDir}),/解密失败|DPAPI/);
  } finally {rmSync(dataDir,{recursive:true});}
});
