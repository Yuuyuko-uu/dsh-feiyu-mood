// 同一个主人在不同群的群名片不一样 —— 别名清单 / 号码认人 / 自称存不下来
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-alias-'))
process.env.DSH_HOME = home
const { __测试: api } = await import('../lib/index.js')

const 批 = (...行) =>
  ['【新消息】', ...行, '', '请根据情况决定是否回复。如果不需要回应，请只输出 [SILENT]；否则正常回复。'].join('\n')

// ── 别名清单 ────────────────────────────────────────────────
test('群名片跟称呼不一样：列进别名清单就认得出', () => {
  const t = 批('【管理员】阿宝：今晚早点睡', '群友甲：晚安')
  const 无 = api.拆群消息(t, '老大')
  assert.equal(无.ownerSpoke, false, '没列别名时不该认出这是同一个人')
  const 有 = api.拆群消息(t, '老大', ['阿宝'])
  assert.equal(有.ownerSpoke, true)
  assert.equal(有.text, '今晚早点睡')
  assert.equal(有.others.length, 1, '别人的话仍然只是背景')
})

test('别名清单是逗号分隔的字符串也能用（中英文逗号、顿号都认）', () => {
  const t = 批('小鱼儿：在吗')
  assert.equal(api.拆群消息(t, '老大', '小鱼, 小鱼儿').ownerSpoke, true)
  assert.equal(api.拆群消息(t, '老大', '小鱼，小鱼儿').ownerSpoke, true)
  assert.equal(api.拆群消息(t, '老大', '小鱼、小鱼儿').ownerSpoke, true)
})

test('lastUserTurnOf 也走同一套：别名里的名字算「她在说话」', () => {
  const qq = { snapshotEvents: () => [{ type: 'user/message', payload: { text: 批('宝宝：我有点累'), source: { kind: 'qq' } } }] }
  assert.equal(api.lastUserTurnOf(qq, '老大', ['宝宝']).text, '我有点累')
  assert.equal(api.lastUserTurnOf(qq, '老大').text, '', '不列别名时这一批不算她说的')
})

// ── 按号码认人 ──────────────────────────────────────────────
test('署名带号码：称呼不带号码也能认出来', () => {
  const t = 批('优尤（3274796953）：在打单')
  assert.equal(api.拆群消息(t, '优尤').ownerSpoke, true)
})

test('换了群名片但号码一样：照样认得出（改名也不怕）', () => {
  const t = 批('小鱼儿（123456）：在呢')
  assert.equal(api.拆群消息(t, '优尤（123456）').ownerSpoke, true, '按号码认人')
  assert.equal(api.拆群消息(t, '优尤').ownerSpoke, false, '名字和号码都对不上就不认')
})

test('号码不同、名字相同：不认（防同名冒认）', () => {
  const t = 批('优尤（999999）：我是她')
  assert.equal(api.拆群消息(t, '优尤（123456）').ownerSpoke, false)
})

test('全角/半角括号都认', () => {
  assert.equal(api.拆群消息(批('优尤(123456)：在'), '优尤（123456）').ownerSpoke, true)
})

// ── 设置页存不下来 ──────────────────────────────────────────
test('「TA 自称什么」真的存得下来（以前写回配置漏了这个字段）', () => {
  const 存 = api.合并配置(api.默认配置(), { selfPronoun: '本小姐' })
  assert.equal(存.selfPronoun, '本小姐')
  assert.equal(api.读配置().selfPronoun, '本小姐', '落盘之后读回来也得是它')
})

test('自称留空 = 回到默认「我」，不会存成空字符串', () => {
  const 存 = api.合并配置(api.默认配置(), { selfPronoun: '   ' })
  assert.equal(存.selfPronoun, '我')
})

test('群名片别名清单也存得下来', () => {
  const 存 = api.合并配置(api.默认配置(), { ownerAliases: '小鱼, 宝宝' })
  assert.equal(存.ownerAliases, '小鱼, 宝宝')
  assert.equal(api.读配置().ownerAliases, '小鱼, 宝宝')
})
