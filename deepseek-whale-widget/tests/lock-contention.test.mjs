// 跨进程启动锁：真正多进程竞争，确认临界区不重叠。
//
// 每个子进程取锁后写 {phase:'enter'|'exit', pid, at}，短暂持锁再释放。
// 主进程断言事件序列严格 enter/exit 交替（不重叠）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOCK_URL = pathToFileURL(path.join(HERE, '..', 'lib', 'start-lock.mjs')).href

const WORKER = `
import fs from 'node:fs'
import { withStartLock } from ${JSON.stringify(LOCK_URL)}

const [eventFile, holdMs, label] = process.argv.slice(2)
const append = (obj) => fs.appendFileSync(eventFile, JSON.stringify(obj) + '\\n')
const res = await withStartLock(async () => {
  append({ phase: 'enter', pid: process.pid, label, at: Date.now() })
  await new Promise((r) => setTimeout(r, Number(holdMs)))
  append({ phase: 'exit', pid: process.pid, label, at: Date.now() })
  return 'ok'
}, { waitMs: 20000 })
if (!res.ok) {
  append({ phase: 'failed', pid: process.pid, label, error: res.error })
  process.exit(2)
}
process.exit(0)
`

test('cross-process lock never lets two critical sections overlap', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-lock-'))
  const eventFile = path.join(temp, 'events.jsonl')
  const workerFile = path.join(temp, 'worker.mjs')
  fs.writeFileSync(workerFile, WORKER, 'utf8')
  t.after(() => {
    try {
      fs.rmSync(temp, { recursive: true, force: true })
    } catch (err) {}
  })

  const env = { ...process.env, DEEPSEEK_WHALE_DATA_DIR: temp }
  const N = 5
  const runs = []
  for (let i = 0; i < N; i++) {
    runs.push(
      new Promise((resolve) => {
        const child = spawn(process.execPath, [workerFile, eventFile, '120', 'w' + i], {
          env,
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        })
        let stderr = ''
        child.stderr.on('data', (c) => (stderr += c))
        child.on('exit', (code) => resolve({ code, stderr, i }))
      })
    )
  }
  const results = await Promise.all(runs)
  for (const r of results) {
    assert.equal(r.code, 0, `worker ${r.i} failed: ${r.stderr}`)
  }

  const events = fs
    .readFileSync(eventFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))

  assert.equal(events.filter((e) => e.phase === 'enter').length, N)
  assert.equal(events.filter((e) => e.phase === 'exit').length, N)
  assert.equal(events.filter((e) => e.phase === 'failed').length, 0)

  // 严格交替：任何 enter 之前必须是空闲或刚 exit
  let inside = false
  for (const ev of events) {
    if (ev.phase === 'enter') {
      assert.equal(inside, false, `overlapping critical section: pid ${ev.pid} entered while another was inside`)
      inside = true
    } else if (ev.phase === 'exit') {
      assert.equal(inside, true, `exit without matching enter: pid ${ev.pid}`)
      inside = false
    }
  }
  assert.equal(inside, false, 'lock left held after all workers finished')

  // 锁文件必须已被释放
  assert.equal(fs.existsSync(path.join(temp, 'overlay-start.lock')), false)
})
