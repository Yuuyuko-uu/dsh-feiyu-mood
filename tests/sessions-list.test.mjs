import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⭐ 0.7.8（issue #13）：裸 UUID 的会话也是会话 —— 判据只有「目录里有没有会话文件」
const 家 = mkdtempSync(join(tmpdir(), 'mood-sess-'))
process.env.DSH_HOME = 家

const 会话根 = join(家, 'sessions')
const 缓存根 = join(家, 'storages', 'session_projcache', 'sessions')
mkdirSync(缓存根, { recursive: true })

const 造 = (工作区, 会话, { 有文件 = true, 标题 = '', 归档 = false, 空白 = false } = {}) => {
  const 目录 = join(会话根, 工作区, 会话)
  mkdirSync(目录, { recursive: true })
  if (有文件) writeFileSync(join(目录, 'session.v4.jsonl.zstd'), 'x')
  writeFileSync(join(缓存根, 会话 + '.json'), JSON.stringify({
    version: 1,
    record: { identity: {}, rows: { title: { val: 标题 }, sessionListMetadata: { val: { lastPromptAt: Date.now(), blank: 空白 } } } },
  }))
}

// 一个裸 UUID 会话（Web 界面新建的就是这种）、一个 session- 前缀的、一个中间目录、一个空会话
造('--workspace-A--', '0e9acfb1-dc0c-19d9-4d2b-8021d1229ca0', { 标题: '裸 UUID 的会话' })
造('--workspace-A--', 'session-1234-5678', { 标题: '正常会话' })
造('--workspace-A--', 'aaaa-bbbb-cccc', { 有文件: false, 标题: '中间目录' })
造('--workspace-A--', 'bbbb-cccc-dddd', { 标题: '空会话', 空白: true })

const 模 = await import('../lib/index.js?t=' + Date.now())

test('裸 UUID 的会话能列出来（issue #13）', () => {
  const 单 = 模.会话清单()
  const id们 = 单.map((x) => x.id)
  assert.ok(id们.includes('0e9acfb1-dc0c-19d9-4d2b-8021d1229ca0'), JSON.stringify(单))
})

test('裸 UUID 那条的标题也读得到', () => {
  const 单 = 模.会话清单()
  const 条 = 单.find((x) => x.id === '0e9acfb1-dc0c-19d9-4d2b-8021d1229ca0')
  assert.equal(条 && 条.title, '裸 UUID 的会话')
})

test('session- 前缀的照旧列得出来', () => {
  assert.ok(模.会话清单().some((x) => x.id === 'session-1234-5678'))
})

test('没有会话文件的目录不列（中间目录靠这个排除）', () => {
  assert.ok(!模.会话清单().some((x) => x.id === 'aaaa-bbbb-cccc'))
})

test('空会话（blank）不列', () => {
  assert.ok(!模.会话清单().some((x) => x.id === 'bbbb-cccc-dddd'))
})
