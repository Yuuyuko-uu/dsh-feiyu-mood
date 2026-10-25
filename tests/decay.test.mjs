import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// No apply(), host, model or real user state. Only this generated test home is removed.
const home = mkdtempSync(join(tmpdir(), 'feiyu-decay-'))
process.env.DSH_HOME = home
const { __测试: api } = await import('../lib/index.js')
after(() => rmSync(home, { recursive: true, force: true }))
const start = Date.parse('2026-10-25T00:00:00Z')
const initial = () => api.normState({ mood: 80, dims: { happy: 10 }, lastDecayAt: start, lastNotedMood: 80 })
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test('20-second polling with disk reloads matches one read after 90 minutes', () => {
  api.存一份('fixture', initial())
  for (let i = 1; i <= 270; i++) {
    const state = api.读一份('fixture')
    api.decay(state, 50, start + i * 20000, 12)
    api.存一份('fixture', state)
  }
  const frequent = api.读一份('fixture')
  const single = api.decay(initial(), 50, start + 90 * 60000, 12)
  near(frequent.mood, single.mood)
  near(frequent.dims.happy, 5)
  assert.equal(Math.round(frequent.mood), 78)
})

test('mood reaches one half-life across minute-sized updates', () => {
  let state = initial()
  for (let i = 1; i <= 720; i++) state = api.normState(api.decay(state, 50, start + i * 60000, 12))
  near(state.mood, 65)
  near(state.dims.happy, 10 / 256)
})

test('zero mood and fractional values survive normalization and storage', () => {
  const zero = api.normState({ mood: 0, dims: { happy: 0.25 }, lastNotedMood: 0.1 })
  assert.equal(zero.mood, 0)
  api.存一份('fractional', zero)
  const read = api.读一份('fractional')
  near(read.dims.happy, 0.25)
  near(read.lastNotedMood, 0.1)
})

test('no negative time or sub-minute rounding changes', () => {
  const state = initial()
  api.decay(state, 50, start - 1, 12)
  api.decay(state, 50, start + 20000, 12)
  assert.equal(state.mood, 80)
  assert.equal(state.lastDecayAt, start)
})

test('judgment preserves accumulated fractional state; timeline remains integral', () => {
  const state = api.normState({ mood: 75.2, dims: { happy: 5.2 }, lastDecayAt: start })
  const dims = Object.fromEntries(Object.keys(state.dims).map(k => [k, k === 'happy' ? 1 : 0]))
  api.applyDelta(state, { moodDelta: 3, dims, reason: 'fixture', confidence: 100 }, 0, false)
  near(state.mood, 76.2)
  near(state.dims.happy, 6.2)
  assert.equal(state.timeline.at(-1).mood, 76)
  assert.equal(state.timeline.at(-1).dims.happy, 6)
})

test('decay timeline records display values without dropping state precision', () => {
  const state = api.decay(initial(), 50, start + 240 * 60000, 12)
  assert.ok(!Number.isInteger(state.mood))
  assert.ok(Number.isInteger(state.timeline.at(-1).mood))
  assert.ok(Number.isInteger(state.timeline.at(-1).dims.happy))
})
