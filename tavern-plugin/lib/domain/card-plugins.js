import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'

// Plugins a DSH card carries (docs/design/dsh-card-format.md). Import keeps their files aside,
// unused; the player turning them on copies them into <data>/plugins/, where the user-plugin
// loader picks them up like any plugin, with a marker naming the one card they belong to.
// Tavern then confines them to that card's games (plugin-api.js `cardScope`).

const MARKER = '.dsh-card.json'
const FOLDER = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_PLUGIN_BYTES = 64 * 1024 * 1024

function invalid(message) { return Object.assign(new Error(message), { code: 'TAVERN_CARD_PLUGIN_INVALID' }) }

export function createCardPlugins({ dataRoot, pluginsDir }) {
  const stagingRoot = path.join(path.resolve(dataRoot), 'card-plugins')
  const installedFolder = (cardKey, folder) => 'card-' + cardKey.slice(0, 10) + '-' + folder
  let scopes = null

  /** Keep a card's plugins aside, unused: [{ folder, name, sha256, purpose, files, bytes }]. */
  async function stage(zip, { cardKey, plugins }) {
    const staged = []
    for (const plugin of plugins) {
      const prefix = String(plugin.path || '').replace(/\/*$/, '/')
      const folder = prefix.split('/')[1] || ''
      if (!prefix.startsWith('plugins/') || prefix.split('/').length !== 3 || !FOLDER.test(folder)) throw invalid('插件路径应为 plugins/<文件夹>/（小写字母、数字、点、下划线、连字符）：' + plugin.path)
      const target = path.join(stagingRoot, cardKey, folder)
      await rm(target, { recursive: true, force: true })
      const hash = createHash('sha256')
      let bytes = 0, files = 0
      const entries = [...zip.entries.values()].filter(entry => entry.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path))
      for (const entry of entries) {
        bytes += entry.size
        if (bytes > MAX_PLUGIN_BYTES) throw invalid('插件 ' + folder + ' 超过 64 MB')
        const relative = entry.path.slice(prefix.length)
        const file = path.join(target, ...relative.split('/'))
        await mkdir(path.dirname(file), { recursive: true })
        const fileHash = createHash('sha256')
        const source = await zip.stream(entry)
        source.on('data', chunk => fileHash.update(chunk))
        await pipeline(source, createWriteStream(file))
        hash.update(relative + '\u0000' + fileHash.digest('hex') + '\n')
        files += 1
      }
      let name = ''
      try { name = String(JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')).name || '') } catch { throw invalid('插件 ' + folder + ' 缺少可读的 package.json') }
      if (!name) throw invalid('插件 ' + folder + ' 的 package.json 没有 name')
      staged.push({ folder, name, sha256: hash.digest('hex'), purpose: String(plugin.purpose || '').slice(0, 200), files, bytes })
    }
    return staged
  }

  async function readScopes() {
    const map = new Map()
    for (const folder of await readdir(pluginsDir).catch(() => [])) {
      try {
        const marker = JSON.parse(await readFile(path.join(pluginsDir, folder, MARKER), 'utf8'))
        const pkg = JSON.parse(await readFile(path.join(pluginsDir, folder, 'package.json'), 'utf8'))
        if (marker.cardPath && pkg.name) map.set(String(pkg.name), { cardPath: String(marker.cardPath), folder })
      } catch {}
    }
    return map
  }

  /** Card plugins in use: plugin name → { cardPath, folder }. */
  async function scope() {
    if (!scopes) scopes = readScopes()
    return await scopes
  }

  async function packageNames() {
    const names = new Map()
    for (const folder of await readdir(pluginsDir).catch(() => [])) {
      try { names.set(String(JSON.parse(await readFile(path.join(pluginsDir, folder, 'package.json'), 'utf8')).name || ''), folder) } catch {}
    }
    return names
  }

  /** Put a card's staged plugins in use, confined to that card. */
  async function enable({ cardKey, cardPath, plugins }) {
    const names = await packageNames()
    for (const plugin of plugins) {
      const target = installedFolder(cardKey, plugin.folder)
      const holder = names.get(plugin.name)
      if (holder && holder !== target) {
        const owner = (await scope()).get(plugin.name)
        throw invalid('已经有同名插件 ' + plugin.name + ' 在用' + (owner ? '（属于人物卡 ' + owner.cardPath + '）' : '（plugins/' + holder + '）') + '，请先停用它')
      }
    }
    await mkdir(pluginsDir, { recursive: true })
    for (const plugin of plugins) {
      const source = path.join(stagingRoot, cardKey, plugin.folder), target = path.join(pluginsDir, installedFolder(cardKey, plugin.folder))
      await rm(target, { recursive: true, force: true })
      await cp(source, target, { recursive: true })
      await writeFile(path.join(target, MARKER), JSON.stringify({ cardPath, sha256: plugin.sha256 }, null, 2))
    }
    scopes = null
  }

  async function disable({ cardKey, plugins }) {
    for (const plugin of plugins) await rm(path.join(pluginsDir, installedFolder(cardKey, plugin.folder)), { recursive: true, force: true })
    scopes = null
  }

  /** A deleted card takes its plugins, used or not, with it. */
  async function remove({ cardKey, plugins }) {
    await disable({ cardKey, plugins })
    await rm(path.join(stagingRoot, cardKey), { recursive: true, force: true })
  }

  return Object.freeze({ stage, enable, disable, remove, scope })
}
