import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const wrapper = path.join(root, 'scripts/setup-runtime.ps1')

test('PowerShell installer waits for its child and propagates a failed setup', { skip: process.platform !== 'win32' }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-wrapper-test-'))
  try {
    const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper, '-ZCodeExe', process.execPath], {
      cwd: temp,
      env: {
        ...process.env,
        DEEPSEEK_WHALE_DATA_DIR: path.join(temp, 'data'),
        DEEPSEEK_WHALE_ELECTRON_VERSION: '99.99.99',
        DEEPSEEK_WHALE_ELECTRON_ZIP: path.join(temp, 'missing.zip'),
      },
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /"ok": false/)
    assert.match(result.stdout, /"step": "zip"/)
    assert.ok(!fs.existsSync(path.join(temp, 'data/desktop-runtime/node_modules/electron/dist/electron.exe')))
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
