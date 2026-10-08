import { fileShell } from './windows.mjs';

export async function checkRuntime({ sqliteBin, run = fileShell.run } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('需要 Node.js 24+；请升级 Node，并在客户端配置中使用该版本的可执行文件');
  if (sqliteBin !== undefined) {
    try {
      const output = await run(sqliteBin, ['-readonly', '-json', ':memory:', `SELECT json_extract('{"ready":1}', '$.ready') AS ready;`], { timeout: 5000 });
      if (JSON.parse(output)[0]?.ready !== 1) throw new Error('SQLite JSON 查询未返回预期结果');
    } catch (error) {
      throw new Error(`sqlite3 CLI 不可用或不支持 -readonly / -json / JSON 查询。请安装 SQLite command-line tools，将 sqlite3 加入 PATH，或设置 config.local.json 的 sqliteBin / SQLITE_BIN 为可执行文件路径。原因：${error.message}`, { cause: error });
    }
  }
  try { await import('ws'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error('公共层缺少 npm 依赖；请在 suian-zcode-common 目录执行 npm ci --ignore-scripts --no-audit --no-fund', { cause: error });
  }
  return { node_version: process.versions.node, ...(sqliteBin === undefined ? {} : { sqlite_bin: sqliteBin }) };
}
