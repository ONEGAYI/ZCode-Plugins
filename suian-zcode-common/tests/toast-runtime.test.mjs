import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  toastRootFor, activeToastRecordFor, deployToastRuntime, registerToastIdentity, removeToastIdentity,
  checkToastRuntime, buildForwardVbs, buildStableLauncherVbs, readExecutorText,
} from '../toast-runtime.mjs';

// 全注入 shell：文件用 Map 模拟，注册表键与命令调用全部拦截，不触达真实系统。
const makeShell = () => {
  const files = new Map(), reg = new Map(), ps = [], runs = [];
  const shell = {
    files, reg, ps, runs,
    mkdir: async () => {},
    readText: async path => {
      if (!files.has(path)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return files.get(path);
    },
    writeText: async (path, text) => { files.set(path, text); },
    remove: async path => { files.delete(path); },
    rename: async (from, to) => {
      if (!files.has(from)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      files.set(to, files.get(from));
      files.delete(from);
    },
    stat: async path => (files.has(path) ? { isFile: true } : null),
    run: async (cmd, args) => {
      runs.push({ cmd, args });
      if (args[0] === 'add') { reg.set(args[1], args); return ''; }
      if (args[0] === 'delete') { reg.delete(args[1]); return ''; }
      if (args[0] === 'query') return '    (默认)    REG_SZ    wscript.exe "D:\\stub\\toast-launch.vbs" "%1"';
      if (args[0] === '--check') return '';
      return '';
    },
    ps: async script => { ps.push(script); },
  };
  return shell;
};

const HOME = 'H:\\toast-home';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';

const activeRecord = activeToastRecordFor(HOME);
const deployedWorld = (shell, { executorText = '// executor v1' } = {}) =>
  deployToastRuntime({ homeDir: HOME, nodeExe: NODE, executorText, shell });

test('真实文件系统部署 Toast 成功返回，活动执行器可读',async t=>{
  const home=await mkdtemp(join(tmpdir(),'toast-real-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const result=await deployToastRuntime({homeDir:home,executorText:'export const version=1;'});
  assert.equal(result.action,'deployed');
  assert.equal(await readFile(join(toastRootFor(home),'executor.mjs'),'utf8'),'export const version=1;');
});

test('部署稳定运行时：executor/launch/活动记录落位，均不引用版本缓存与缓存内入口', async () => {
  const shell = makeShell();
  const result = await deployedWorld(shell);
  assert.equal(result.action, 'deployed');
  const toastRoot = toastRootFor(HOME);
  assert.equal(toastRoot, join(HOME, '.zcode', 'tools', 'suian-zcode-common', 'toast'));
  assert.equal(activeRecord, join(HOME, '.zcode', 'tools', 'suian-zcode-common', 'active-toast.json'), '活动记录固定在共享运行根直下，与 PKG-05 网关移除探针对齐');
  const executor = shell.files.get(join(toastRoot, 'executor.mjs'));
  const launcher = shell.files.get(join(toastRoot, 'launch.vbs'));
  const active = JSON.parse(shell.files.get(activeRecord));
  assert.equal(executor, '// executor v1');
  assert.ok(launcher.includes(NODE), '稳定启动器引用安装上下文提供的 Node 路径');
  assert.ok(launcher.includes(join(toastRoot, 'executor.mjs')), '稳定启动器引用缓存外活动执行器');
  assert.ok(!launcher.includes('toast-action.mjs'), '稳定启动器不得引用版本缓存内的命令入口');
  assert.equal(active.formatVersion, 1);
  assert.equal(active.nodeExe, NODE);
  assert.equal(active.executor, 'executor.mjs');
  assert.equal(active.launcher, 'launch.vbs');
  assert.ok(shell.runs.some(run => run.args[0] === '--check'), '部署必须先对暂存执行器做语法校验');
});

test('稳定启动器与转发 vbs 的 URI 采用精确白名单比对，运行参数不进入命令行拼接自由输入', async () => {
  const launcher = buildStableLauncherVbs({ nodeExe: NODE, executorPath: 'D:\\tools\\toast\\executor.mjs' });
  assert.ok(launcher.includes('If uri <> "suian-zcode-common://fix" And uri <> "suian-zcode-title://fix" Then WScript.Quit 1'));
  assert.ok(launcher.includes('WScript.Arguments(0)'));
  const forward = buildForwardVbs({ protocol: 'suian-zcode-title', launcherPath: 'D:\\tools\\toast\\launch.vbs' });
  assert.ok(forward.includes('If uri <> "suian-zcode-title://fix" Then WScript.Quit 1'), '转发桥只接受本协议的 fix 动作');
  assert.ok(!forward.includes('suian-zcode-common://fix" Then'), '转发桥不得放行另一身份的 URI');
  assert.ok(!forward.includes(NODE), '转发桥不直接引用 Node');
  assert.ok(!forward.includes('toast-action.mjs'), '转发桥不得引用版本缓存内的命令入口');
});

test('暂存校验失败保留原活动执行器与活动记录，错误不隐藏原始信息', async () => {
  const shell = makeShell();
  await deployedWorld(shell);
  const toastRoot = toastRootFor(HOME);
  const activeBefore = shell.files.get(activeRecord);
  const executorBefore = shell.files.get(join(toastRoot, 'executor.mjs'));
  const originalRun = shell.run;
  shell.run = async (cmd, args) => {
    if (args[0] === '--check') throw new Error('node --check 失败：SyntaxError: unexpected token');
    return originalRun(cmd, args);
  };
  await assert.rejects(
    deployToastRuntime({ homeDir: HOME, nodeExe: NODE, executorText: '// executor v2', shell }),
    /node --check 失败/,
  );
  assert.equal(shell.files.get(join(toastRoot, 'executor.mjs')), executorBefore, '校验失败不得替换活动执行器');
  assert.equal(shell.files.get(activeRecord), activeBefore, '校验失败不得切换活动记录');
});

test('重复部署幂等：内容一致时 unchanged，不重写活动记录', async () => {
  const shell = makeShell();
  await deployedWorld(shell);
  const toastRoot = toastRootFor(HOME);
  const activeBefore = shell.files.get(activeRecord);
  const checksBefore = shell.runs.filter(run => run.args[0] === '--check').length;
  const again = await deployToastRuntime({ homeDir: HOME, nodeExe: NODE, executorText: '// executor v1', shell });
  assert.equal(again.action, 'unchanged');
  assert.equal(shell.files.get(activeRecord), activeBefore);
  assert.equal(shell.runs.filter(run => run.args[0] === '--check').length, checksBefore, '幂等路径不再执行校验命令');
});

test('启动器写入或活动记录提交失败恢复执行器与启动器，首次失败不残留活动文件', async () => {
  for (const initial of [false,true]) for (const failure of ['launcher','active-write','active-rename']) {
    const shell=makeShell(),root=toastRootFor(HOME);
    if(initial)await deployedWorld(shell);
    const before=new Map(shell.files),write=shell.writeText,rename=shell.rename;
    let failed=false;
    shell.writeText=async(path,text)=>{
      if(!failed&&((failure==='launcher'&&path===join(root,'launch.vbs'))||(failure==='active-write'&&path.includes('.active-toast.tmp-')))) {failed=true;throw new Error('fixture commit failure');}
      return write(path,text);
    };
    shell.rename=async(from,to)=>{
      if(!failed&&failure==='active-rename'&&to===activeRecord) {failed=true;throw new Error('fixture commit failure');}
      return rename(from,to);
    };
    await assert.rejects(deployToastRuntime({homeDir:HOME,nodeExe:'C:\\new-node.exe',executorText:'// executor v2',shell}),/fixture commit failure/);
    for(const path of [join(root,'executor.mjs'),join(root,'launch.vbs'),activeRecord])assert.equal(shell.files.get(path),before.get(path),`${initial}/${failure}: ${path}`);
  }
});

test('身份描述外置按协议隔离；卸载只移除本身份，保留共享运行目录与另一身份', async () => {
  const shell = makeShell();
  await deployedWorld(shell);
  const toastRoot = toastRootFor(HOME);
  const commonDir = 'D:\\data\\common', titleDir = 'D:\\data\\title';
  await registerToastIdentity({ homeDir: HOME, protocol: 'suian-zcode-common', appId: 'SUIAN.SuianZcodeCommon.Toast', dataDir: commonDir, description: '公共', shell });
  await registerToastIdentity({ homeDir: HOME, protocol: 'suian-zcode-title', appId: 'SUIAN.SuianZcodeTitle.Toast', dataDir: titleDir, description: '命名', templateFile: 'toast-prompt-template.md', shell });
  const identities = join(toastRoot, 'identities');
  const commonIdentity = JSON.parse(shell.files.get(join(identities, 'suian-zcode-common.json')));
  const titleIdentity = JSON.parse(shell.files.get(join(identities, 'suian-zcode-title.json')));
  assert.equal(commonIdentity.protocol, 'suian-zcode-common');
  assert.equal(commonIdentity.dataDir, commonDir);
  assert.equal(commonIdentity.templateFile, null);
  assert.equal(titleIdentity.protocol, 'suian-zcode-title');
  assert.equal(titleIdentity.templateFile, 'toast-prompt-template.md');

  await removeToastIdentity({ homeDir: HOME, protocol: 'suian-zcode-title', shell });
  assert.equal(shell.files.has(join(identities, 'suian-zcode-title.json')), false);
  assert.ok(shell.files.has(join(identities, 'suian-zcode-common.json')), '卸载 title 身份不得移除 common 身份');
  assert.ok(shell.files.has(join(toastRoot, 'executor.mjs')), '卸载 title 身份不得移除共享执行器');
  assert.ok(shell.files.has(join(toastRoot, 'launch.vbs')), '卸载 title 身份不得移除稳定启动器');
});

test('安装检查报告部署、身份、模板与实际协议目标；仅凭 AppID 缓存不判健康', async () => {
  const shell = makeShell();
  const toastRoot = toastRootFor(HOME);
  const commonDir = 'D:\\data\\common', titleDir = 'D:\\data\\title';
  shell.files.set(join(commonDir, 'toast-appid.txt'), 'SUIAN.SuianZcodeCommon.Toast');
  // 只有 AppID 缓存，没有任何部署与身份：必须报告不健康
  const bare = await checkToastRuntime({ homeDir: HOME, protocols: ['suian-zcode-common', 'suian-zcode-title'], shell });
  assert.equal(bare.healthy, false);
  assert.equal(bare.deployed.executorPresent, false);
  assert.equal(bare.identities['suian-zcode-common'].registered, false);

  await deployedWorld(shell);
  await registerToastIdentity({ homeDir: HOME, protocol: 'suian-zcode-common', appId: 'SUIAN.SuianZcodeCommon.Toast', dataDir: commonDir, description: '公共', shell });
  await registerToastIdentity({ homeDir: HOME, protocol: 'suian-zcode-title', appId: 'SUIAN.SuianZcodeTitle.Toast', dataDir: titleDir, description: '命名', templateFile: 'toast-prompt-template.md', shell });
  // title 声明了外置模板但文件未落盘：仍不健康
  const noTemplate = await checkToastRuntime({ homeDir: HOME, protocols: ['suian-zcode-common', 'suian-zcode-title'], shell });
  assert.equal(noTemplate.healthy, false);
  assert.equal(noTemplate.identities['suian-zcode-title'].templatePresent, false);

  shell.files.set(join(titleDir, 'toast-prompt-template.md'), '模板');
  const noAnchor = await checkToastRuntime({ homeDir: HOME, shell });
  assert.equal(noAnchor.healthy, false, '旧身份缺少安装清单锚点不能报告健康');
  const pluginsFile = join(HOME, '自定义 存储', 'installed_plugins.json');
  await registerToastIdentity({ homeDir: HOME, protocol: 'suian-zcode-common', appId: 'SUIAN.SuianZcodeCommon.Toast', dataDir: commonDir, pluginsFile, shell });
  await registerToastIdentity({ homeDir: HOME, protocol: 'suian-zcode-title', appId: 'SUIAN.SuianZcodeTitle.Toast', dataDir: titleDir, pluginsFile, templateFile: 'toast-prompt-template.md', shell });
  const healthy = await checkToastRuntime({ homeDir: HOME, protocols: ['suian-zcode-common', 'suian-zcode-title'], shell });
  assert.equal(healthy.healthy, true);
  assert.equal(healthy.identities['suian-zcode-common'].pluginsFile, pluginsFile);
  assert.equal(healthy.deployed.executorPresent, true);
  assert.equal(healthy.deployed.launcherPresent, true);
  assert.ok(healthy.deployed.active, '活动记录必须可读');
  assert.match(healthy.protocols['suian-zcode-common'].command, /wscript\.exe/);
  assert.equal(healthy.identities['suian-zcode-common'].templatePresent, null, 'common 身份无模板文件属正常');
});

test('readExecutorText 部署文本注入日志版本占位符', async () => {
  const text = await readExecutorText();
  const manifest = JSON.parse(await readFile(new URL('../.zcode-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.ok(text.includes(`const LOG_VERSION_PLACEHOLDER = '${manifest.version}';`), '占位符替换为插件清单版本');
  assert.ok(!text.includes("'__SUIAN_COMMON_LOG_VERSION__'"), '部署文本不得残留未替换占位符');
});
