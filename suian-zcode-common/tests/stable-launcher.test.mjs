import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';

import { computeGatewayBuildId, deployGatewayRuntime, ensureLaunchers, writeActiveGateway } from '../gateway-deploy.mjs';

const exec = promisify(execFile);
const commonRoot = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]tests$/, '');
const wscript = () => join(process.env.SystemRoot, 'System32', 'wscript.exe');
const encodedCommand = command => Buffer.from(command, 'utf16le').toString('base64');

async function sourceCopy(t, name = 'stable-src-') {
  const root = await mkdtemp(join(tmpdir(), name));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(commonRoot, root, { recursive: true, filter: path => !['tests', 'docs', '.scratch', 'experiments'].includes(path.slice(commonRoot.length + 1).split(/[\\/]/)[0]) });
  return root;
}

async function writeGatewayConfig(dataDir, overrides = {}) {
  const configFile = join(dataDir, 'config.json');
  await writeFile(configFile, JSON.stringify({ version: 1, port: 0, upstream_url: 'ws://127.0.0.1:1/ws', instance_id: 'stable-launcher-fixture', control_token: 'stable-launcher-token', ...overrides }));
  return configFile;
}

// 用稳定任务参数（wscript → 稳定 VBS → 稳定 PowerShell 启动器）启动部署网关。
// 外层 exit $LASTEXITCODE 把脚本退出码精确传回进程（& 调用脚本内的 exit 只退出脚本作用域）。
async function launchStable(t, toolsRoot, dataDir, configOverrides = {}) {
  const configFile = await writeGatewayConfig(dataDir, configOverrides);
  const psFile = join(toolsRoot, 'launchers', 'run.ps1');
  const launch = `& '${psFile.replaceAll("'", "''")}' -ToolsRoot '${toolsRoot.replaceAll("'", "''")}' -DataDir '${dataDir.replaceAll("'", "''")}'; exit $LASTEXITCODE`;
  const child = spawn(wscript(), ['//B', '//NoLogo', join(toolsRoot, 'launchers', 'gateway-launch.vbs'), encodedCommand(launch)], { windowsHide: true });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  return { child, exited, config };
}

async function waitForHealth(url, { attempts = 60 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await (await fetch(url)).json(); }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  throw lastError;
}

const batchStampPattern = /^gateway-(\d{8}-\d{6})\.(out|error)\.log$/;
const localStamp = (date = new Date()) => {
  const p2 = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${p2(date.getMonth() + 1)}${p2(date.getDate())}-${p2(date.getHours())}${p2(date.getMinutes())}${p2(date.getSeconds())}`;
};

// 启动批次日志：logs/ 下按启动时间命名的成对文件。after 只考虑晚于该时间戳的批次（同一数据目录复用时跳过旧批次）。
async function waitForGatewayLog(dataDir, { attempts = 60, after = null } = {}) {
  const logDir = join(dataDir, 'logs');
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const files = (await readdir(logDir)).map(name => batchStampPattern.exec(name)).filter(Boolean).filter(match => after === null || match[1] > after);
      files.sort((a, b) => a[1].localeCompare(b[1]));
      const newest = files.filter(match => match[2] === 'out').at(-1);
      if (newest) {
        const content = await readFile(join(logDir, `gateway-${newest[1]}.out.log`), 'utf8');
        for (const line of content.trim().split('\n')) {
          if (!line) continue;
          const report = JSON.parse(line);
          if (report.health_url) return report;
        }
      }
    } catch { /* 文件尚未创建或尚未写完 */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`gateway 启动批次日志未就绪: ${logDir}`);
}

async function latestBatchStamp(dataDir) {
  const files = (await readdir(join(dataDir, 'logs'))).map(name => batchStampPattern.exec(name)).filter(Boolean).sort((a, b) => a[1].localeCompare(b[1]));
  return files.at(-1)?.[1] ?? null;
}

test('旧任务参数把安装时缓存编码进 EncodedCommand，缓存删除后无法再启动', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const cache = await sourceCopy(t, 'stable-old-cache-');
  const dataDir = await mkdtemp(join(tmpdir(), 'stable-old-data-'));
  await writeGatewayConfig(dataDir);
  // 旧 setup.ps1 生成的任务参数形态：run.ps1 的绝对路径来自安装时的公共缓存根。
  const oldLaunch = `& '${join(cache, 'run.ps1').replaceAll("'", "''")}' -NodePath '${process.execPath.replaceAll("'", "''")}' -DataDir '${dataDir.replaceAll("'", "''")}'`;
  await rm(cache, { recursive: true, force: true }, { maxRetries: 5 });
  const failure = await promisify(execFile)(wscript(), ['//B', '//NoLogo', join(commonRoot, 'run.vbs'), encodedCommand(oldLaunch)], { windowsHide: true, timeout: 20000 }).then(() => null, error => error);
  assert.ok(failure, '旧任务参数在缓存删除后必须失败');
  assert.notEqual(failure.code, 0, '旧任务参数的失败必须以真实退出码传回，不能伪装成功');
});

test('稳定启动器经活动记录启动部署网关：缓存删除后仍可启动，健康报告 buildId，退出码真实传回', { skip: process.platform !== 'win32', timeout: 40000 }, async t => {
  const cache = await sourceCopy(t, 'stable-new-cache-');
  const toolsRoot = await mkdtemp(join(tmpdir(), 'stable 新 tools-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'stable 数据 dir-'));
  const { buildId } = await deployGatewayRuntime({ sourceRoot: cache, toolsRoot });
  await ensureLaunchers({ sourceRoot: cache, toolsRoot });
  await writeActiveGateway({ toolsRoot, buildId, nodePath: process.execPath });
  await rm(cache, { recursive: true, force: true }, { maxRetries: 5 });

  const stable = await launchStable(t, toolsRoot, dataDir);
  const banner = await waitForGatewayLog(dataDir);
  assert.equal(banner.build.id, buildId, '启动批次日志首行是自包含横幅，报告部署 buildId');
  assert.match(banner.started_at, /^\d{4}-\d{2}-\d{2}T/);
  const healthUrl = banner.health_url;
  const report = await waitForHealth(healthUrl);
  assert.equal(report.service, 'suian-zcode-gateway');
  assert.equal(report.build.id, buildId, '稳定启动器启动的必须是部署的运行文件');
  const stamp = await latestBatchStamp(dataDir);
  assert.match(stamp, /^\d{8}-\d{6}$/, '日志文件按启动时间命名');

  const shutdown = await fetch(healthUrl.replace('/health', '/shutdown'), { method: 'POST', headers: { Authorization: 'Bearer ' + stable.config.control_token } });
  assert.equal(shutdown.status, 200);
  assert.equal(await (await stable.exited)[0], 0, '监督启动链必须传回真实退出码');
});

test('同一任务参数经活动记录切换到另一部署，不再依赖任务参数里的版本', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const firstSource = await sourceCopy(t, 'stable-sw-a-');
  const secondSource = await sourceCopy(t, 'stable-sw-b-');
  const toolsRoot = await mkdtemp(join(tmpdir(), 'stable-switch-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'stable-switch-data-'));
  const secondVariant = join(secondSource, 'terminal-relay.mjs');
  const { writeFile: wf } = await import('node:fs/promises');
  await wf(secondVariant, (await readFile(secondVariant, 'utf8')) + '\n// switch variant\n');
  const first = await deployGatewayRuntime({ sourceRoot: firstSource, toolsRoot });
  const second = await deployGatewayRuntime({ sourceRoot: secondSource, toolsRoot });
  assert.notEqual(first.buildId, second.buildId);
  await ensureLaunchers({ sourceRoot: firstSource, toolsRoot });

  await writeActiveGateway({ toolsRoot, buildId: first.buildId, nodePath: process.execPath });
  const runOne = await launchStable(t, toolsRoot, dataDir);
  const healthOne = (await waitForGatewayLog(dataDir)).health_url;
  assert.equal((await waitForHealth(healthOne)).build.id, first.buildId);
  const stopOne = await fetch(healthOne.replace('/health', '/shutdown'), { method: 'POST', headers: { Authorization: 'Bearer ' + runOne.config.control_token } });
  assert.equal(stopOne.status, 200);
  assert.equal(await (await runOne.exited)[0], 0);
  const firstStamp = await latestBatchStamp(dataDir);

  await writeActiveGateway({ toolsRoot, buildId: second.buildId, nodePath: process.execPath });
  const runTwo = await launchStable(t, toolsRoot, dataDir);
  const healthTwo = (await waitForGatewayLog(dataDir, { after: firstStamp })).health_url;
  assert.equal((await waitForHealth(healthTwo)).build.id, second.buildId, '切换活动记录即可切换部署版本');
  const stopTwo = await fetch(healthTwo.replace('/health', '/shutdown'), { method: 'POST', headers: { Authorization: 'Bearer ' + runTwo.config.control_token } });
  assert.equal(stopTwo.status, 200);
  assert.equal(await (await runTwo.exited)[0], 0);
  assert.equal(await computeGatewayBuildId(secondSource), second.buildId);
});

test('稳定启动器在无活动记录或部署缺失时明确失败并传回退出码', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const cache = await sourceCopy(t, 'stable-missing-');
  const toolsRoot = await mkdtemp(join(tmpdir(), 'stable-missing-tools-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'stable-missing-data-'));
  await ensureLaunchers({ sourceRoot: cache, toolsRoot });
  const psFile = join(toolsRoot, 'launchers', 'run.ps1');
  const launch = `& '${psFile.replaceAll("'", "''")}' -ToolsRoot '${toolsRoot.replaceAll("'", "''")}' -DataDir '${dataDir.replaceAll("'", "''")}'; exit $LASTEXITCODE`;
  const missingActive = await exec(wscript(), ['//B', '//NoLogo', join(toolsRoot, 'launchers', 'gateway-launch.vbs'), encodedCommand(launch)], { windowsHide: true }).then(() => null, error => error);
  assert.ok(missingActive && missingActive.code === 3, '无活动记录必须明确失败（退出码 3）');
  const { buildId } = await deployGatewayRuntime({ sourceRoot: cache, toolsRoot });
  await writeActiveGateway({ toolsRoot, buildId: 'f'.repeat(64), nodePath: process.execPath });
  const missingDeployment = await exec(wscript(), ['//B', '//NoLogo', join(toolsRoot, 'launchers', 'gateway-launch.vbs'), encodedCommand(launch)], { windowsHide: true }).then(() => null, error => error);
  assert.ok(missingDeployment && missingDeployment.code === 4, '部署缺失必须明确失败（退出码 4）');
});

test('健康门：已健康的网关使启动器幂等退出，不产生第二实例', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const cache = await sourceCopy(t, 'gate-live-');
  const toolsRoot = await mkdtemp(join(tmpdir(), 'gate-live-tools-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'gate-live-data-'));
  const { buildId } = await deployGatewayRuntime({ sourceRoot: cache, toolsRoot });
  await ensureLaunchers({ sourceRoot: cache, toolsRoot });
  await writeActiveGateway({ toolsRoot, buildId, nodePath: process.execPath });
  const freePort = await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolvePort(port)); });
  });

  const first = await launchStable(t, toolsRoot, dataDir, { port: freePort });
  const healthUrl = (await waitForGatewayLog(dataDir)).health_url;
  await waitForHealth(healthUrl);
  const stampAfterFirst = await latestBatchStamp(dataDir);

  // 同一配置再次触发任务（看护拉起场景）：启动器必须探测到健康实例后幂等退出。
  const second = await launchStable(t, toolsRoot, dataDir, { port: freePort });
  assert.equal(await (await second.exited)[0], 0, '健康门必须以 0 退出');
  assert.equal(await latestBatchStamp(dataDir), stampAfterFirst, '健康门命中时不产生新的启动批次日志');
  assert.equal((await waitForHealth(healthUrl)).build.id, buildId, '原实例不受影响');

  const stop = await fetch(healthUrl.replace('/health', '/shutdown'), { method: 'POST', headers: { Authorization: 'Bearer ' + first.config.control_token } });
  assert.equal(stop.status, 200);
  assert.equal(await (await first.exited)[0], 0);
});

test('启动批次日志：按启动时间命名、清理 7 天窗口外文件并迁移删除旧根目录日志', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const cache = await sourceCopy(t, 'gate-logs-');
  const toolsRoot = await mkdtemp(join(tmpdir(), 'gate-logs-tools-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'gate-logs-data-'));
  await deployGatewayRuntime({ sourceRoot: cache, toolsRoot });
  await ensureLaunchers({ sourceRoot: cache, toolsRoot });
  await writeActiveGateway({ toolsRoot, buildId: await computeGatewayBuildId(cache), nodePath: process.execPath });

  const logDir = join(dataDir, 'logs');
  await mkdir(logDir);
  await writeFile(join(logDir, 'gateway-20200101-000000.out.log'), 'expired\n');
  await writeFile(join(logDir, 'gateway-20200101-000000.error.log'), 'expired\n');
  const recentStamp = localStamp(new Date(Date.now() - 24 * 3600 * 1000));
  await writeFile(join(logDir, `gateway-${recentStamp}.out.log`), 'recent\n');
  await writeFile(join(logDir, 'gateway-bogus.out.log'), 'irregular-name\n');
  await writeFile(join(dataDir, 'gateway.out.log'), 'legacy\n');
  await writeFile(join(dataDir, 'gateway.error.log'), 'legacy\n');

  const stable = await launchStable(t, toolsRoot, dataDir);
  const healthUrl = (await waitForGatewayLog(dataDir)).health_url;
  await waitForHealth(healthUrl);

  const remaining = (await readdir(logDir)).sort();
  const newStamp = await latestBatchStamp(dataDir);
  assert.notEqual(newStamp, recentStamp);
  assert.deepEqual(remaining, [`gateway-${newStamp}.error.log`, `gateway-${newStamp}.out.log`, `gateway-${recentStamp}.out.log`, 'gateway-bogus.out.log'].sort(), '窗口外批次删除、窗口内与命名不合规文件保留');
  for (const legacy of ['gateway.out.log', 'gateway.error.log']) {
    await assert.rejects(readFile(join(dataDir, legacy)), { code: 'ENOENT' }, '旧根目录单文件日志必须迁移删除');
  }
  const banner = JSON.parse((await readFile(join(logDir, `gateway-${newStamp}.out.log`), 'utf8')).trim().split('\n')[0]);
  assert.match(banner.build.id, /^[0-9a-f]{64}$/, '新批次首行是自包含横幅');

  const stop = await fetch(healthUrl.replace('/health', '/shutdown'), { method: 'POST', headers: { Authorization: 'Bearer ' + stable.config.control_token } });
  assert.equal(stop.status, 200);
  assert.equal(await (await stable.exited)[0], 0);
});

