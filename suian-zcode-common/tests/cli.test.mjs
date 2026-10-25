import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

test('独立入口接收公共启动配置，报告健康地址并可正常停止', { timeout: 5000 }, async (t) => {
  const cli = fileURLToPath(new URL('../gateway.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, '--port', '0', '--upstream', 'ws://127.0.0.1:1/ws', '--instance-id', 'fixture-cli'], { windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  const ready = await Promise.race([
    once(child.stdout, 'data').then(([data]) => JSON.parse(data.toString())),
    once(child, 'exit').then(([code]) => { throw new Error(`启动前退出 ${code}: ${errors}`); }),
  ]);
  assert.equal(ready.ok, true);
  assert.match(ready.relay_url, /^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
  // 自包含横幅：首行脱离文件后仍可独立溯源启动时间、模式、端口、协议与构建。
  assert.match(ready.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.equal(ready.mode, 'relay');
  assert.equal(Number(ready.port), Number(new URL(ready.relay_url).port));
  assert.equal(ready.relay_protocol_version, 1);
  assert.equal(ready.build.version, JSON.parse(await readFile(fileURLToPath(new URL('../.zcode-plugin/plugin.json', import.meta.url)), 'utf8')).version);
  assert.match(ready.build.id, /^[0-9a-f]{64}$/);
  assert.match(ready.build.root, /suian-zcode-common/);
  assert.match(ready.node, /^v\d+\./);
  assert.match(String(ready.pid), /^\d+$/);
  assert.equal(ready.config, null, 'CLI 模式无 config 时横幅 config 为 null');
  const health = await (await fetch(ready.health_url)).json();
  assert.equal(health.instance_id, 'fixture-cli');
  assert.equal(health.upstream_url, 'ws://127.0.0.1:1/ws');
  assert.equal(health.desktop_connected, false);
  const stopped = once(child, 'exit');
  child.kill();
  await stopped;
  await assert.rejects(fetch(ready.health_url));
});

test('JSON 的对象端口不能选用 Node listen 重载绕过回环绑定', { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-port-'));
  t.after(() => rm(root, { recursive: true }));
  const configFile = join(root, 'config.json');
  await writeFile(configFile, JSON.stringify({ version: 1, port: { port: 0, host: '127.0.0.1' }, upstream_url: 'ws://127.0.0.1:1/ws', instance_id: 'fixture-port', control_token: 'fixture-port-token' }));
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../gateway.mjs', import.meta.url)), '--config', configFile], { windowsHide: true, timeout: 1500 }), /Invalid gateway port/);
});

test('Windows VBS 启动链加载公共配置，并随网关自行停止正常退出', { skip: process.platform !== 'win32', timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-hidden-'));
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, port: 0, upstream_url: 'ws://127.0.0.1:1/ws', instance_id: 'fixture-hidden', control_token: 'fixture-hidden-token' }));
  const runFile = fileURLToPath(new URL('../run.ps1', import.meta.url)).replaceAll("'", "''");
  const launch = "& '" + runFile + "' -NodePath '" + process.execPath.replaceAll("'", "''") + "' -DataDir '" + root.replaceAll("'", "''") + "'";
  const encoded = Buffer.from(launch, 'utf16le').toString('base64');
  const child = spawn(join(process.env.SystemRoot, 'System32', 'wscript.exe'), ['//B', '//NoLogo', fileURLToPath(new URL('../run.vbs', import.meta.url)), encoded], { windowsHide: true });
  const exited = once(child, 'exit');
  let ready;
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  t.after(async () => {
    if (ready && child.exitCode === null) await fetch(ready.health_url.replace('/health', '/shutdown'), { method: 'POST', headers: { Authorization: 'Bearer fixture-hidden-token' } });
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(root, { recursive: true });
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`启动入口退出 ${child.exitCode}: ${errors}`);
    let output;
    try { output = await readFile(join(root, 'gateway.out.log'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (output?.includes('\n')) { ready = JSON.parse(output.trim()); break; }
    await delay(50);
  }
  assert.ok(ready, '隐藏启动入口应启动 Node 并报告就绪');
  assert.equal((await (await fetch(ready.health_url)).json()).instance_id, 'fixture-hidden');
  const stopped = await fetch(ready.health_url.replace('/health', '/shutdown'), { method: 'POST', headers: { Authorization: 'Bearer fixture-hidden-token' } });
  assert.equal(stopped.status, 200);
  await stopped.json();
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(errors, '');
  await assert.rejects(fetch(ready.health_url));
});

test('配置文件启动的网关只接受本工具令牌停止，拒绝网页和错误令牌', { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-control-'));
  t.after(() => rm(root, { recursive: true }));
  const configFile = join(root, '配置 fixture.json');
  await writeFile(configFile, JSON.stringify({ version: 1, port: 0, upstream_url: 'ws://127.0.0.1:1/ws', instance_id: 'fixture-control', control_token: 'fixture-private-token' }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../gateway.mjs', import.meta.url)), '--config', configFile], { windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  const ready = await Promise.race([
    once(child.stdout, 'data').then(([data]) => JSON.parse(data.toString())),
    once(child, 'exit').then(([code]) => { throw new Error(`启动前退出 ${code}: ${errors}`); }),
  ]);
  const shutdown = ready.health_url.replace('/health', '/shutdown');
  assert.equal(ready.config, configFile, 'config 模式横幅记录配置文件路径');
  const status = await (await fetch(ready.health_url)).json();
  assert.equal(status.instance_id, 'fixture-control');
  assert.ok(!JSON.stringify(status).includes('fixture-private-token'));
  assert.equal((await fetch(shutdown, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(shutdown, { method: 'POST', headers: { Authorization: 'Bearer fixture-private-token', Origin: 'https://example.test' } })).status, 403);
  const exited = once(child, 'exit');
  assert.equal((await fetch(shutdown, { method: 'POST', headers: { Authorization: 'Bearer fixture-private-token' } })).status, 200);
  const [code] = await exited;
  assert.equal(code, 0);
  await assert.rejects(fetch(ready.health_url));
});
