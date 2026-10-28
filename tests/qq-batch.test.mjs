import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// No apply(), host, model or real user state; only this generated home is removed.
const home = mkdtempSync(join(tmpdir(), 'feiyu-qq-'))
process.env.DSH_HOME = home
const { __测试: api } = await import('../lib/index.js')
after(() => rmSync(home, { recursive: true, force: true }))

const batch = [
  '【新消息】',
  '【管理员】老大：今晚早点睡',
  '群友甲：我也要睡了',
  '群友乙：晚安晚安',
  '',
  '请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 [SILENT]；否则正常回复。',
].join('\n')

const qq = (text, kind = 'qq') => ({
  snapshotEvents: () => [{ type: 'user/message', payload: { text, source: { kind } } }],
})

test('group batch is split into speakers and only the owner lines are kept', () => {
  const parsed = api.拆群消息(batch, '老大')
  assert.ok(parsed)
  assert.equal(parsed.ownerSpoke, true)
  assert.equal(parsed.text, '今晚早点睡')
  assert.deepEqual(parsed.speakers, ['老大', '群友甲', '群友乙'])
  assert.equal(parsed.others.length, 2)
})

test('a batch without the owner yields no owner text', () => {
  const parsed = api.拆群消息(batch, '别人')
  assert.ok(parsed)
  assert.equal(parsed.ownerSpoke, false)
  assert.equal(parsed.text, '')
})

test('owner name may be separated from the role tag', () => {
  const parsed = api.拆群消息('【新消息】\n【管理员】 老大 ：在吗\n群友甲：在', '老大')
  assert.equal(parsed.ownerSpoke, true)
  assert.equal(parsed.text, '在吗')
})

test('multi-line messages stay with their speaker', () => {
  const parsed = api.拆群消息('【新消息】\n群友甲：先说一句\n老大：第一行\n第二行\n群友乙：收到', '老大')
  assert.equal(parsed.text, '第一行\n第二行')
})

test('old or single messages are not treated as a batch', () => {
  assert.equal(api.拆群消息('老大：在吗', '老大'), null)
  assert.equal(api.拆群消息('时间：8 点\n地点：家', '老大'), null)
  assert.equal(api.拆群消息('我发了个 [SILENT] 表情', '老大'), null)
})

test('last user turn keeps only owner lines from a qq group batch', () => {
  const info = api.lastUserTurnOf(qq(batch), '老大')
  assert.ok(info)
  assert.equal(info.sourceKind, 'user')
  assert.equal(info.text, '今晚早点睡')
  assert.ok(!info.text.includes('群友甲'))
})

test('last user turn skips a qq batch where the owner did not speak', () => {
  const info = api.lastUserTurnOf(qq(batch), '别人')
  assert.ok(info)
  assert.equal(info.text, '')
})

test('single private messages and unmarked multi-line messages are unchanged', () => {
  assert.equal(api.lastUserTurnOf(qq('在吗宝宝'), '老大').text, '在吗宝宝')
  const plain = '时间：8 点\n地点：家'
  assert.equal(api.lastUserTurnOf(qq(plain), '老大').text, plain)
})

test('non-bridge sources keep their whole text', () => {
  assert.equal(api.lastUserTurnOf(qq(batch, 'user'), '老大').text, batch)
})
