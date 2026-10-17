import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('async function importCardFiles(')
const body = source.slice(start, source.indexOf('async function renameCard()', start))
function setup() {
  const state = { status: '', error: '', calls: [], loads: [], refreshes: 0 }
  const importing = { current: false }
  const rpc = async (_, { payload }) => { state.calls.push(payload.name); if (payload.name === 'bad.json') throw new Error('invalid card'); return { card: { path: payload.name } } }
  const parseCardFile = async file => file
  const run = new Function('busy', 'importing', 'setBusy', 'setError', 'setImportStatus', 'rpc', 'parseCardFile', 'notifyTavernDataChanged', 'refreshCards', 'loadCard',
    'importTavernCardFile', 'tavernCardAssetNotice', body + '; return importCardFiles;')(
    false, importing, value => { state.busy = value }, value => { state.error = value }, value => { state.status = value },
    rpc, parseCardFile, () => {}, async () => { state.refreshes++ }, async path => { state.loads.push(path) },
    async (file, call) => call('importCard', { payload: await parseCardFile(file) }), () => '')
  return { state, run, importing }
}

test('single import still opens the imported card; cancelling picker does nothing', async () => {
  const { state, run } = setup()
  await run([])
  assert.equal(state.refreshes, 0)
  await run([{ name: 'a.png' }])
  assert.deepEqual(state.loads, ['a.png'])
})
