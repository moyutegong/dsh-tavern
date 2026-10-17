// dsh-tavern install must recreate directory links on Windows without an
// elevated process or Developer Mode: a junction is the only unprivileged
// directory link, and the desktop profile install copies the tavern profile
// (which holds pnpm `link:` dependencies into node_modules) before switching.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { copyTreeSync, junctionTarget, removeTreeSync } from '../bin/portable-fs.mjs'

const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'

test('复制目录链接不需要管理员权限，且复制出的链接仍然可用', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'portable-fs-'))
  try {
    const real = path.join(root, 'real')
    mkdirSync(real)
    writeFileSync(path.join(real, 'marker.txt'), 'payload')
    const source = path.join(root, 'source')
    mkdirSync(source)
    symlinkSync(real, path.join(source, 'link'), directoryLinkType)

    const to = path.join(root, 'copy')
    copyTreeSync(source, to)

    const copied = path.join(to, 'link')
    assert.equal(lstatSync(copied).isSymbolicLink(), true)
    assert.equal(statSync(copied).isDirectory(), true)
    assert.equal(readFileSync(path.join(copied, 'marker.txt'), 'utf8'), 'payload')
  } finally {
    removeTreeSync(root)
  }
})

test('junction 目标按链接所在目录解析，并去掉 Win32 命名空间前缀', { skip: process.platform !== 'win32' }, () => {
  const linkDirectory = 'C:\\profiles\\tavern\\node_modules'
  assert.equal(junctionTarget(linkDirectory, '..\\..\\..\\repo\\pkg'), 'C:\\repo\\pkg')
  assert.equal(junctionTarget(linkDirectory, '\\\\?\\C:\\repo\\pkg'), 'C:\\repo\\pkg')
  assert.equal(junctionTarget(linkDirectory, 'C:\\repo\\pkg'), 'C:\\repo\\pkg')
})
