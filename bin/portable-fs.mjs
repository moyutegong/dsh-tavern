// Recursive copy/remove built only on libuv primitives. Node's native fs.cpSync
// and recursive fs.rmSync mishandle non-ASCII Windows paths (e.g. a Chinese user
// name): cpSync fails or crashes, rmSync silently deletes nothing. Fixed upstream
// only in late Node 24 releases (nodejs/node#61878, #56049); installers must not
// depend on the user's Node being new enough.
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import path from 'node:path'

const sleep = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)

// libuv reports reparse-point targets carrying a Win32 namespace prefix.
const WINDOWS_NAMESPACE = /^(?:\\\\\?\\|\?\?\\|\/\/\?\/)/

// A junction must name an absolute local path, and libuv resolves a relative
// target against the current working directory rather than the directory
// holding the link (pnpm's `link:` dependencies are relative), so resolve the
// target against the link's own directory first.
export function junctionTarget(linkDirectory, target) {
  return path.resolve(linkDirectory, target.replace(WINDOWS_NAMESPACE, ''))
}

// A file link has no unprivileged Windows equivalent, so keep the actionable
// hint instead of a bare EPERM.
function createFileLink(target, to) {
  try {
    symlinkSync(target, to)
  } catch (error) {
    if (process.platform !== 'win32' || (error.code !== 'EPERM' && error.code !== 'EACCES')) throw error
    throw new Error('无法创建文件符号链接：Windows 需要管理员权限，或系统已开启“开发者模式”。'
      + `\n  链接：${to}`
      + `\n  目标：${target}`
      + '\n请以管理员身份重新运行安装/更新命令，或在“设置 → 系统 → 开发者选项”中开启开发者模式后重试。', { cause: error })
  }
}

export function copyTreeSync(from, to, { dereference = false } = {}) {
  const stat = dereference ? statSync(from) : lstatSync(from)
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(from)
    const directoryLink = process.platform === 'win32' && statSync(from, { throwIfNoEntry: false })?.isDirectory()
    // Windows lets only an elevated process (or Developer Mode) create a
    // directory symbolic link, but any process may create the equivalent
    // junction, and everything downstream treats the two alike: lstat reports
    // a link, readlink reports the target, removeTreeSync removes both with its
    // rmdir fallback, and the profile switch already installs junctions.
    if (directoryLink) symlinkSync(junctionTarget(path.dirname(from), target), to, 'junction')
    else createFileLink(target, to)
  } else if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) copyTreeSync(path.join(from, name), path.join(to, name), { dereference })
  } else {
    mkdirSync(path.dirname(to), { recursive: true })
    copyFileSync(from, to)
  }
}

// Like rmSync(target, { recursive: true, force: true }); links are removed, never followed.
// Windows may briefly hold handles (antivirus, indexer), so busy entries are retried.
export function removeTreeSync(target, { retries = 0, retryDelay = 100 } = {}) {
  let stat
  try { stat = lstatSync(target) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (stat.isDirectory()) for (const name of readdirSync(target)) removeTreeSync(path.join(target, name), { retries, retryDelay })
  for (let attempt = 0; ; attempt++) {
    try {
      if (!stat.isDirectory()) unlinkSync(target)
      else rmdirSync(target)
      return
    } catch (error) {
      if (error.code === 'ENOENT') return
      // Windows directory symlinks and junctions are unlinked with rmdir.
      if (stat.isSymbolicLink() && ['EPERM', 'EISDIR'].includes(error.code)) { try { rmdirSync(target); return } catch {} }
      if (attempt >= retries || !['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error
      sleep(retryDelay)
    }
  }
}
