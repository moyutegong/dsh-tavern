import { readFileSync, appendFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { waitForExit, switchProfile } from './helper.mjs'
const job = process.argv[2]
const request = JSON.parse(readFileSync(job, 'utf8'))
const log = message => appendFileSync(join(request.stateDir, 'last-run.log'), new Date().toISOString() + ' ' + message + '\n')

/**
 * Desktop processes still alive, excluding this detached worker (which is the same binary).
 * PIDs are captured when the request is queued, so a restarted Host leaves them stale.
 */
function desktopProcessIds() {
  if (process.platform !== 'win32') return []
  try {
    const rows = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    return rows.split(/\r?\n/).filter(line => line.startsWith('"')).map(line => Number(line.split('","')[1]))
      .filter(pid => Number.isInteger(pid) && pid > 1 && pid !== process.pid)
  } catch { return [] }
}

async function waitForDesktopExit(timeout = 60000) {
  if (process.platform !== 'win32') return
  const deadline = Date.now() + timeout
  let seen
  for (;;) {
    const pids = desktopProcessIds()
    const state = pids.join('、')
    if (state !== seen) { seen = state; log(state ? '仍在运行的桌面进程：' + state : '已确认没有桌面进程残留。') }
    if (!pids.length) return
    if (Date.now() >= deadline) { log('等待桌面进程退出超时；仍尝试切换。'); return }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

try {
  log('已排队，请正常退出官方桌面；不会强制结束进程。')
  await waitForExit(request.pids)
  log('记录中的桌面进程已退出（' + request.pids.join('、') + '）。')
  await waitForDesktopExit()
  const note = message => message + '｜存活桌面进程：' + (desktopProcessIds().join('、') || '无')
  log(JSON.stringify(switchProfile(request, { log: note })))
  log('切换完成，请重新打开官方桌面。')
} catch (error) {
  log('ERROR: ' + error.message)
  process.exitCode = 1
} finally {
  unlinkSync(job)
  rmdirSync(dirname(job))
}