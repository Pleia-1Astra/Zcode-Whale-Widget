import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DATA_DIR, PLUGIN_ROOT } from './paths.mjs'

// Runtime files must outlive the versioned plugin cache that launched them.
export function prepareRuntimeSnapshot(root = PLUGIN_ROOT, dataDir = DATA_DIR) {
  const entries = ['package.json', '.zcode-plugin/plugin.json', 'desktop', 'lib', 'assets']
  const files = []
  function collect(relative) {
    const full = path.join(root, relative)
    if (fs.statSync(full).isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) collect(path.join(relative, name))
    } else files.push(relative)
  }
  entries.forEach(collect)
  const hash = createHash('sha256')
  for (const file of files) { hash.update(file); hash.update(fs.readFileSync(path.join(root, file))) }
  const destination = path.join(dataDir, 'app-snapshots', hash.digest('hex').slice(0, 24))
  if (fs.existsSync(path.join(destination, '.complete'))) return destination
  const staging = destination + '.tmp-' + process.pid
  fs.mkdirSync(staging, { recursive: true })
  try {
    for (const file of files) {
      const target = path.join(staging, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(root, file), target)
    }
    fs.writeFileSync(path.join(staging, '.complete'), 'ready')
    fs.renameSync(staging, destination)
  } catch (err) {
    if (!fs.existsSync(path.join(destination, '.complete'))) throw err
  } finally { fs.rmSync(staging, { recursive: true, force: true }) }
  return destination
}
