import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 2026-11-17（用户报的 bug）：他在讲「同事 A 被说不如 B、A 心里不服」，
// 判官把这份不甘算成她的情绪，心情一条一条往下掉。
//
// 修法不是事后拿理由里的名字去猜（那样「A 把她做的说成是他做的」这种真委屈会被一起压平），
// 而是让判官先回答「这一轮情绪的主角是谁」。
// 主角用 owner / self / other / none 四个中性词，不用「她/他」—— 这是给所有人用的插件，
// 用户性别不一定，写死一个代词就是错的。
//
// 这份回归用的是**假造的一轮轮对话**，不是他那三段原话 —— 验的是规则，不是他那一例。

const home = mkdtempSync(join(tmpdir(), 'feiyu-subject-'))
process.env.DSH_HOME = home
const { __测试: api } = await import('../lib/index.js')

const 判 = (obj) => api.parseDelta(JSON.stringify(obj), '小鱿鱼')
const 基本 = { dims: { happy: 0, calm: 0, sweet: 0, heartache: 0, worry: 0, sad: 0, jealous: 0, angry: 0 }, reason: '随便一句', confidence: 85 }

test('讲别人的事（other）：心情归零，情绪不跟着走', () => {
  const d = 判({ ...基本, moodDelta: -4, subject: 'other', dims: { ...基本.dims, sad: -5, heartache: -4, happy: 3, calm: 6 } })
  assert.equal(d.moodDelta, 0, '讲别人的事不该把心情带下去')
  assert.equal(d.dims.sad, 0)
  assert.equal(d.dims.heartache, 0)
  assert.equal(d.dims.calm, 1, '「听着踏实」最多留一点')
  assert.equal(d.dims.happy, 1)
})

test('就是闲聊（none）：一样归零', () => {
  const d = 判({ ...基本, moodDelta: 3, subject: 'none' })
  assert.equal(d.moodDelta, 0)
})

test('主角是对方（owner）、对方受了委屈：照掉，不许抹平', () => {
  // 「同事 A 把对方做的那份说成是他做的」—— 主角是对方，这一轮真该心疼
  const d = 判({ ...基本, moodDelta: -5, subject: 'owner', dims: { ...基本.dims, heartache: 4, worry: 3 } })
  assert.equal(d.moodDelta, -5)
  assert.equal(d.dims.heartache, 4)
})

test('主角是自己（self）：照判', () => {
  const d = 判({ ...基本, moodDelta: -2, subject: 'self' })
  assert.equal(d.moodDelta, -2)
})

test('判官漏写 subject：按 owner 算，不因为漏字段就把真情绪抹掉', () => {
  const d = 判({ ...基本, moodDelta: -3, subject: '' })
  assert.equal(d.moodDelta, -3)
  assert.equal(d.subject, 'owner')
})

test('判官写成中文旧词：也能认（她/我/别人/没谁）', () => {
  assert.equal(判({ ...基本, moodDelta: -3, subject: '她' }).subject, 'owner')
  assert.equal(判({ ...基本, moodDelta: -3, subject: '我' }).subject, 'self')
  assert.equal(判({ ...基本, moodDelta: -3, subject: '别人' }).moodDelta, 0)
  assert.equal(判({ ...基本, moodDelta: -3, subject: '没谁' }).moodDelta, 0)
})

test('写了不认识的字：按 owner 算', () => {
  const d = 判({ ...基本, moodDelta: -2, subject: '某个路人' })
  assert.equal(d.subject, 'owner')
  assert.equal(d.moodDelta, -2)
})
