import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateMarketplaceCandidate } from '../release-marketplace.mjs';

test('市场图标指向仓库内对应的透明小图标', async () => {
  const market = JSON.parse(await readFile(new URL('../marketplace.json', import.meta.url), 'utf8'));
  for (const plugin of market.plugins) {
    assert.equal(plugin.icon, `https://raw.githubusercontent.com/ONEGAYI/ZCode-Plugins/master/assets/icons/${plugin.name}.png`);
    const png = await readFile(new URL(`../assets/icons/${plugin.name}.png`, import.meta.url));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 256);
    assert.equal(png.readUInt32BE(20), 256);
    assert.equal(png[25], 6, '图标必须包含 alpha 通道');
  }
});

test('仓库整体标识供 README 展示', async () => {
  const png = await readFile(new URL('../assets/icons/zcode-plugins.png', import.meta.url));
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
  assert.equal(png[25], 6);
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /assets\/icons\/zcode-plugins\.png/);
});

test('生成发布候选时保留已更新及未更新条目的图标', async () => {
  const current = JSON.parse(await readFile(new URL('../marketplace.json', import.meta.url), 'utf8'));
  const first = current.plugins[0];
  const candidate = generateMarketplaceCandidate({
    current,
    updates: [{ name: first.name, version: first.version, fileName: `${first.name}-${first.version}.zip`, zipSha256: 'a'.repeat(64) }],
    baseUrl: 'https://github.com/ONEGAYI/ZCode-Plugins/releases/download',
    releaseTag: 'icon-test',
  });
  assert.deepEqual(candidate.plugins.map(plugin => plugin.icon), current.plugins.map(plugin => plugin.icon));
});
