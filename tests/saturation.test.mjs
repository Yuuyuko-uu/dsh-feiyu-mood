import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⭐ 0.8.5：判定长期偏正（实测 872 条：正 577 / 负 86，幅度合计 +614 / −91 = 6.7:1）的经济学修正。
//   词表那半在提示词里（测不了），这里测**两头饱和**这半 —— 它是有确定行为的代码。
const home = mkdtempSync(join(tmpdir(), 'feiyu-sat-'))
process.env.DSH_HOME = home
const { __测试: api } = await import('../lib/index.js')

const 底 = () => ({
  mood: 60,
  dims: { happy: 0, calm: 0, sweet: 0, heartache: 0, worry: 0, sad: 0, jealous: 0 },
  lastReason: '', lastConfidence: 0, lastNotedMood: 60,
  timeline: [], lastDecayAt: Date.now(), updatedAt: Date.now(), minor: false, kind: '',
})
const 判 = (moodDelta) => ({ moodDelta, dims: {}, reason: 'x', confidence: 80 })

test('平常区间：判定值照旧除以 3（行为没变）', () => {
  const s = 底()
  api.applyDelta(s, 判(9), 0, false)
  assert.equal(s.mood, 63, '9 / 3 = 3')
})

test('接近顶（≥85）：正的减半，负的不减', () => {
  const 高 = { ...底(), mood: 88, lastNotedMood: 88 }
  api.applyDelta(高, 判(9), 0, false)
  assert.equal(高.mood, 90, '9 × 0.5 / 3 = 1.5 → 2')

  const 高2 = { ...底(), mood: 88, lastNotedMood: 88 }
  api.applyDelta(高2, 判(-9), 0, false)
  assert.equal(高2.mood, 85, '负的不受饱和影响：-9 / 3 = -3')
})

test('贴着底（≤40）：负的减半，正的不减', () => {
  const 低 = { ...底(), mood: 35, lastNotedMood: 35 }
  api.applyDelta(低, 判(-9), 0, false)
  assert.equal(低.mood, 34, '-9 × 0.5 / 3 = -1.5 → -1（往零靠）')

  const 低2 = { ...底(), mood: 35, lastNotedMood: 35 }
  api.applyDelta(低2, 判(9), 0, false)
  assert.equal(低2.mood, 38, '正的不受饱和影响')
})

test('饱和只影响大心情，七根情绪照旧全额', () => {
  const s = { ...底(), mood: 90, lastNotedMood: 90 }
  const d = { moodDelta: 9, dims: { happy: 6, calm: 0, sweet: 0, heartache: 0, worry: 0, sad: 0, jealous: 0 }, reason: 'x', confidence: 80 }
  api.applyDelta(s, d, 0, false)
  assert.equal(s.mood, 92, '9 × 0.5 / 3 = 1.5 → 2')
  assert.equal(s.dims.happy, 6, '情绪是即时的那一层，不该被饱和打折')
})

test('timeline 里记的是**实际**挪了几格（跟面板显示对得上）', () => {
  const s = { ...底(), mood: 88, lastNotedMood: 88 }
  api.applyDelta(s, 判(9), 0, false)
  const 条 = s.timeline.at(-1)
  assert.equal(条.delta, 2)
  assert.equal(条.mood, 90)
})
