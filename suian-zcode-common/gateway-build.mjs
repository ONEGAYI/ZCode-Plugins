import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = await realpath(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(await readFile(join(root, '.zcode-plugin/plugin.json'), 'utf8')).version;

function digestOf(entries) {
  const hash = createHash('sha256');
  for (const entry of entries) hash.update(entry.path).update('\0').update(entry.content).update('\0');
  return hash.digest('hex');
}

let id;
let deployment;
try { deployment = JSON.parse(await readFile(join(root, 'deployment.json'), 'utf8')); } catch { deployment = null; }
if (deployment) {
  // 部署布局（PKG-05）：指纹对真实部署运行文件计算并逐项校验摘要，
  // 部署被篡改或损坏时在首次加载即失败，不输出可冒充的指纹。
  if (deployment.formatVersion !== 1 || deployment.kind !== 'gateway-runtime' || !Array.isArray(deployment.runtime)) {
    throw new Error('deployment.json is not a valid gateway runtime manifest');
  }
  const entries = [];
  for (const entry of deployment.runtime) {
    const content = await readFile(join(root, entry.path));
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== entry.sha256) throw new Error(`Deployed runtime digest mismatch: ${entry.path}`);
    entries.push({ path: entry.path, content });
  }
  id = digestOf(entries);
  if (id !== deployment.buildId) throw new Error(`Deployed runtime digest mismatch: deployment ${deployment.buildId}`);
} else {
  // 源码布局：网关的固定执行依赖与启动链；文档、技能及其它插件代码不参与。
  const files = [
    'gateway-build.mjs', 'gateway.mjs', 'rpc-broker.mjs', 'rpc-diagnostics.mjs', 'terminal-gateway.mjs', 'terminal-relay.mjs',
    'run.ps1', 'run.vbs', '.zcode-plugin/plugin.json',
    'vendor/remote-shared.js', 'vendor/channelClient.js', 'vendor/serialization.js',
    'vendor/buffer.js', 'vendor/foundation.js', 'vendor/channels.shared.js',
    'node_modules/ws/package.json', 'node_modules/ws/index.js', 'node_modules/ws/wrapper.mjs',
    ...(await readdir(join(root, 'node_modules/ws/lib'))).filter(file => file.endsWith('.js')).map(file => 'node_modules/ws/lib/' + file),
  ].sort();
  id = digestOf(await Promise.all(files.map(async path => ({ path, content: await readFile(join(root, path)) }))));
}

// 在模块首次加载时锁定；/health 不重新读取磁盘，避免旧进程冒报新代码。
export const gatewayBuild = Object.freeze({ id, root, version });
export const gatewayDeployment = deployment ? Object.freeze({ buildId: deployment.buildId, pluginVersion: deployment.pluginVersion ?? null }) : null;

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) console.log(JSON.stringify(gatewayBuild));
