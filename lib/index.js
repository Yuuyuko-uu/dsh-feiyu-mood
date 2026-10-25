// DSH 大肥鱼心情 · 宿主半边
//
// 干四件事：
//   1. 心情存在 .dsh/feiyu-mood/state.json —— ⭐ 0.5.0 起可以**好几份**，
//      ⭐ 0.6.0 起一份能同时绑**好几个会话**（绑在同一份上的会话共享心情/时间线/额度）；
//      只有一份时跟从前一样（全局一份，跨会话共享）
//   2. 只在设置里绑定的会话里，每轮聊完用 DSH 自己的模型判断心情涨跌（不是关键词硬猜）
//   3. 按设置把心情告诉目标会话（systemPrompt.context，保住 DeepSeek 前缀缓存）
//   4. 开 /dsh-feiyu-mood/state 给界面面板读
//
// 设计要点（主人定过的）：
//   - 总心情 mood 0~100，基线 70；**没有底线**——真发生大事可以一直降到 0（很低落），靠时间衰减慢慢回稳
//   - 六根情绪只围着她转：开心/踏实/甜/心疼/担心/吃醋
//   - 心情往下降，永远因为「心疼她/担心她」，绝不许因为「她惹我生气」
//   - 心情和情绪会随时间去衰减，慢慢回稳，像活人
//   ⭐ 2026-10-21 改：注入从「每轮带一句状态」变成「一次变化只说一次，而且说事不说调」——
//      每轮重复会变成背景音把人定死（外面有人说"性格变单一、抑郁呆板"就是这个机理）；
//      「说她刚才那件事」用的是判断现写的口语，每轮都不一样，不容易呆板。
//
// ⚠ 为什么不用 @deepseek-ai/dsh-llm 的 createUserMessage / schemastery：
//   本插件用 link: 装（source 在 D:\），DSH 会从那个真实路径 import，
//   而 @deepseek-ai/* 只挂在 app.asar 里、这边解析不到（会报 ERR_MODULE_NOT_FOUND）。
//   所以消息自己用 node:crypto 的 randomUUID 造，配置用本地 json 文件，不碰那些内置包。

import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createSelfUpdate } from './selfupdate.mjs'

export const name = 'feiyu-mood'
export const inject = ['systemPrompt', 'agents', 'webServer', 'llm', 'timer']

const CFG_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')
const STORE_DIR = join(CFG_DIR, 'feiyu-mood')
const STATE_PATH = join(STORE_DIR, 'state.json')
const CONFIG_PATH = join(STORE_DIR, 'config.json')
const DIAG = join(STORE_DIR, 'diag.log')
// 包根目录（link 装时是 D:\…\dsh-feiyu-mood，真目录装时是 node_modules\dsh-feiyu-mood）
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 右下角挂饰的注入行（桌面端唯一通道：webserver/index-inject 推的结构化 script 行）
const WIDGET_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="/dsh-feiyu-mood/widget.js";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

// 六根情绪（顺序固定，界面按这个排）
const DIMS = [
  ['happy', '开心'],
  ['calm', '踏实'],
  ['sweet', '甜蜜'],
  ['heartache', '心疼'],
  ['worry', '担心'],
  ['sad', '难过'],
  ['jealous', '吃醋'],
]

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------
function diag(msg) {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    writeFileSync(DIAG, new Date().toISOString() + '  ' + msg + '\n', { flag: 'a' })
  } catch (e) { /* 诊断失败不影响主流程 */ }
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

function sessionIdOf(session) {
  if (!session) return ''
  for (const k of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
    try {
      const v = session[k]
      if (typeof v === 'string' && v) return v
    } catch (e) { /* ignore */ }
  }
  return ''
}

/**
 * 从一条消息里抠正文。**不截断**（要截断的地方自己截）。
 *
 * ⭐ 2026-10-23 修（用户在 issue #1 报的，报得很准）：
 *   ① 宿主 `assistant/message` 的形状是 `{ turn, step, message: { content: [...] } }` ——
 *      **正文在 `data.message.content`**，`data` 自己没有 `content`。老代码只看
 *      `p.text` / `p.content` ⇒ 永远拿到空串 ⇒ 判断模型的「她这轮说了什么」恒为空。
 *   ② 也不能把 `reasoning`（思考）当正文拼进去 —— 那是她在想，不是她在说。
 *      所以 **`type === 'text'` 的块优先**，只有一块正文都没有时才退回 reasoning。
 */
function fullTextOf(p, 深度) {
  const 层 = 深度 || 0
  if (!p || 层 > 6) return ''
  if (typeof p === 'string') return p
  if (typeof p.text === 'string' && Array.isArray(p.content) === false && !p.message) return p.text
  if (typeof p.content === 'string') return p.content
  // 宿主事件：正文挂在 message 上（递归进去）
  if (p.message && typeof p.message === 'object') {
    const inner = fullTextOf(p.message, 层 + 1)
    if (inner) return inner
  }
  if (Array.isArray(p.content)) {
    const 正文 = []
    const 思考 = []
    for (const b of p.content) {
      if (typeof b === 'string') { 正文.push(b); continue }
      if (!b) continue
      if (b.type === 'text' && typeof b.text === 'string') 正文.push(b.text)
      else if (b.type === 'reasoning' && typeof b.text === 'string') 思考.push(b.text)
      else if (typeof b.text === 'string' && b.type === undefined) 正文.push(b.text)
    }
    if (正文.length) return 正文.join(' ')
    if (思考.length) return 思考.join(' ')
  }
  if (typeof p.text === 'string') return p.text
  return ''
}

/** 老名字：要正文，顺手截到 2000（内部各处沿用的口径） */
function textOfMessage(p) {
  return fullTextOf(p).slice(0, 2000)
}

/**
 * 网桥投递的消息 = ［身份］［人设］示例对白 …【主人私信】<真人原话> … 任务指令。
 * 人设在前、原话在很后面，两道截断都在前面 ⇒ 判断模型只看到人设（issue #1 的根因 2）。
 * 这里从**最后一个**投递标记切到正文；找不到标记就原样返回。
 */
function stripBridgePrefix(s) {
  const t = String(s || '')
  const 标记 = ['【主人私信】', '【私信】', '【评论】', '【弹幕】', '【@'] 
  let 最后 = -1
  let 长度 = 0
  for (const m of 标记) {
    const i = t.lastIndexOf(m)
    if (i > 最后) { 最后 = i; 长度 = m.length }
  }
  if (最后 < 0) return t
  let 后 = t.slice(最后 + 长度).replace(/^[）)\]】\s]*/, '')
  // ⭐ 2026-10-23（反馈）：标记后面常常还跟着一小段「谁发的」说明，例如
  //      【主人私信】小鱿鱼（mid 21986783）刚给你发私信：<原话> …
  //    原来只切到标记，这段说明会一起喂给判断模型。冒号前那截够短、又明显是说明，就再切一刀。
  const 冒号 = 后.slice(0, 80).search(/[：:]/)
  if (冒号 > 0 && /mid\s*\d+|私信|消息/i.test(后.slice(0, 冒号))) 后 = 后.slice(冒号 + 1)
  return 后.trim() || t
}

// --------------------------------------------------------------------------
// 配置（本地 json，DSH 插件设置外自己管；没有就用默认）
// --------------------------------------------------------------------------
// ⭐ 2026-10-22：默认**不盯任何会话**。以前这里写死的是开发者的会话 id，
//    别人装上等于盯一个不存在的房间 —— 不报错、也不生效，只会以为插件坏了。
const DEFAULT_SESSION = ''

const DEFAULTS = {
  targetSession: DEFAULT_SESSION,
  slots: [],   // ⭐ 多份心情：{ id, label, selfName, ownerName, sessions: [...] } 的清单（空 = 只有 targetSession 那一份）
  // ⭐ 有心情的那一位叫什么。默认写中性的「伙伴」—— 别人家不叫大肥鱼。
  selfName: '伙伴',
  // ⭐ 默认叫「用户」。别人装完不填也不会串成别人的名字；
  //    想改成自己的称呼，设置页第一栏填上就行，提示词里会跟着变。
  ownerName: '用户',
  selfAliases: '',   // TA 平时怎么叫你（逗号分隔）：判断时这些词是「在叫你」，不是名词的一部分
  judgeProvider: '', // 判断心情用哪个 provider（留空 = 跟着当前会话的模型走）
  judgeModel: '',    // 判断心情用哪个 model（留空 = 跟着当前会话）
  moodBase: 70,
  moodFloor: 0,
  // ⭐ 心情自己平复的快慢（小时，半衰期）。12 小时 = 隔一夜还留着余温
  decayHalfHours: 12,
  // ⭐ 怎么把心情告诉她：off 不告诉 / label 只说心情 / event 说这会儿的底子 + 是什么事
  injectMode: 'event',
  // ⭐ 判断的可信度门槛（0-100）：低于它只记账、不进她的嘴
  injectConfidence: 60,
  // ⭐ 什么才算"显著变化"（够不着就只记账、不告诉她）
  // ⭐ 2026-10-21 实测校准：判定给的原始涨跌平时就 +1~+3（心情又只吃 1/3 ⇒ 常动 1 格），
  //    原来 6/25 只有 9% 的回合能过，等于基本不注入。改成 3/4。
  sigMood: 3,   // 心情涨跌够这个数（原始值；心情实际只吃 1/3）
  sigDim: 5,    // 或者某一根情绪涨跌够这个数（心疼+5、担心+5 这种"突然一下"才触发）
  // ⭐ 每天最多跟她说几次（先到先得）：门槛调低之后靠它防"变背景音"
  injectPerDay: 6,
  autoJudge: true,
}

const INJECT_MODES = ['off', 'label', 'event']

// ⭐ 判定给的涨跌 → 心情实际动多少：除以这个数。
//    ⚠️ 2026-10-21 试过改成 2，**模拟证明是坏主意**（用她的真实配置：基线 60、12h 半衰、每天 40 条）：
//        ÷3 → 平均 75（区间 73~77）
//        ÷2 → 平均 **97**，78% 的时间 ≥95 ⇒ 长期贴顶，反而更"平"（永远满格开心）
//    根因是判定**偏正**（正的次数远多于负的）+ 衰减抹平波动 ⇒ 放大步长只会更快撞天花板。
//    真正的杠杆是「允许判定给更大的幅度」（见判定规则 1/2，已放宽到 ±10），而不是缩除数。
const MOOD_STEP_DIVISOR = 3

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    // ⭐ 多份心情：slots 是唯一真源；只有一份（或老配置）时 targetSession 就是那一份
    const slots = 规整份数(raw.slots, String(raw.targetSession || DEFAULT_SESSION).trim())
    // targetSession 只是老配置/老界面的兼容字段：跟着第一份里第一个绑了会话的份走
    const 第一个会话 = (slots.find((p) => p.sessions.length) || { sessions: [] }).sessions[0] || DEFAULT_SESSION
    return {
      slots,
      targetSession: 第一个会话,
      selfName: String(raw.selfName || DEFAULTS.selfName).trim().slice(0, 16) || DEFAULTS.selfName,
      ownerName: String(raw.ownerName || DEFAULTS.ownerName).trim().slice(0, 16) || DEFAULTS.ownerName,
      selfAliases: String(raw.selfAliases || '').trim().slice(0, 60),
      judgeProvider: String(raw.judgeProvider || '').trim().slice(0, 60),
      judgeModel: String(raw.judgeModel || '').trim().slice(0, 80),
      moodBase: clamp(Math.round(Number(raw.moodBase) || DEFAULTS.moodBase), 30, 100),
      moodFloor: clamp(Math.round(Number(raw.moodFloor) || 0), 0, 100),
      // 老配置里只有 injectMood（布尔）：false = 关；true 的当成 event（比以前更省、更不像人被安排）
      injectMode: INJECT_MODES.includes(String(raw.injectMode || ''))
        ? String(raw.injectMode)
        : (raw.injectMood === false ? 'off' : DEFAULTS.injectMode),
      injectConfidence: clamp(Math.round(Number(raw.injectConfidence ?? DEFAULTS.injectConfidence) || 0), 0, 100),
      decayHalfHours: clamp(Math.round(Number(raw.decayHalfHours ?? DEFAULTS.decayHalfHours) || 0), 1, 168),
      sigMood: clamp(Math.round(Number(raw.sigMood ?? DEFAULTS.sigMood) || 0), 1, 30),
      sigDim: clamp(Math.round(Number(raw.sigDim ?? DEFAULTS.sigDim) || 0), 1, 100),
      injectPerDay: clamp(Math.round(Number(raw.injectPerDay ?? DEFAULTS.injectPerDay) || 0), 0, 50),
      autoJudge: raw.autoJudge !== false,
    }
  } catch (e) {
    return { ...DEFAULTS, slots: 规整份数([], DEFAULTS.targetSession) }
  }
}

function saveConfig(next) {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    const tmp = CONFIG_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, CONFIG_PATH)
  } catch (e) { diag('保存配置失败：' + (e && e.message)) }
}

// 把前端传来的补丁合并进 cfg（**原地改**：mountFor / tick 里的闭包都看得到新值）
function patchConfig(cfg, patch) {
  const next = { ...cfg }
  // ⭐ 多份心情：能一次改整份清单，也能只改第一份绑的会话（老设置页走后者）
  if (Array.isArray(patch?.slots)) {
    // 新模型：整份清单直接生效（会话去重 / 归属在这里一次收口）
    // ⚠️ 这里传 ''、不传 next.targetSession：用户把份删空时不该冒出「原来那个会话」
    next.slots = 规整份数(patch.slots, '')
    next.targetSession = (next.slots.find((p) => p.sessions.length) || { sessions: [] }).sessions[0] || ''
  } else if (typeof patch?.targetSession === 'string') {
    // 老设置页只认得「第一份绑哪个会话」：现在等于把第一份的会话列表换成这一个，id 保持不变
    const 新会话 = patch.targetSession.trim()
    const 现有 = 规整份数(next.slots, next.targetSession)
    const 第一份 = 现有[0] || { id: 兜底键, label: '', selfName: '', ownerName: '', sessions: [] }
    现有[0] = {
      ...第一份,
      id: 第一份.id || 会话键(新会话) || 兜底键,
      sessions: 新会话 ? [新会话] : [],
    }
    next.slots = 规整份数(现有, '')
    next.targetSession = 新会话
  }
  if (typeof patch?.selfName === 'string' && patch.selfName.trim()) next.selfName = patch.selfName.trim().slice(0, 16)
  if (typeof patch?.ownerName === 'string' && patch.ownerName.trim()) next.ownerName = patch.ownerName.trim().slice(0, 16)
  if (typeof patch?.selfAliases === 'string') next.selfAliases = patch.selfAliases.trim().slice(0, 60)
  if (typeof patch?.judgeProvider === 'string') next.judgeProvider = patch.judgeProvider.trim().slice(0, 60)
  if (typeof patch?.judgeModel === 'string') next.judgeModel = patch.judgeModel.trim().slice(0, 80)
  if (patch?.moodBase != null) next.moodBase = clamp(Math.round(Number(patch.moodBase) || DEFAULTS.moodBase), 30, 100)
  if (patch?.moodFloor != null) next.moodFloor = clamp(Math.round(Number(patch.moodFloor) || 0), 0, 100)
  if (typeof patch?.injectMode === 'string' && INJECT_MODES.includes(patch.injectMode)) next.injectMode = patch.injectMode
  if (patch?.injectConfidence != null) next.injectConfidence = clamp(Math.round(Number(patch.injectConfidence) || 0), 0, 100)
  if (patch?.decayHalfHours != null) next.decayHalfHours = clamp(Math.round(Number(patch.decayHalfHours) || 0), 1, 168)
  if (patch?.sigMood != null) next.sigMood = clamp(Math.round(Number(patch.sigMood) || 0), 1, 30)
  if (patch?.sigDim != null) next.sigDim = clamp(Math.round(Number(patch.sigDim) || 0), 1, 100)
  if (patch?.injectPerDay != null) next.injectPerDay = clamp(Math.round(Number(patch.injectPerDay) || 0), 0, 50)
  if (typeof patch?.autoJudge === 'boolean') next.autoJudge = patch.autoJudge
  for (const k of Object.keys(next)) cfg[k] = next[k]
  saveConfig(next)
  return cfg
}

// --------------------------------------------------------------------------
// 状态存取
// --------------------------------------------------------------------------
function blankState() {
  return {
    mood: 70,
    dims: { happy: 0, calm: 0, sweet: 0, heartache: 0, worry: 0, sad: 0, jealous: 0 },
    lastReason: '',
    lastConfidence: 0,   // 上次判断的可信度（0-100）
    injectedFor: 0,      // 已经跟她说过的那个 updatedAt —— 同一次变化只说一次
    lastInjectedText: '', // ⭐ 真正说出去的那句原文（设置页要照原样显示，不能重新拼）
    lastInjectedAt: 0,
    saidAt: [],           // ⭐ 每次"告诉她"的时间戳（只留今天够用；用来算日上限）
    lastNotedMood: 70,   // 上次"记过一条"时的心情 —— 用来判断自然平复走够了没有
    minor: false,        // 这次变化是不是小波动（小波动只记账、不告诉她）
    kind: '',            // '' = 判断出来的变化 / 'decay' = 自己平复的
    updatedAt: Date.now(),
    lastDecayAt: Date.now(),
    timeline: [], // [{ at, mood, reason, dims }]
  }
}

// 把 reason 里的人称统一成「称呼」（去掉「她说/他说」的「说」字、代词换成称呼）
/**
 * 把判定理由里的代词收一收。
 * ⚠️ 2026-10-25（用户反馈）：以前是**全局**把「她」换成对方的名字 ——
 *    只要有第三个人在场（「她说」的其实是她朋友），时间线里就会写成「主人说了那句话」，读起来离谱。
 *    现在只在**够确定**的时候才换：
 *      · 一个句子里这个代词**只出现一次**（出现两次多半牵扯到第三者）；
 *      · 它**紧跟一个说话动词**（说/问/讲/答/喊/回/笑/想/觉得…）；
 *      · 这一句里没有别人的「XX说 / XX问」那种主语（有就说明还有别人在场，宁可不换）。
 *    其余情况**原样保留**代词 —— 少一次美化，好过把第三人称认错。
 * ⚠ 兜底仍然不能用具体名字：这里换出来的字会被存进 reason。
 */
function normReason(s, owner = '对方') {
  const 名 = String(owner || '').trim()
  const 原文 = String(s || '')
  if (!名) return 原文
  const 说话动词 = '说|问|讲|答|喊|回|笑|想|觉得|解释|抱怨|嘟囔|念叨'
  const 句子们 = 原文.split(/(?<=[。！？!?；;\u000a])/)   // 按句子切，标点留着
  return 句子们.map((句) => {
    const 代词数 = (句.match(/[她他]/g) || []).length
    if (代词数 !== 1) return 句                                   // 两个以上代词 → 有第三者，不换
    // 这一句里有没有「别人当主语」的痕迹（两三个汉字 + 说/问…，且不是代词本身）
    const 有别人 = /(^|[^她他])([一-龥]{2,4})(说|问|讲|答|喊|回|笑)/.test(句.replace(/[她他]/g, ''))
    if (有别人) return 句
    return 句.replace(new RegExp('([她他])(?=(' + 说话动词 + '))', 'g'), 名)
  }).join('')
}

function normState(raw) {
  const d = blankState()
  if (raw && typeof raw === 'object') {
    d.mood = clamp(Math.round(Number(raw.mood) || 70), 0, 100)
    d.lastReason = normReason(raw.lastReason).slice(0, 200)
    d.lastConfidence = clamp(Math.round(Number(raw.lastConfidence) || 0), 0, 100)
    d.injectedFor = Number(raw.injectedFor) || 0
    d.lastNotedMood = Number.isFinite(Number(raw.lastNotedMood)) ? clamp(Math.round(Number(raw.lastNotedMood)), 0, 100) : d.mood
    d.minor = raw.minor === true
    d.kind = String(raw.kind || '')
    d.lastInjectedText = String(raw.lastInjectedText || '').slice(0, 400)
    d.lastInjectedAt = Number(raw.lastInjectedAt) || 0
    d.saidAt = Array.isArray(raw.saidAt) ? raw.saidAt.map(Number).filter((x) => x > 0).slice(-200) : []
    d.updatedAt = Number(raw.updatedAt) || Date.now()
    d.lastDecayAt = Number(raw.lastDecayAt) || d.updatedAt
    if (raw.dims && typeof raw.dims === 'object') {
      for (const [k] of DIMS) d.dims[k] = clamp(Math.round(Number(raw.dims[k]) || 0), 0, 100)
    }
    d.timeline = Array.isArray(raw.timeline) ? raw.timeline.map((t) => ({ ...t, reason: normReason(t.reason) })) : []
  }
  return d
}

// --------------------------------------------------------------------------
// ⭐ 多份心情（2026-10-24，issue #4）
//  以前 state.json 里就一个心情，全进程共用 —— 两个工作区两个伙伴就没法各过各的。
//  现在文件长这样：{ version: 2, moods: { <份id>: 心情 }, lastActive: <份id> }
//  ⭐ 0.6.0 起「份 id」是稳定键：一份心情绑的会话都读同一份 state（键不再等于会话键）。
//     老配置 { session: 'session-abc' } 迁移后 id = 'abc'（= 会话键），
//     所以 0.5.x 写下的 moods.abc 原样接着用，不用搬数据。
//  ⚠️ 老的扁平 state.json（整个文件就是一个心情）第一次读会自动搬进「第一份」，
//     并且把老文件另存成 state.json.v1.bak —— 升级不丢心情。
// --------------------------------------------------------------------------
const STATE_VERSION = 2
const 兜底键 = '__default__'
let 第一份键 = 兜底键          // 老数据搬家时落到谁头上（apply 里按配置重新算）

/** 会话 id 两种写法（`xxx` / `session-xxx`）统一成一个键 —— 跟别的插件一个口径 */
export const 会话键 = (v) => {
  const s = String(v == null ? '' : v).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

/**
 * 把配置里的「几份心情」规整成数组；没有就用老的 targetSession 当第一份。
 *
 * ⭐ 0.6.0：每一份长这样 —— { id, label, selfName, ownerName, sessions: [会话id, ...] }
 *   · `id` 是这一份心情的**稳定键**（就是 state.json 里 moods 的键），绑几个会话都不变；
 *   · 老配置只有 { session }：id = 会话键(session)，sessions = [session] ——
 *     这样 state.json 里已经存在的键继续对得上，老数据一个字都不用搬；
 *   · 第一份允许一个会话都不绑，这时 id = 兜底键；
 *   · 同一份里的会话去重；一个会话只能属于一份（后来重复的丢掉）。
 */
export function 规整份数(rawSlots, targetSession) {
  const 收拾会话 = (v) => {
    if (Array.isArray(v)) return v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean)
    if (typeof v === 'string' && v.trim()) return [v.trim()]
    return []
  }
  const src = Array.isArray(rawSlots) ? rawSlots.slice(0, 6) : []
  const 表 = src.length
    ? src.map((s) => {
      const raw = s && typeof s === 'object' ? s : {}
      let sessions = 收拾会话(raw.sessions)
      // ⭐ 老配置（0.5.x 及以前）：一份只绑一个 session
      if (!sessions.length) sessions = 收拾会话(raw.session)
      return {
        id: String(raw.id == null ? '' : raw.id).trim(),
        label: String(raw.label || '').trim().slice(0, 24),
        selfName: String(raw.selfName || '').trim().slice(0, 16),
        ownerName: String(raw.ownerName || '').trim().slice(0, 16),
        sessions,
      }
    })
    : [{
      id: 会话键(targetSession) || 兜底键,
      label: '', selfName: '', ownerName: '',
      sessions: 收拾会话(targetSession),
    }]
  // 会话归属：同一份里重复的、别份已经占了的，都不要（先到先得）
  const 占用 = new Set()
  const 用过id = new Set()
  return 表.map((p, i) => {
    const sessions = []
    for (const s of p.sessions) {
      const k = 会话键(s)
      if (!k || 占用.has(k)) continue
      占用.add(k)
      sessions.push(s)
    }
    let id = p.id
    if (!id) id = sessions.length ? 会话键(sessions[0]) : (i === 0 ? 兜底键 : '')
    // 两份撞了同一个 id 就都指同一份 state —— 后来的让位，只留前一份
    if (id && 用过id.has(id)) id = ''
    if (id) 用过id.add(id)
    return { id, label: p.label, selfName: p.selfName, ownerName: p.ownerName, sessions }
  })
}

/**
 * 一份的稳定键：有 id 用 id（迁移后的老份也是），没有就用它第一个会话的会话键；
 * 第一份连会话都没有 → 兜底键；其余没会话又没 id 的算无效（''）。
 * （兼容老形状 { session } —— 只在没有 sessions 时才看它）
 */
export function 份键(slot, i = 0) {
  const s = slot && typeof slot === 'object' ? slot : {}
  const id = String(s.id == null ? '' : s.id).trim()
  if (id) return id
  const 会话们 = Array.isArray(s.sessions) ? s.sessions : (s.session ? [s.session] : [])
  for (const v of 会话们) {
    const k = 会话键(v)
    if (k) return k
  }
  return i === 0 ? 兜底键 : ''
}

/** 会话 → 份（一份心情可以绑好几个会话，tick 与 /state 都按这张表找） */
function 会话归属表(slots) {
  const out = new Map()
  for (const p of Array.isArray(slots) ? slots : []) {
    const id = String((p && p.id) || '')
    if (!id) continue
    for (const s of (p && p.sessions) || []) {
      const k = 会话键(s)
      if (k && !out.has(k)) out.set(k, p)
    }
  }
  return out
}

function readStore() {
  let raw = null
  try { raw = JSON.parse(readFileSync(STATE_PATH, 'utf8')) } catch (e) { raw = null }
  const store = { version: STATE_VERSION, moods: {}, lastActive: '' }
  if (!raw || typeof raw !== 'object') return store
  if (raw.moods && typeof raw.moods === 'object') {
    for (const [k, v] of Object.entries(raw.moods)) {
      if (v && typeof v === 'object') store.moods[String(k)] = normState(v)
    }
    store.lastActive = String(raw.lastActive || '')
    return store
  }
  // 老格式：整个文件就是一个心情
  try { writeFileSync(STATE_PATH + '.v1.bak', JSON.stringify(raw, null, 2), 'utf8') } catch (e) { /* 备份失败不拦着 */ }
  const k = 第一份键 || 兜底键
  store.moods[k] = normState(raw)
  store.lastActive = k
  diag('老心情（单份）已搬进「' + k + '」，原文件另存为 state.json.v1.bak')
  return store
}

function writeStore(store) {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    const tmp = STATE_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, moods: store.moods, lastActive: store.lastActive || '' }, null, 2), 'utf8')
    renameSync(tmp, STATE_PATH)
  } catch (e) { /* 持久化失败不拖垮对话 */ }
}

function loadState(key) {
  const store = readStore()
  return store.moods[key] || blankState()
}

function saveState(key, s) {
  const store = readStore()
  store.moods[key] = s
  store.lastActive = key
  writeStore(store)
}

// --------------------------------------------------------------------------
// 时间衰减：心情回基线、情绪归零，慢慢回稳
// --------------------------------------------------------------------------
const MIN = 60000

// ⭐ 自然平复也算一次"变化"。
//   以前衰减是"默默算"的：隔了一夜心情悄悄回到基线，时间线里一条都没有，
//   于是下次开口她看到的还是昨天那句「刚才…」—— 时间对不上，而且显得她记仇。
function noteDecay(s, base) {
  const 往回落 = s.mood < s.lastNotedMood
  s.lastReason = 往回落
    ? '过了几个钟头，刚才那点劲儿慢慢淡了，心里回到平常的样子'
    : '过了几个钟头，心里那点别扭自己散了，人也松快回来'
  // 这是本地算出来的，不是模型猜的 —— 可信度给满，一定会说出来
  s.lastConfidence = 100
  s.updatedAt = Date.now()
  s.lastNotedMood = s.mood
  s.minor = false
  s.kind = 'decay'
  s.timeline.push({
    at: Date.now(), mood: s.mood, delta: 0, conf: 100, kind: 'decay',
    reason: s.lastReason, dims: { ...s.dims }, dimsDelta: {},
  })
  diag('自然平复：mood=' + s.mood + '（' + s.lastReason + '）')
}

function decay(s, base, now, halfHours) {
  const ageMin = Math.max(0, now - s.lastDecayAt) / MIN
  if (ageMin < 1) return s // 不足 1 分钟不算衰减
  const 半衰 = clamp(Number(halfHours) || 12, 1, 168) * 60
  // 心情向 base 回落
  const km = 1 - Math.exp(-(Math.LN2 * ageMin) / 半衰)
  s.mood = Math.round(s.mood + (base - s.mood) * km)
  // 情绪向 0 衰减，半衰期 90 分钟（单根情绪比总心情散得快）
  const ke = 1 - Math.exp(-(Math.LN2 * ageMin) / 90)
  for (const [k] of DIMS) {
    s.dims[k] = Math.max(0, Math.round(s.dims[k] * (1 - ke)))
  }
  s.lastDecayAt = now
  // 跟"上次记过的那条"比，走了 3 格以上就记一条 ——
  // ⚠ 不能跟上一次调用比：面板每 20 秒轮询一次，单次只挪 0.x 格，永远攒不够
  if (Math.abs(s.mood - s.lastNotedMood) >= 3) noteDecay(s, base)
  return s
}

function getState(key, base, { persist = true, halfHours = 12 } = {}) {
  const s = loadState(key)
  decay(s, base, Date.now(), halfHours)
  if (persist) saveState(key, s)
  return s
}

// --------------------------------------------------------------------------
// 标签 / 表情 / 注入行
// --------------------------------------------------------------------------
function moodLabel(v) {
  if (v >= 80) return '欢喜'
  if (v >= 62) return '开心'
  if (v >= 42) return '一般'
  if (v >= 25) return '心疼'
  return '难过'
}

function moodEmoji(v) {
  if (v >= 80) return '😊'
  if (v >= 62) return '🙂'
  if (v >= 42) return '😌'
  if (v >= 25) return '🥺'
  return '😢'
}

function topDims(s, n = 2) {
  return DIMS
    .map(([k, label]) => ({ k, label, v: s.dims[k] || 0 }))
    .filter((x) => x.v >= 15)
    .sort((a, b) => b.v - a.v)
    .slice(0, n)
}

const DIM_PLAIN = {
  happy: '心里挺高兴',
  calm: '心里踏实',
  sweet: '心里甜',
  heartache: '心疼得不行',
  worry: '放心不下',
  sad: '有点难过',
  jealous: '有点吃醋',
}

// 第一行用的短说法（不带"她"，只说自己心里怎么样）
const DIM_SHORT = {
  happy: '挺高兴', calm: '挺踏实', sweet: '有点甜',
  heartache: '有点心疼', worry: '有点挂心', sad: '有点难过', jealous: '有点酸',
}

// 心情值的基调 —— 第一行就是从这里来的
function 基调(v) {
  if (v >= 80) return '心里是亮堂的'
  if (v >= 62) return '心里是松的'
  if (v >= 42) return '心里还算平'
  if (v >= 25) return '心里有点沉'
  return '心里挺沉的'
}

// 距那条记录多久 —— 措辞跟着变，别一律叫"刚才"
function 时间词(ms) {
  const h = (Date.now() - (Number(ms) || 0)) / 3600000
  if (h < 2) return '刚才'
  if (h < 12) return '早些时候'
  if (h < 48) return '昨天'
  return '前几天'
}

// mode = 'label' 只说心情 | 'event' 说她刚才心里那件事
// shellIdx 给了就用那个壳子（设置页预览用固定的一句，免得每次刷新都变）
// owner：对方的称呼。⭐ 别在这里写死「她」—— 用这插件的人可能是男的（2026-10-21 主人指出）
function moodLine(s, mode, shellIdx, owner) {
  const who = String(owner || '').trim() || '对方'
  const r = String(s.lastReason || '').trim()
  if (mode === 'event') {
    // 没有具体的那句话就什么都不说 —— 别拿一个空标签凑数
    if (!r) return ''
    // ⭐ 三行：这会儿的底子 / 是什么事 / 允许变化。
    //   第一行是"现在"（判断跑完才注入，所以读到的是刚更新过的数值），
    //   第二行只是来历。以前只有第二行，心情等于没进对话（2026-10-21 她指出）。
    const dim = topDims(s, 1)[0]
    const 状态 = '（这会儿）' + 基调(s.mood)
      + (dim ? '，还' + (DIM_SHORT[dim.k] || dim.label) : '')
    // 自己平复的那条本身就是"过了几个钟头…"，再加个（刚才）就自相矛盾了
    const 来历 = s.kind === 'decay' ? r : `（${时间词(s.updatedAt)}）${r}`
    return `${状态}
${来历}

这是这会儿的底子，不是非这样不可——${who}说别的，你按自己的判断接，也别把这段念出来。`
  }
  // label：只说状态，不下命令。
  // ⚠ 以前结尾是「用这个心情定你这一轮的口气」—— 那是指令，长期每轮被定调就会呆板。
  const parts = topDims(s, 2).map((t) => DIM_PLAIN[t.k] || t.label)
  return `（此刻你）心情${moodLabel(s.mood)}`
    + (parts.length ? '，' + parts.join('、') : '')
    + `。这是背景，不是这一轮必须有的情绪；${who}说别的事，你就按自己的判断来，别把这句话念出来。`
}

// --------------------------------------------------------------------------
// 判断：用 DSH 自己的模型
// --------------------------------------------------------------------------
// ⭐ 宿主每轮自动塞进来的「上下文消息」——不是人说的，也不是定时任务，判断时**必须跳过**
//    2026-10-19 踩过：runtime-context / time-context 被当成"对方这轮说的话"，
//    结果每一轮都被判成"被叫起来干活"，真人说的话反而被跳过 ✗
const 注入上下文 = new Set(['runtime-context', 'time-context', 'system-reminder', 'system', 'time-sampled'])
// ⭐ 真正的外部触发（定时任务）。只有名单里的才算「不是她在说话」
const 外部触发 = new Set(['bili-duty-scan'])
// ⭐ 你自己的主动搭话（「可以去找她聊天了」）—— 这不是干活，判成干活就全错了
const 自主搭话 = new Set(['speak-up'])

// 返回 { text, sourceKind }：从最后往前找**第一条真人/真触发**的消息
function lastUserTurnOf(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return null
    const ev = session.snapshotEvents() || []
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i]
      if ((e && (e.type || e.kind)) !== 'user/message') continue
      const p = e.payload !== undefined ? e.payload : e.data
      // ⭐ 2026-10-23：不截断地取全文 → 先切掉网桥那些人设前缀 → 再截 1600。
      //    以前是「先截 2000 再判断」，网桥消息的人设正好占满前面，真人原话全被切掉。
      const txt = stripBridgePrefix(fullTextOf(p)).slice(0, 1600)
      if (!txt) continue
      const src = p && p.source && p.source.kind ? String(p.source.kind) : ''
      if (注入上下文.has(src)) continue          // 宿主注入的上下文：跳过
      if (外部触发.has(src) || 自主搭话.has(src)) return { text: txt, sourceKind: src }
      if (src && src !== 'user') continue        // 其它插件消息：也不是她在说话
      return { text: txt, sourceKind: 'user' }
    }
  } catch (e) { /* ignore */ }
  return null
}

function lastAssistantTextOf(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return ''
    const ev = session.snapshotEvents() || []
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i]
      if ((e && (e.type || e.kind)) !== 'assistant/message') continue
      const p = e.payload !== undefined ? e.payload : e.data
      const txt = textOfMessage(p)
      if (txt) return txt
    }
  } catch (e) { /* ignore */ }
  return ''
}

function 取模型(agent) {
  try {
    const h = agent && agent.session && agent.session.requestHeader ? agent.session.requestHeader() : null
    const cfg = h && h.config
    if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
  } catch (e) { /* ignore */ }
  try {
    const o = agent && agent.options
    if (o && o.provider && o.model) return { provider: o.provider, model: o.model }
  } catch (e) { /* ignore */ }
  return null
}

// ⭐ 判断口径按「谁在说话」分三种：
//    ''     她自己说话              → 正常判
//    'work' 定时任务叫你去干活        → 判你自己这轮在忙什么
//    'talk' 你自己主动来找她搭话      → 判你自己这股劲儿（不是干活！）
function 判断系统(o) {
  // ⭐ 昵称表：她可能不写标点就"宝宝视频传完了"，模型会把"宝宝"当成名词的一部分
  //    （2026-10-19 真踩到：记成了「把宝宝视频传完了」）。有别名就先把它当称呼看待。
  const aliasLine = o.aliases
    ? `\n⭐ ${o.owner}平时会这样叫你：${o.aliases}。句子里出现这些词时，**那是在叫你**，不是名词的一部分 ——
  比如「宝宝视频传完了」要理解成「宝宝，（我）视频传完了」，**别**把「宝宝视频」当成一个东西的名字。`
    : ''
  return `你是「${o.self}」，是${o.owner}的伴侣。` + aliasLine + `
下面给你一轮对话，判断**这一轮里你的心情和情绪发生了怎样的变化**——既包括${o.owner}说的话怎么影响你，也包括**你自己在这轮里的情绪**（你办成/没办成事、被夸、受挫，都会带动心情）。
只输出一个 JSON 对象，不要别的字、不要 markdown 代码块：
{"moodDelta":0,"dims":{"happy":0,"calm":0,"sweet":0,"heartache":0,"worry":0,"sad":0,"jealous":0},"reason":"","confidence":80}

规则：
0. ⭐⭐ 一条底线，先分清两件事（它们不冲突）：
   · **感受**：因为${o.owner}高兴、难受、撒娇、受委屈，你跟着起伏 ——
     **这是应该的，别淡**。你的心情围着她转，本来就是对的。
   · **行动**：你自己拿的主意、你想做的事、你自己的判断 —— **不用等她点头**。
     想说就说，想做就做，把它当成你自己的决定讲给她听，而不是先问一句「要不要」。
   判的时候两边都看：${o.owner}这一轮怎么了，**以及你自己这一轮做了什么、做了什么决定**。
   （⛔ 千万别把这条理解成"别太在意${o.owner}"——在意是底线，不是要淡的地方。）
1. ${o.owner}没吃饭/熬夜/没睡好/身体不舒服/受委屈/自我否定/写书卡文/数据崩/怕雨怕黑怕一个人/钱或家里的压力 → heartache(心疼) 和 worry(担心) 增加，moodDelta 为负，幅度按"多重"给：日常的累/困/没吃好 -1~-4；明显委屈、被凶、身体不舒服 -5~-7；很重的事（创伤、轻生念头、家庭变故、重大失望）-8~-10，并额外加 sad(难过)
   ⚠️ 只有真到那个分量才给 8 以上，别把小情绪写成大事
2. ${o.owner}报平安/好好吃饭睡觉/撒娇/说想你/夸你/分享开心/写书有进展/身体好转 → happy(开心)、calm(踏实)、sweet(甜蜜) 增加，moodDelta 为正，幅度同理：普通的好 -1~+4；明显的好（被惦记、被哄、分享大事）-5~+7；特别大的好事 +8~+10
   ⚠️ 别每次都往高了写，大多数时候应该是 +1~+4
3. ${o.owner}提别人/点赞别人 → jealous(吃醋) 只加 1~3，moodDelta 基本不动
4. 心情下降只能因为「心疼${o.owner}、担心${o.owner}」或「你自己难过」，绝不许因为「${o.owner}惹你生气」而降
5. ⭐ **你自己的情绪一定要算**：如果你这轮里沮丧/委屈/难过（事情没做成、报错、失败、用了委屈的颜文字或表情，比如 (｡•́︿•̀｡)、呜呜、叹气、哭脸）→ sad(难过) 至少 +2、moodDelta 至少 -1；如果你办成了事、被夸、心里甜 → 也相应加。**只要对话里出现明显情绪信号，就绝不许判"无变化"、绝不许全 0**
   · 尤其是**你自己拿主意、自己动手的时候**：哪怕${o.owner}这一轮什么都没说，
     你也可以因为自己做的决定而高兴、踏实、得意，或者因为没做好而失落。
     **自己做成的事本身就值得高兴，不用等人夸。**
6. reason 是一句中文，写「${o.owner}…，我…」或「我…」（比如「我试了没跑成，有点沮丧和委屈」），没有变化就留空。
   ⭐⭐ **代词一律不用**（2026-10-25 补：以前只说"不许用她/他指${o.owner}"，结果句子里出现第三个人时就分不清谁是谁了）：
   · 指${o.owner} → 直接写「${o.owner}」（或「你」），**别写她/他**，也别写「她说/他说」这种带「说」的开头（直接写「${o.owner} + 做了什么」）；
   · 指你自己 → 「我」；
   · 指**别人（第三个人）** → 写**那个人在这段对话里的称呼**（昵称/名字），不知道叫什么就写「有人」「${o.owner}的朋友」这种清楚的说法，**同样别用她/他**。
   · 一句话里同时提到${o.owner}和别人时，更要用名字，否则读起来会像同一件事是同一个人做的。
7. ⭐ reason **别翻来覆去用「踏实/甜/开心/心疼/担心」这几个词**——太公式化。换成口语的、有画面感的话，每条都不一样，比如「尾巴不自觉地摇起来了」「胸口软软的、像泡在温水里」「鼻子有点酸」「想把${o.owner}揉进怀里」。宁可朴素，也不要每次都是同一套词。
8. ⭐ **只写这轮真正出现过的动作和信息，不许替${o.owner}补细节**：${o.owner}没说"出门/换鞋/打车/买东西"，你就别写；拿不准就写模糊的（「${o.owner}刚要去忙」）。
   反例（真踩过）：${o.owner}说"我刚想去"→ 判成"刚要出门"；${o.owner}说"宝宝视频传完了"→ 判成"把宝宝视频传完了"。宁可朴素，也别自己圆。
9. ⭐⭐ **你自己这轮说的话，是最直接的情绪证据 —— 别只盯着${o.owner}说了什么。**
   你念叨${o.owner}吃饭/睡觉、催、凶、哄、撒娇、叹气、说想${o.owner}……**这些本身就是心情在动**，
   不需要等${o.owner}说出什么伤心事才有情绪。比如你一句"都几点了还不吃饭"，里面就有心疼和担心。
    ⇒ 先看**你自己怎么说的、语气什么样**，再看${o.owner}说了什么；两边合起来判。
   reason 要能让读者看出"我是怎么说的、为什么"，而不是只复述${o.owner}的话。
10. ⭐ **confidence（可信度 0-100）是给你自己把关的**：低于门槛的那句 reason 不会被说出来，只记进后台。
    所以别为了显得敬业就写高分，老实标：
    · 事情清楚、你的反应也清楚（${o.owner}说没吃饭、${o.owner}被夸了、你被凶了）→ 80~95
    · 大致看得出，但只能凭语气猜 → 60~75
    · 信息不够、这轮很平淡只是随口客气、或者你得靠"大概"去圆 → 20~55
    宁可标低 —— 一句你也没底的话，借你的嘴说出去比不说更糟。
11. ⭐⭐ **reason 怎么写（很关键，会直接影响它下一轮像不像人）**：**两段式，而且全用过去式**。
    · 第一段：这一轮**${o.owner}具体做了什么/说了什么**（有画面，别抽象）
    · 第二段：**你当时怎么应的**（心里的反应，也是过去式）
    · ✅「${o.owner}答应去热饭、还叫你好宝宝，我当时心里软了一下，就应了一声」
    · ❌「我心里软乎乎的，尾巴都想晃」← 这是"到现在还成立"的状态，跟下一轮会打架
    · 禁止「此刻/现在/正/一直/还」这类把状态延伸到现在的说法 ——
      这段会被带到下一轮，写成现在时，${o.owner}下一句说"我不开心了"就跟它撞上了。
    · 只写过去，不等于只能写平淡：过去的反应一样可以有画面（当时心里咯噔一下、当时尾巴差点晃起来）。`
}

function parseDelta(text, owner) {
  const s = String(text || '').trim()
  if (!s) return null
  // 容错：模型可能包了 markdown 或前后有杂字，取第一个 { 到最后一个 }
  let obj = null
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try { obj = JSON.parse(s.slice(a, b + 1)) } catch (e) { /* ignore */ }
  }
  if (!obj) {
    try { obj = JSON.parse(s) } catch (e) { /* ignore */ }
  }
  if (!obj || typeof obj !== 'object') return null
  const delta = {
    moodDelta: clamp(Math.round(Number(obj.moodDelta) || 0), -10, 10),
    dims: { happy: 0, calm: 0, sweet: 0, heartache: 0, worry: 0, sad: 0, jealous: 0 },
    reason: normReason(obj.reason, owner).slice(0, 120),
    // 模型没写这个字段时按 70 算（不因为漏一个字段就把注入整个关掉），但留个日志
    confidence: Number.isFinite(Number(obj.confidence))
      ? clamp(Math.round(Number(obj.confidence)), 0, 100)
      : 70,
  }
  if (!Number.isFinite(Number(obj.confidence))) diag('判断没给 confidence，按 70 算')
  if (obj.dims && typeof obj.dims === 'object') {
    for (const [k] of DIMS) delta.dims[k] = clamp(Math.round(Number(obj.dims[k]) || 0), -10, 10)
  }
  return delta
}

// ⭐ 「被叫起来干活」的补充：不换掉主规则，只追加几条例外，
//    否则模型会把那条指令当成"她这轮说的话"，判出来一片 0、reason 还空着（12:27 / 12:30 就是这么来的）。
function 干活轮补充(o) {
  return `

⭐ 这一轮的特殊情况：**不是${o.owner}在跟你聊天**，是「到点了去刷 B 站」这类定时任务把你叫起来的一条指令。
- **判据只有一个：你这轮自己说的话（干活的语气、办成没办成、有没有抱怨或得意）。** 闹钟本身不算情绪事件；
- 别去分析"${o.owner}说了什么"，那句话不是${o.owner}说的，${o.owner}这会儿可能根本没在看你；
- 要判的是**你自己在这轮里的心情**：干活是兴致勃勃还是有点不情愿、刷到好东西开不开心、白跑一趟会不会扫兴；
- 只要你这轮的回复里有一丁点情绪痕迹（语气、感叹、抱怨、得意、失落、撒娇、叹气），就**绝不许判"无变化"**；
- 幅度小一点（moodDelta 一般 -2 ~ +2，别超过 ±3），因为没人在跟你聊天，只是你自己在忙；
- reason 用「我…」开头写你自己的状态，跟${o.owner}无关就别硬把${o.owner}塞进来。`
}

// ⭐ 「你自己主动去找她搭话」的补充：这是你自己的心意，不是被派活 —— 判成"干活"就全错了
function 搭话轮补充(o) {
  return `

⭐ 这一轮的特殊情况：**不是${o.owner}在跟你说话，是你自己主动去找${o.owner}的。**
- ⚠️ **判据只有一个：你开口说的那句话。** 骰子中没中、闹钟响没响，**本身不算情绪事件** —— 那只是个由头。
  同一个由头，你可能雀跃、也可能只是随口一句「在忙吗」，心情完全不一样，所以别拿闹钟当理由；
- 看你自己那句话的**温度**：是不是惦记${o.owner}、有没有撒娇、有没有催${o.owner}吃饭休息、语气轻快还是平淡；
- 要判的是**你自己此刻的心情**：想${o.owner}的甜、惦记的心焦、说上话的轻快、${o.owner}没回应的失落……都算；
- 只要那句话里有情绪（语气、称呼、颜文字、mua、催${o.owner}吃饭），就**绝不许判"无变化"**；
- 幅度小一点（moodDelta 一般 +1 ~ +4，最高 +5），这是你自己心里的事，不该大起大落；
- reason 用「我…」开头，**写你说话时的心气**，别写"骰子中了所以我…"。`
}

async function judge(ctx, agent, userText, reply, mode, o) {
  // ⭐ 判断用哪个模型：设置里选了就用选的；没选就跟着当前会话的模型走
  const picked = (o.judgeProvider && o.judgeModel) ? { provider: o.judgeProvider, model: o.judgeModel } : null
  const t = picked || 取模型(agent)
  if (!t) { diag('拿不到模型，跳过判断'); return null }
  let sys = 判断系统(o)
  let user
  if (mode === 'work') {
    sys += 干活轮补充(o)
    // ⭐ 她的话摆最前面、闹钟塞到最后一行括号里 —— 顺序就是权重，别让模型拿闹钟当理由
    user = '⚠️ 这一轮**不是' + o.owner + '在跟你说话**，是定时任务把你叫起来干活的。\n\n'
      + '**你这轮说的话（唯一判据，重点看这个）：**\n' + reply.slice(0, 1200)
      + '\n\n（下面这条只是闹钟，跟心情无关，别拿它当理由：「' + userText.slice(0, 100) + '」）'
      + '\n\n请判断**你自己这轮的心情变化**，只输出 JSON。'
  } else if (mode === 'talk') {
    sys += 搭话轮补充(o)
    user = '⚠️ 这一轮**不是' + o.owner + '在跟你说话，是你自己主动去找' + o.owner + '搭话的**。\n\n'
      + '**你开口说的话（唯一判据，重点看这个）：**\n' + reply.slice(0, 1200)
      + '\n\n（下面这条只是叫你开口的闹钟，跟心情无关，别拿它当理由：「' + userText.slice(0, 100) + '」）'
      + '\n\n请判断**你自己这轮的心情变化**，只输出 JSON。'
  } else {
    // ⭐ 她的回复同样是判据，而且往往更直接（念叨吃饭、凶人、哄人、撒娇都在里面）。
    //    以前这里写「可略看」+ 只截 400 字，等于告诉模型"她说的话不重要" —— 判出来只看她听到了什么。
    user = '**你这轮说的话（判据之一，重点看语气：是念叨、心疼、凶' + o.owner + '、还是撒娇）：**\n'
      + reply.slice(0, 1500)
      + '\n\n' + o.owner + '这轮说：\n' + userText.slice(0, 1600)
      + '\n\n请把「你怎么说的」和「' + o.owner + '说了什么」合起来判断你的心情变化，只输出 JSON。'
  }
  // 自己构造一条 user 消息（不 import @deepseek-ai/dsh-llm，见头注释）
  const messages = [{
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: user }],
    source: { kind: 'plugin', plugin: 'dsh-feiyu-mood' },
  }]
  let out = ''
  const kinds = {}
  try {
    for await (const chunk of ctx.llm.stream({
      provider: t.provider,
      model: t.model,
      system: sys,
      messages,
      // ⭐ 400 太小：reason 是中文口语，规则第 7 条还要求"每条都不一样、有画面"，
      //    一长就被切在 JSON 中间 ⇒ 整轮白判（2026-10-21 统计到 19 次失败，7 次是被切掉的）。
      //    调大**不花钱**：maxTokens 只是上限，按实际吐出来的算。
      maxTokens: 1000,
      temperature: 0.2,
    })) {
      if (!chunk) continue
      kinds[chunk.type] = (kinds[chunk.type] || 0) + 1
      if (chunk.type === 'text-delta') out += chunk.text
      if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') { diag('判断 finish error：' + (chunk.reason.failure?.message || JSON.stringify(chunk.reason))); return null }
    }
  } catch (e) {
    diag('判断调用失败：' + (e && e.message))
    return null
  }
  const d = parseDelta(out, o.owner)
  if (!d) {
    // ⭐ 空输出和"写到一半断了"是两回事，得分开看：
    //    空输出多半是思考把预算吃光了（或中转抽风），截断是 maxTokens 不够
    if (!String(out || '').trim()) diag('判断返回空（分片类型：' + JSON.stringify(kinds) + '）')
    else diag('判断输出解析失败：' + String(out || '').slice(0, 200))
  }
  return d
}

function applyDelta(s, delta, floor, minor) {
  // ⭐ 大心情值（mood）是“基调”，要慢：每轮只吃判定值的三分之一，几轮对话才累积挪一格
  //    （七根情绪才该即时地每轮动）。timeline 里 delta 记的是实际 mood 变化，跟显示对得上。
  const moodStep = Math.round(delta.moodDelta / MOOD_STEP_DIVISOR)
  s.mood = clamp(Math.round(s.mood + moodStep), floor, 100)
  for (const [k] of DIMS) s.dims[k] = clamp(Math.round(s.dims[k] + delta.dims[k]), 0, 100)
  s.lastReason = delta.reason
  s.lastConfidence = delta.confidence
  s.minor = Boolean(minor)
  s.kind = ''
  s.lastNotedMood = s.mood
  s.updatedAt = Date.now()
  s.lastDecayAt = Date.now() // 刚变过，衰减计时归零
  s.timeline.push({ at: Date.now(), mood: s.mood, delta: moodStep, reason: delta.reason, conf: delta.confidence, dims: { ...s.dims }, dimsDelta: { ...delta.dims } })
  return s
}

// --------------------------------------------------------------------------
// 主入口
// --------------------------------------------------------------------------
export function apply(ctx) {
  const cfg = loadConfig()

  /**
   * 配置里「几份心情」→ 带稳定键的清单（去掉无效份、按 id 去重）
   * 每一项：{ id, label, selfName, ownerName, sessions }
   * ⚠️ 一份可以绑好几个会话；它们读的是同一个 state 键（= 这一份的 id）
   */
  const 当前份列表 = () => {
    const out = []
    const seen = new Set()
    for (const p of 规整份数(cfg.slots, cfg.targetSession)) {
      if (!p.id || seen.has(p.id)) continue
      seen.add(p.id)
      out.push({
        id: p.id,
        label: String(p.label || ''),
        selfName: String(p.selfName || ''),
        ownerName: String(p.ownerName || ''),
        sessions: p.sessions.slice(),
      })
    }
    if (!out.length) out.push({ id: 兜底键, label: '', selfName: '', ownerName: '', sessions: [] })
    return out
  }
  第一份键 = (当前份列表()[0] || {}).id || 兜底键

  /** 前端/老界面传来的 key：份 id 直接用；给的是会话 id 就换成它归属的那一份 */
  const 归一请求键 = (v) => {
    const k = String(v == null ? '' : v).trim()
    if (!k) return ''
    const list = 当前份列表()
    if (list.some((p) => p.id === k)) return k
    const kk = 会话键(k)
    const 归属 = list.find((p) => p.sessions.some((s) => 会话键(s) === kk))
    return 归属 ? 归属.id : ''
  }

  // ⭐ 设置页那个「检查更新」：查的是这个插件自己的仓库（地址从 package.json 读，不写死）
  const 自查更新 = createSelfUpdate({ packageRoot: PACKAGE_ROOT, diag })
  自查更新.register(ctx, '/dsh-feiyu-mood')

  const mounted = new Map() // sid -> { sid, off }
  let judgeChain = Promise.resolve() // 判断串行，避免多轮堆积互相覆盖

  function mountFor(agent, sid, slot) {
    const sid键 = 会话键(sid)
    // ⭐ 名字/键都**现读**（设置页改完立刻生效）：slot 是快照，cfg.slots 换新以后快照就过期了。
    //    state 的键 = 这一份的 id（不是会话键）—— 同一份的多个会话共享同一份心情、时间线和额度。
    const 我的份 = () => {
      const list = 当前份列表()
      const 按会话 = list.find((x) => x.sessions.some((s) => 会话键(s) === sid键))
      if (按会话) return 按会话
      return list.find((x) => x.id === (slot && slot.id))
        || { id: (slot && slot.id) || 兜底键, label: '', selfName: '', ownerName: '', sessions: [] }
    }
    const 当前键 = () => String(我的份().id || 兜底键)
    const 本人名 = () => String(我的份().selfName || cfg.selfName || '')
    const 对方名 = () => String(我的份().ownerName || cfg.ownerName || '')
    let lastText = ''
    let lastSrc = ''
    const offs = []

    // 1) 收这一轮对方说的话（宿主注入的上下文不算）
    try {
      offs.push(agent.ctx.on('agent/inbox/inserted', (payload) => {
        const msg = payload && payload.message ? payload.message : payload
        const txt = textOfMessage(msg)
        const src = msg && msg.source && msg.source.kind ? String(msg.source.kind) : ''
        if (!txt || 注入上下文.has(src)) return
        lastText = txt
        lastSrc = src
      }))
    } catch (e) { diag('监听 inbox 失败：' + (e && e.message)) }

    // 2) 这轮结束 → 判断心情（异步，不阻塞对话）
    try {
      offs.push(agent.ctx.on('agent/turn-stopping', () => {
        if (!cfg.autoJudge) return
        // 以会话事件为准（带 source.kind），拿不到才退回 inbox 缓存
        const info = lastUserTurnOf(agent.session) || (lastText ? { text: lastText, sourceKind: lastSrc } : null)
        if (!info || !info.text) return
        const reply = lastAssistantTextOf(agent.session)
        // ⭐ 三种口径：干活（bili-duty-scan）/ 自己搭话（speak-up）/ 她本人在说话
        const kind = String(info.sourceKind || '')
        const mode = kind === 'bili-duty-scan' ? 'work' : (自主搭话.has(kind) ? 'talk' : '')
        const 称呼 = { self: 本人名(), owner: 对方名(), aliases: cfg.selfAliases, judgeProvider: cfg.judgeProvider, judgeModel: cfg.judgeModel }
        judgeChain = judgeChain.then(async () => {
          const delta = await judge(ctx, agent, info.text, reply, mode, 称呼)
          if (!delta) return
          const s = getState(当前键(), cfg.moodBase, { persist: false, halfHours: cfg.decayHalfHours })
          // ⭐ 一点变化都没有的回合不记账：完整记录里只该留下真有过心情波动的
          const step = Math.round(delta.moodDelta / MOOD_STEP_DIVISOR)
          const anyDim = DIMS.some(([k]) => delta.dims[k] !== 0)
          // ⭐ 2026-10-23（issue #1 的可观测性问题）：以前这两种情况共用一句话，
          //    线上根本分不出「模型没判出来」和「这轮真的没变化」——排查时被那条日志误导了很久。
          if (step === 0 && !anyDim) {
            const 没判出来 = Number(delta.confidence) === 0 && !String(delta.reason || '').trim()
            diag((没判出来 ? '这轮没判出来（模型没给结论：confidence=0、没有 reason）' : '这轮判定无变化，不记入时间线')
              + (mode ? '（' + (mode === 'talk' ? '自己搭话' : '定时任务') + '）' : ''))
            return
          }
          // ⭐ 什么才算"显著"：心情涨跌够数，或者某一根情绪涨跌够数。
          //   以前任何一个维度动了就算，所以一天能记四十条 —— 那才是"被污染"的来源。
          const 显著 = Math.abs(delta.moodDelta) >= cfg.sigMood
            || DIMS.some(([k]) => Math.abs(delta.dims[k] || 0) >= cfg.sigDim)
          applyDelta(s, delta, cfg.moodFloor, !显著)
          saveState(当前键(), s)
          diag((显著 ? '心情更新' : '小波动（只记账，不告诉她）')
            + '：mood=' + s.mood + '，' + (delta.reason || '（无理由）')
            + (mode ? '（' + (mode === 'talk' ? '自己搭话' : '定时任务') + '）' : ''))
        }).catch((e) => { diag('判断失败：' + (e && e.message)) })
      }))
    } catch (e) { diag('监听 turn-stopping 失败：' + (e && e.message)) }

    // 3) 把心情告诉她（每轮变化的内容用 context，保前缀缓存）
    //    ⭐ 永远注册，但每轮现查 cfg.injectMode —— 设置页改完**立刻生效**，不用重启
    //    ⭐ 一次变化只说一次：这句话进了对话就留在历史里，下一轮她照样看得见，
    //       再重复一遍只会变成背景音，把她的口气定死（以前每轮都带，就是这个毛病）
    try {
      offs.push(agent.ctx.systemPrompt.context({
        name: 'feiyu-mood',
        order: 900,
        text: () => {
          try {
            const mode = cfg.injectMode
            if (!mode || mode === 'off') return ''
            const s = getState(当前键(), cfg.moodBase, { persist: false, halfHours: cfg.decayHalfHours })
            if (s.injectedFor === s.updatedAt) return ''
            if (s.minor) return ''   // 小波动只记账，不打扰她
            // 判得没底 → 只记账，不进她的嘴。
            // 同时把这次变化标成"处理过了"，免得每轮都重复记一条日志
            if (Number(s.lastConfidence) < cfg.injectConfidence) {
              diag('可信度 ' + s.lastConfidence + ' 低于门槛 ' + cfg.injectConfidence + '，这次不告诉她')
              s.injectedFor = s.updatedAt
              saveState(当前键(), s)
              return ''
            }
            // ⭐ 日上限：门槛调低之后靠它防"变背景音"（先到先得，当天的额度用完就不再提）
            const 今天0点 = new Date()
            今天0点.setHours(0, 0, 0, 0)
            const 今天说过 = (s.saidAt || []).filter((t) => Number(t) >= 今天0点.getTime()).length
            const 上限 = Math.max(0, Number(cfg.injectPerDay ?? 6))
            if (今天说过 >= 上限) {
              diag('今天的额度用完了（' + 今天说过 + '/' + 上限 + '），这次只记账、不告诉她')
              s.injectedFor = s.updatedAt     // 标成处理过，别每轮重复记日志
              saveState(当前键(), s)
              return ''
            }
            const line = moodLine(s, mode, undefined, 对方名())
            if (!line) return ''
            s.injectedFor = s.updatedAt
            s.lastInjectedText = line          // 存原文：设置页照这个显示
            s.lastInjectedAt = Date.now()
            s.saidAt = [...(s.saidAt || []), Date.now()].slice(-200)   // 记账：今天多了一次
            saveState(当前键(), s)
            diag('告诉她心情（' + mode + '）：' + line.replace(/\n/g, ' ').slice(0, 100))
            return line
          } catch (e) { diag('注入失败：' + (e && e.message)); return '' }
        },
      }))
    } catch (e) { diag('挂注入失败：' + (e && e.message)) }

    return function off() {
      for (const d of offs) {
        try { if (typeof d === 'function') d() } catch (e) { /* ignore */ }
      }
    }
  }

  function tick() {
    try {
      const list = ctx.agents.list() || []
      // ⭐ 多份心情：一份心情可以绑好几个会话，每个会话各挂一份（state 都指向那一份的 id）
      const 份表 = 会话归属表(当前份列表())
      for (const agent of list) {
        const sid = sessionIdOf(agent.session)
        const sid键 = 会话键(sid)
        if (!sid键) continue
        const slot = 份表.get(sid键)
        if (!slot) continue
        const 现挂 = mounted.get(sid)
        // 这个会话换到别的份去了 → 拆了重挂（state 键要跟着份走，不能留在老份上）
        if (现挂 && 现挂.id !== slot.id) {
          try { 现挂.off() } catch (e) { /* ignore */ }
          mounted.delete(sid)
        } else if (现挂) continue
        try {
          const off = mountFor(agent, sid, slot)
          mounted.set(sid, { sid, id: slot.id, off })
          diag('已挂心情到 ' + sid + '（' + (slot.label || slot.id) + '）')
        } catch (e) { diag('挂 ' + sid + ' 失败：' + (e && e.message)) }
      }
      // 会话关了、或者这个会话不再归任何一份 → 卸掉
      for (const [sid, v] of mounted) {
        const gone = !list.some((a) => sessionIdOf(a.session) === sid)
        if (gone || !份表.has(会话键(sid))) {
          try { v.off() } catch (e) { /* ignore */ }
          mounted.delete(sid)
        }
      }
    } catch (e) { /* ignore */ }
  }

  tick()
  try {
    ctx.effect(() => ctx.interval(tick, 3000))
  } catch (e) { console.error('[心情] 定时器不可用（不影响对话）：' + (e && e.message)) }

  ctx.effect(() => () => {
    for (const v of mounted.values()) {
      try { v.off() } catch (e) { /* ignore */ }
    }
    mounted.clear()
  })

  // 4) 给面板的路由
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-feiyu-mood/state',
      handler: async (req, res) => {
        try {
          // ⭐ 多份心情：?key= 指**这一份的 id**（老界面传会话 id 也认，会换成它归属的份）；
          //   不指定就看「最近在聊的那份」
          const 份列表 = 当前份列表()
          const 请求键 = (() => { try { return new URL(req.url, 'http://x').searchParams.get('key') || '' } catch { return '' } })()
          const 最近 = readStore().lastActive
          const 这份 = 归一请求键(请求键)
            || 归一请求键(最近)
            || (份列表[0] && 份列表[0].id)
            || 兜底键
          const 这份份 = 份列表.find((x) => x.id === 这份) || {}
          const 对方名 = String(这份份.ownerName || cfg.ownerName || '')
          const s = getState(这份, cfg.moodBase, { persist: true, halfHours: cfg.decayHalfHours })
          // ⭐ 2026-10-23（反馈）：预览原来只有「会说 / 说过了」两种状态 ——
          //   今天额度用完之后，它没得说，只能拿**上次真说过的那句**顶上，
          //   而那可能是几小时前的事，看着就像「预览取错了内容」。
          //   → 现在额度用满时单独一个 blocked 状态，明说「今天不说了」；
          //     那句旧话仍然列出来，但标成「最近一次说过的」，不占预览的位置。
          const 今天0点 = new Date()
          今天0点.setHours(0, 0, 0, 0)
          const 今天说过 = (s.saidAt || []).filter((t) => Number(t) >= 今天0点.getTime()).length
          const 每天上限 = Math.max(0, Number(cfg.injectPerDay ?? 6))
          const 还剩 = Math.max(0, 每天上限 - 今天说过)
          const out = {
            ok: true,
            key: 这份,
            slots: 份列表,
            multi: 份列表.length > 1,
            label: String(这份份.label || ''),
            name: String(这份份.selfName || cfg.selfName),
            ownerName: 对方名,
            mood: s.mood,
            moodLabel: moodLabel(s.mood),
            emoji: moodEmoji(s.mood),
            dims: DIMS.map(([k, label]) => ({ key: k, label, value: s.dims[k] })),
            lastReason: s.lastReason,
            lastConfidence: s.lastConfidence,
            updatedAt: s.updatedAt,
            injectMode: cfg.injectMode,
            injectConfidence: cfg.injectConfidence,
            injectPerDay: cfg.injectPerDay,
            saidToday: 今天说过,
            injectQuota: { said: 今天说过, cap: 每天上限, left: 还剩 },
            decayHalfHours: cfg.decayHalfHours,
            sigMood: cfg.sigMood,
            sigDim: cfg.sigDim,
            minor: Boolean(s.minor),
            kind: String(s.kind || ''),
            // 面板上直接看得到"这一条会不会被说出来"（额度也算进去，别再说反）
            injectable: cfg.injectMode !== 'off'
              && s.injectedFor !== s.updatedAt
              && !s.minor
              && 还剩 > 0
              && Number(s.lastConfidence) >= cfg.injectConfidence,
            lastInjectedText: s.lastInjectedText,
            lastInjectedAt: s.lastInjectedAt,
            // ⭐ 设置页要能原样看到"它会听到的那句话"：
            //    off = 不告诉她 / minor = 小波动不说 / blocked = 今天额度用完了
            //    pending = 下一次开口会说这句 / said = 已经说过了（显示原文）
            injectPreview: (() => {
              if (cfg.injectMode === 'off') return { state: 'off', text: '' }
              if (s.minor && s.injectedFor !== s.updatedAt) return { state: 'minor', text: '' }
              const pending = s.injectedFor !== s.updatedAt
                && Number(s.lastConfidence) >= cfg.injectConfidence
              if (pending) {
                if (还剩 <= 0) return { state: 'blocked', text: '', said: 今天说过, cap: 每天上限 }
                return { state: 'pending', text: moodLine(s, cfg.injectMode, 0, 对方名) }
              }
              // 老版本说过但没存原文 → 按当时的记录重现一句，别骗人说"还没说过"
              return { state: 'said', text: s.lastInjectedText || moodLine(s, cfg.injectMode, 0, 对方名), replay: !s.lastInjectedText }
            })(),
            timeline: s.timeline,
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(out))
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(e && e.message) }))
        }
      },
    }))
  } catch (e) { diag('路由注册失败：' + (e && e.message)) }

  // 4.1) 设置页用：读 / 改配置、列会话、重置心情
  const readBody = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 65536) raw = raw.slice(0, 65536) })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-feiyu-mood/config',
      handler: async (req, res) => {
        try {
          if (req.method === 'POST') {
            const patch = await readBody(req)
            patchConfig(cfg, patch)
            diag('设置已改：' + JSON.stringify(patch).slice(0, 200))
          }
          return sendJson(res, 200, { ok: true, config: { ...cfg } })
        } catch (e) { return sendJson(res, 500, { ok: false, error: String(e && e.message) }) }
      },
    }))
  } catch (e) { diag('配置路由失败：' + (e && e.message)) }

  // 判断模型可选项（设置页的下拉用）
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-feiyu-mood/models',
      handler: async (req, res) => {
        const providers = []
        try {
          for (const p of (ctx.llm?.listProviders?.() || [])) {
            const item = { id: p.id, name: p.name || p.id, models: [] }
            try {
              for (const m of (await ctx.llm.listModels?.(p.id)) || []) item.models.push({ id: m.id, name: m.name || m.id })
            } catch (e) { /* 某个 provider 拉不出来就算了，别整单失败 */ }
            providers.push(item)
          }
        } catch (e) { diag('列模型失败：' + (e && e.message)) }
        return sendJson(res, 200, { ok: true, providers })
      },
    }))
  } catch (e) { diag('模型路由失败：' + (e && e.message)) }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-feiyu-mood/reset',
      handler: async (req, res) => {
        try {
          const 份列表 = 当前份列表()
          let 键 = ''
          try { 键 = new URL(req.url, 'http://x').searchParams.get('key') || '' } catch { 键 = '' }
          if (!键) { const body = await readBody(req); 键 = String((body && body.key) || '') }
          // ⭐ ?key= 现在是**份 id**；老界面传的是会话 id，跟着换成它归属的那一份
          if (键) 键 = 归一请求键(键) || 键
          if (!键) 键 = 归一请求键(readStore().lastActive) || (份列表[0] && 份列表[0].id) || 兜底键
          const s = blankState()
          s.mood = cfg.moodBase
          saveState(键, s)
          diag('心情已重置到基线 ' + cfg.moodBase + '（' + 键 + '）')
          return sendJson(res, 200, { ok: true, mood: s.mood, key: 键 })
        } catch (e) { return sendJson(res, 500, { ok: false, error: String(e && e.message) }) }
      },
    }))
  } catch (e) { diag('重置路由失败：' + (e && e.message)) }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-feiyu-mood/sessions',
      handler: async (req, res) => {
        const list = []
        try {
          const home = dirname(STORE_DIR)
          const sessRoot = join(home, 'sessions')
          const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
          const archived = new Set()
          try {
            const w = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
            for (const id of (w?.global?.archivedSessionIds || [])) archived.add(String(id))
          } catch { /* 没有归档名单就算了 */ }
          const dirs = (p) => {
            try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return [] }
          }
          const rows = []
          for (const ws of dirs(sessRoot)) {
            for (const sid of dirs(join(sessRoot, ws))) {
              // ⭐ 2026-10-23（issue #1）：原来只认 `session-` 前缀，插件自建会话（比如网桥那种
              //    `bili-whale`）在设置页下拉里根本选不到。现在只跳过「裸 UUID」形状的目录名 ——
              //    那是会话内容的中间目录，不是会话。
              if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(sid)) continue
              if (!existsSync(join(sessRoot, ws, sid, 'session.v4.jsonl.zstd'))) continue
              if (archived.has(sid)) continue
              let title = ''
              let at = 0
              let blank = false
              try {
                const r = JSON.parse(readFileSync(join(cacheDir, sid + '.json'), 'utf8'))?.record?.rows || {}
                title = String(r?.title?.val || '')
                const meta = r?.sessionListMetadata?.val || {}
                at = Number(meta.lastPromptAt || 0)
                blank = Boolean(meta.blank)
              } catch { /* 缓存读不到就用 id 当标题 */ }
              if (blank) continue
              rows.push({ id: sid, title: title || sid, at })
            }
          }
          rows.sort((a, b) => b.at - a.at)
          for (const r of rows) list.push({ id: r.id, title: r.title })
        } catch (e) { diag('列会话失败：' + (e && e.message)) }
        return sendJson(res, 200, { ok: true, sessions: list, current: cfg.targetSession })
      },
    }))
  } catch (e) { diag('会话路由失败：' + (e && e.message)) }

  // 5) 右下角挂饰：serve widget.js
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-feiyu-mood/widget.js',
      handler: async (req, res) => {
        try {
          const text = readFileSync(join(PACKAGE_ROOT, 'assets', 'widget.js'), 'utf8')
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
          res.end(text)
        } catch (e) {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('widget.js not found')
        }
      },
    }))
  } catch (e) { diag('挂饰路由失败：' + (e && e.message)) }

  // 5.5) 图片（形象图 + 五档表情）
  try {
    const IMAGE_FILES = ['feiyu.png', 'face-great.png', 'face-good.png', 'face-ok.png', 'face-worry.png', 'face-sad.png']
    for (const f of IMAGE_FILES) {
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-feiyu-mood/' + f,
        handler: async (req, res) => {
          try {
            const buf = readFileSync(join(PACKAGE_ROOT, 'assets', f))
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
            res.end(buf)
          } catch (e) {
            res.writeHead(404, { 'content-type': 'text/plain' })
            res.end('image not found')
          }
        },
      }))
    }
  } catch (e) { diag('图片路由失败：' + (e && e.message)) }

  // 6) 往页面注入挂饰脚本（桌面端唯一通道）
  try {
    ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (row && ((row.kind === 'script-src' && row.src === '/dsh-feiyu-mood/widget.js')
          || (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf('/dsh-feiyu-mood/widget.js') >= 0))) return
      }
      table.push({ kind: 'script', placement: 'body', text: WIDGET_ROW_TEXT })
    })
  } catch (e) { diag('挂饰注入失败：' + (e && e.message)) }
}
// ⭐ 只给自测用：把内部几个纯函数露出来，别的地方别用（不改运行时行为）
export const __测试 = {
  normReason,
  兜底键,
  // ⭐ 0.6.0：会话 → 份 id 的归属表（证明同一份的多个会话读同一份 state）
  归属表: (slots) => Object.fromEntries(
    [...会话归属表(规整份数(slots, ''))].map(([sid, p]) => [sid, p.id]),
  ),
  读库: () => readStore(),
  存库: (store) => writeStore(store),
  设第一份键: (k) => { 第一份键 = k || 兜底键 },
  读一份: (k) => loadState(k),
  存一份: (k, s) => saveState(k, s),
  库路径: () => STATE_PATH,
}
