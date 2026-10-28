import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Only this generated test home is used; production state is never touched.
const home = mkdtempSync(join(tmpdir(), 'feiyu-ws-'))
process.env.DSH_HOME = home
const { __测试: api } = await import('../lib/index.js')
after(() => rmSync(home, { recursive: true, force: true }))

const APOSTROPHE = "D:\\shing_of_kai\\SourceCode\\ShaoZhu'sDSHPlugins"
const APOSTROPHE_KEY = '--D-shing_of_kai-SourceCode-ShaoZhu~0027sDSHPlugins--'

test('project key escapes characters outside [A-Za-z0-9._-] exactly like DSH', () => {
  assert.equal(api.工作区目录名(APOSTROPHE), APOSTROPHE_KEY)
  assert.equal(
    api.工作区目录名('C:\\Users\\Administrator\\Desktop\\鱼鱼窝\\dsh'),
    '--C-Users-Administrator-Desktop-~9C7C~9C7C~7A9D-dsh--',
  )
})

test('literal tilde is escaped instead of kept', () => {
  assert.equal(api.工作区目录名('C:\\a~b'), '--C-a~007Eb--')
})

test('separators collapse and drive colon becomes a dash', () => {
  assert.equal(api.工作区目录名('D:\\\\a//b'), '--D-a-b--')
  assert.equal(api.工作区目录名('\\\\'), '--root--')
})

test('a key is bounded to the same length as DSH', () => {
  const key = api.工作区目录名('C:\\' + 'a'.repeat(300))
  assert.equal(key.length, 255)
  assert.ok(key.startsWith('--C-'))
  assert.ok(key.endsWith('--'))
})

test('an already encoded directory name is returned as is', () => {
  assert.equal(api.工作区目录名(APOSTROPHE_KEY), APOSTROPHE_KEY)
  assert.equal(api.工作区目录名(''), '')
})

test('typing the readable path stores the same key DSH uses', () => {
  assert.equal(api.规整工作区(APOSTROPHE), APOSTROPHE_KEY)
  assert.equal(api.规整工作区(APOSTROPHE_KEY), APOSTROPHE_KEY)
})

test('workspace list matches reverse lookup by path and never adds a 0-session ghost', () => {
  mkdirSync(join(home, 'sessions', APOSTROPHE_KEY, 'session-one'), { recursive: true })
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    tables: {
      workspaces: {
        w1: { path: APOSTROPHE, title: 'plugin-source' },
        // Registered in workspace.json but has no session directory: must not appear as a ghost.
        w2: { path: 'C:\\Users\\Administrator\\Desktop\\鱼鱼窝\\dsh', title: 'fish-nest' },
      },
    },
  }), 'utf8')

  const list = api.工作区清单()
  const hit = list.filter((w) => w.name === APOSTROPHE_KEY)
  assert.equal(hit.length, 1)
  assert.equal(hit[0].path, APOSTROPHE)
  assert.equal(hit[0].title, 'plugin-source')
  assert.equal(hit[0].sessions, 1)
  assert.equal(hit[0].label, APOSTROPHE)

  const ghostNames = list.filter((w) => w.sessions === 0 && w.path)
  assert.deepEqual(ghostNames, [])
  assert.ok(!list.some((w) => w.name === '--C-Users-Administrator-Desktop-~9C7C~9C7C~7A9D-dsh--'))
})

test('a key stored with the old encoder is repaired to the real directory name', () => {
  mkdirSync(join(home, 'sessions', APOSTROPHE_KEY, 'session-one'), { recursive: true })
  mkdirSync(join(home, 'feiyu-mood'), { recursive: true })
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: { w1: { path: APOSTROPHE, title: 'plugin-source' } } },
  }), 'utf8')
  writeFileSync(join(home, 'feiyu-mood', 'config.json'), JSON.stringify({
    模式: 'workspace',
    slots: [{ id: 'slot-1', 工作区: '--D-shing_of_kai-SourceCode-ShaoZhu-sDSHPlugins--', sessions: ['session-one'] }],
  }), 'utf8')

  const cfg = api.读配置()
  assert.equal(cfg.slots[0].工作区, APOSTROPHE_KEY)
})
