import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// Only synthetic state; the production module captures this path at import time.
const home = mkdtempSync(join(tmpdir(), 'feiyu-stale-'))
process.env.DSH_HOME = home
const { apply, __测试: helpers } = await import('../lib/index.js')
const result = JSON.stringify({ moodDelta: 9, dims: { happy: 6 }, reason: 'synthetic judgment', confidence: 90 })
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
const slot = (id, sessions) => ({ id, sessions })

function harness(slots = [slot('a', ['session-one'])]) {
  mkdirSync(join(home, 'feiyu-mood'), { recursive: true })
  writeFileSync(join(home, 'feiyu-mood', 'config.json'), JSON.stringify({ slots }))
  helpers.存库({ moods: { probe: helpers.读一份('probe') }, lastActive: 'probe' })
  assert.ok(helpers.读库().moods.probe, 'temporary storage must support atomic writes')
  helpers.存库({ moods: {}, lastActive: '' })
  assert.deepEqual(helpers.读库().moods, {})
  const routes = new Map(), effects = [], intervals = [], calls = []
  function makeAgent(sid) {
    const events = new Map()
    const agent = {
      session: { id: sid, snapshotEvents: () => [
        { type: 'user/message', payload: { text: 'synthetic user', source: { kind: 'user' } } },
        { type: 'assistant/message', payload: { text: 'synthetic reply' } },
      ] },
      options: { provider: 'fake', model: 'deferred' },
      ctx: {
        on(name, fn) { events.set(name, fn); return () => { if (events.get(name) === fn) events.delete(name) } },
        systemPrompt: { context: () => () => {} },
      },
    }
    return { agent, turn: () => events.get('agent/turn-stopping')?.() }
  }
  const first = makeAgent('session-one')
  const agent = first.agent
  let agents = [agent]
  const ctx = {
    agents: { list: () => agents, roots: () => agents },
    effect(fn) { const off = fn(); if (typeof off === 'function') effects.push(off) },
    interval(fn) { intervals.push(fn); return () => {} },
    on: () => () => {},
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } },
    llm: { async *stream() {
      let release
      const pending = new Promise(resolve => { release = resolve })
      calls.push({ release })
      await pending
      yield { type: 'text-delta', text: result }
    } },
  }
  apply(ctx)
  async function request(path, body = {}) {
    const req = Readable.from([JSON.stringify(body)])
    req.url = path; req.method = 'POST'
    let response, status
    await routes.get(path.split('?')[0])(req, { writeHead(code) { status = code }, end(raw) { response = JSON.parse(raw) } })
    assert.equal(status, 200)
    return response
  }
  return {
    calls, request, agent,
    turn: first.turn,
    addAgent(sid) { const next = makeAgent(sid); agents.push(next.agent); return next },
    replaceAgent() { const next = makeAgent('session-one'); agents = [next.agent]; return next },
    tick: () => intervals.forEach(fn => fn()),
    close: () => { agents = [] },
    unload: () => [...effects].reverse().forEach(fn => fn()),
    store: () => helpers.读库(),
    async settle(i = 0) { calls[i].release(); await flush() },
  }
}

test.after(() => rmSync(home, { recursive: true, force: true }))

test('unchanged binding applies one real parsed judgment', async () => {
  const h = harness(); h.turn(); await flush(); await h.settle()
  assert.equal(h.store().moods.a.mood, 73)
  assert.equal(h.store().moods.a.timeline.length, 1)
  h.unload()
})

for (const action of ['unbind', 'rebind', 'ABA', 'delete', 'reset', 'close', 'unload', 'disable-ABA', 'same-id-workspace']) {
  test(`late result is ignored after ${action}`, async () => {
    const h = harness(); h.turn(); await flush()
    assert.equal(h.calls.length, 1)
    if (action === 'unbind') await h.request('/dsh-feiyu-mood/config', { slots: [slot('a', [])] })
    if (action === 'rebind' || action === 'ABA') {
      await h.request('/dsh-feiyu-mood/config', { slots: [slot('b', ['session-one'])] })
      if (action === 'ABA') await h.request('/dsh-feiyu-mood/config', { slots: [slot('a', ['session-one'])] })
    }
    if (action === 'delete') await h.request('/dsh-feiyu-mood/config', { slots: [] })
    if (action === 'reset') await h.request('/dsh-feiyu-mood/reset?key=a')
    if (action === 'close') { h.close(); h.tick() }
    if (action === 'unload') h.unload()
    if (action === 'disable-ABA') {
      await h.request('/dsh-feiyu-mood/config', { autoJudge: false })
      await h.request('/dsh-feiyu-mood/config', { autoJudge: true })
    }
    if (action === 'same-id-workspace') await h.request('/dsh-feiyu-mood/config', { mode: 'workspace', slots: [{ id: 'a', 工作区: 'other' }] })
    await h.settle()
    assert.equal(Object.values(h.store().moods).reduce((n, s) => n + s.timeline.length, 0), 0)
    if (action !== 'reset') assert.deepEqual(h.store().moods, {})
    h.unload()
  })
}

test('queued stale task never calls model and a new binding still works', async () => {
  const h = harness(); h.turn(); await flush(); h.turn()
  await h.request('/dsh-feiyu-mood/config', { slots: [slot('b', ['session-one'])] })
  h.tick(); h.turn(); await h.settle(0)
  assert.equal(h.calls.length, 2, 'only running old task and valid new task invoke model')
  await h.settle(1)
  assert.deepEqual(Object.keys(h.store().moods), ['b'])
  assert.equal(h.store().moods.b.timeline.length, 1)
  h.unload()
})

test('reset invalidates old tasks but permits a newly queued judgment', async () => {
  const h = harness(); h.turn(); await flush()
  await h.request('/dsh-feiyu-mood/reset?key=a')
  h.turn(); await h.settle(0)
  assert.equal(h.store().moods.a.timeline.length, 0)
  assert.equal(h.calls.length, 2)
  await h.settle(1)
  assert.equal(h.store().moods.a.mood, 73)
  assert.equal(h.store().moods.a.timeline.length, 1)
  h.unload()
})

test('judgment merges into the latest stored state, not a pre-await snapshot', async () => {
  const h = harness(); h.turn(); await flush()
  const s = helpers.读一份('a')
  s.mood = 80; s.dims.happy = 4
  s.timeline.push({ at: Date.now(), mood: 80, reason: 'another session updated shared mood' })
  helpers.存一份('a', s)
  await h.settle()
  assert.equal(h.store().moods.a.mood, 83)
  assert.equal(h.store().moods.a.dims.happy, 10)
  assert.equal(h.store().moods.a.timeline.length, 2)
  h.unload()
})

test('unchanged configuration does not invalidate pending judgment', async () => {
  const h = harness(); h.turn(); await flush()
  await h.request('/dsh-feiyu-mood/config', { autoJudge: true })
  await h.settle()
  assert.equal(h.store().moods.a.timeline.length, 1)
  h.unload()
})

test('closing a session blocks a result even before the next mount poll', async () => {
  const h = harness(); h.turn(); await flush(); h.close(); await h.settle()
  assert.deepEqual(h.store().moods, {})
  h.unload()
})

test('unload prevents queued tasks from invoking the model', async () => {
  const h = harness(); h.turn(); await flush(); h.turn(); h.unload(); await h.settle()
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.store().moods, {})
})

test('same sid replacement drops old result and mounts the new agent instance', async () => {
  const h = harness(); h.turn(); await flush()
  const replacement = h.replaceAgent()
  h.tick()
  replacement.turn()
  h.turn() // old instance listener was removed; cannot enqueue another task
  await h.settle(0)
  assert.deepEqual(h.store().moods, {}, 'old instance must not commit')
  assert.equal(h.calls.length, 2, 'new instance is mounted and queued')
  await h.settle(1)
  assert.equal(h.store().moods.a.mood, 73)
  assert.equal(h.store().moods.a.timeline.length, 1)
  assert.equal(h.calls.length, 2)
  h.unload()
})

test('two agents sharing a key apply serially to the latest shared state', async () => {
  const h = harness([slot('a', ['session-one', 'session-two'])])
  const second = h.addAgent('session-two'); h.tick()
  h.turn(); await flush(); second.turn(); await flush()
  assert.equal(h.calls.length, 1, 'second agent waits for the shared judgment chain')
  await h.settle(0)
  assert.equal(h.store().moods.a.mood, 73)
  assert.equal(h.calls.length, 2)
  await h.settle(1)
  assert.deepEqual(Object.keys(h.store().moods), ['a'])
  assert.equal(h.store().moods.a.mood, 76)
  assert.equal(h.store().moods.a.dims.happy, 12)
  assert.equal(h.store().moods.a.timeline.length, 2)
  h.unload()
})

test('resetting one key preserves another agent pending judgment', async () => {
  const h = harness([slot('a', ['session-one']), slot('b', ['session-two'])])
  const second = h.addAgent('session-two'); h.tick()
  h.turn(); await flush(); second.turn()
  await h.request('/dsh-feiyu-mood/reset?key=a')
  await h.settle(0)
  assert.equal(h.store().moods.a.timeline.length, 0)
  assert.equal(h.calls.length, 2, 'unrelated key must still invoke the model')
  await h.settle(1)
  assert.equal(h.store().moods.a.mood, 70)
  assert.equal(h.store().moods.a.timeline.length, 0)
  assert.equal(h.store().moods.b.mood, 73)
  assert.equal(h.store().moods.b.timeline.length, 1)
  h.unload()
})
