import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repository = path.dirname(root)
const readJson = (name) => JSON.parse(fs.readFileSync(name, 'utf8'))

function contained(relative) {
  const resolved = path.resolve(root, relative)
  assert.ok(resolved.startsWith(root + path.sep), `Path leaves plugin: ${relative}`)
  assert.ok(fs.existsSync(resolved), `Missing plugin file: ${relative}`)
  return resolved
}

test('repository marketplace resolves a complete portable plugin', () => {
  const market = readJson(path.join(repository, 'marketplace.json'))
  const manifest = readJson(path.join(root, '.zcode-plugin/plugin.json'))
  const pkg = readJson(path.join(root, 'package.json'))
  const entry = market.plugins.find((plugin) => plugin.name === manifest.name)
  assert.ok(entry)
  assert.equal(path.resolve(repository, entry.source), root)
  assert.equal(path.basename(root), manifest.name)
  assert.equal(entry.version, manifest.version)
  assert.equal(pkg.version, manifest.version)
  for (const relative of [manifest.skills, manifest.commands, manifest.hooks, 'LICENSE', 'PROVENANCE.md', 'README.md', 'scripts/setup-runtime.ps1']) contained(relative)
  assert.equal(manifest.userConfig.zcode_exe.type, 'file')
  assert.ok(!manifest.userConfig.zcode_exe.default, 'Do not ship a developer-machine executable path')
  assert.equal(manifest.mcpServers[manifest.name].command, '${user_config.zcode_exe}')
  assert.equal(manifest.mcpServers[manifest.name].env.ELECTRON_RUN_AS_NODE, '1')
  for (const arg of manifest.mcpServers[manifest.name].args) contained(arg.replace('${ZCODE_PLUGIN_ROOT}/', ''))
  const hooks = readJson(contained(manifest.hooks))
  assert.deepEqual(Object.keys(hooks.hooks), ['SessionStart'], 'Do not declare unsupported SessionEnd or substitute Stop for session end')
  for (const event of Object.values(hooks.hooks)) {
    for (const group of event) {
      for (const hook of group.hooks) {
        assert.equal(hook.command, '${user_config.zcode_exe}')
        assert.equal(hook.env.ELECTRON_RUN_AS_NODE, '1')
        contained(hook.args[0].replace('${ZCODE_PLUGIN_ROOT}/', ''))
      }
    }
  }
})

test('repository includes complete runtime sources and no local runtime or credentials', () => {
  for (const directory of ['assets', 'desktop', 'lib', 'scripts']) {
    assert.ok(fs.readdirSync(contained(directory)).length > 0)
  }
  for (const relative of ['assets/whale-widget.js', 'assets/overlay-bridge.js', 'assets/DSniang1.png', 'desktop/follow-window.ps1', 'desktop/preload.cjs', 'lib/index.js', 'lib/accounting.mjs']) contained(relative)
  const blocked = /^(?:node_modules|desktop-runtime|electron-downloads|app-snapshots|\.zcode|\.dsh|host\.json|overlay\.json|\.env(?:\..*)?|.*credentials.*|m\[2\]\)|\{for\(const)$/i
  function walk(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.ok(!blocked.test(item.name), `Local artifact must not be shipped: ${path.relative(root, path.join(directory, item.name))}`)
      if (item.isDirectory()) walk(path.join(directory, item.name))
    }
  }
  walk(root)
  assert.ok(fs.existsSync(path.join(repository, '.gitignore')))
  assert.ok(fs.existsSync(path.join(repository, 'README.md')))
})
