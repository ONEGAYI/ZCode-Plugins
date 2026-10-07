import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.mjs';

const { values } = parseArgs({
  options: { 'index-db': { type: 'string' }, 'session-db': { type: 'string' } },
  allowPositionals: false
});
const root = join(homedir(), '.zcode');
const server = createMcpServer({
  indexDbPath: values['index-db'] ?? process.env.ZCODE_APP_MCP_INDEX_DB ?? join(root, 'v2', 'tasks-index.sqlite'),
  sessionDbPath: values['session-db'] ?? process.env.ZCODE_APP_MCP_SESSION_DB ?? join(root, 'cli', 'db', 'db.sqlite')
});
await server.connect(new StdioServerTransport());
