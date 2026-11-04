// 心情描述里的「我」跟着「TA 自称什么」走
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-mood-self-'))
process.env.DSH_HOME = home
const { __测试: api } = await import('../lib/index.js')

const 系统 = (me) => api.判断系统({ self: '伙伴', owner: '用户', me, aliases: '' })

test('默认：自称是「我」', () => {
  assert.match(系统('我'), /「我…」/)
})

test('设成「本小姐」：规则里不再出现「我…」那种写法', () => {
  const t = 系统('本小姐')
  assert.ok(!t.includes('「我…」'), '还剩旧的「我…」写法')
  assert.match(t, /「本小姐…」/)
  assert.match(t, /指你自己 → 「本小姐」/)
})

test('没传 me 也不会炸，退回「我」', () => {
  const t = api.判断系统({ self: '伙伴', owner: '用户', aliases: '' })
  assert.match(t, /「我…」/)
})
