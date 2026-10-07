import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.mjs';
import { saveAuthorization } from '../suian-zcode-common/auth-store.mjs';

const { values } = parseArgs({
   options: { 'index-db': { type: 'string' }, 'session-db': { type: 'string' }, 'gateway-config': { type: 'string' }, 'auth-data-dir': { type: 'string' }, 'save-authorization': { type: 'boolean' } },
  allowPositionals: false
});
const root = join(homedir(), '.zcode');
const authDataDir = values['auth-data-dir'] ?? process.env.ZCODE_APP_MCP_AUTH_DATA_DIR ?? join(root, 'tools', 'suian-zcode-app-mcp');
if (values['save-authorization']) {
  let raw = ''; for await (const chunk of process.stdin) raw += chunk;
  const { authorization_url } = JSON.parse(raw);
  await saveAuthorization({ dataDir: authDataDir, url: authorization_url });
  console.log(JSON.stringify({ ok: true, authorization: 'saved' }));
} else {
  const server = createMcpServer({
    authDataDir,
    gatewayConfigPath: values['gateway-config'],
    indexDbPath: values['index-db'] ?? process.env.ZCODE_APP_MCP_INDEX_DB ?? join(root, 'v2', 'tasks-index.sqlite'),
    sessionDbPath: values['session-db'] ?? process.env.ZCODE_APP_MCP_SESSION_DB ?? join(root, 'cli', 'db', 'db.sqlite')
  });
  await server.connect(new StdioServerTransport());
}
