/**
 * dsh-feiyu-mood —— 浏览器半端（设置里的一页「心情」）
 * ============================================================================
 * 自注册脚本（和 dsh-bili-scroll 一样的约定）：
 *
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *
 * 这一页要满足的想法（主人 2026-10-19）：
 *   · 心情插件**也能给别人用** ⇒ 名字得能改（她叫什么叫什么、你叫什么叫什么）
 *   · 目标会话、基线、下限、注入开关、自动判断开关，都在面板里改，不用去翻 config.json
 *   · 改完**立刻生效**（宿主那边是原地改 cfg，不用重启）
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-feiyu-mood',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/dsh-feiyu-mood'

    // 五档表情：用的就是挂饰那五张图（assets/face-*.png，448×352）
    const faceImg = (v) => {
      const m = Number(v)
      if (!Number.isFinite(m)) return API + '/face-ok.png'
      if (m >= 80) return API + '/face-great.png'
      if (m >= 62) return API + '/face-good.png'
      if (m >= 42) return API + '/face-ok.png'
      if (m >= 25) return API + '/face-worry.png'
      return API + '/face-sad.png'
    }

    const getJson = async (url) => {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }
    const postJson = async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }

    const CSS = `
[data-fm-wrap]{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;}
[data-fm-hero]{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:12px;background:rgba(127,127,127,.08);}
[data-fm-face]{width:84px;height:66px;object-fit:contain;border-radius:10px;flex:0 0 auto;background:rgba(127,127,127,.10);}
[data-fm-big]{font-size:30px;font-weight:600;line-height:1;}
[data-fm-sub]{font-size:12px;opacity:.7;margin-top:4px;}
[data-fm-sec]{display:flex;flex-direction:column;gap:8px;}
[data-fm-h]{font-size:13px;font-weight:600;opacity:.85;padding-top:6px;border-top:1px solid rgba(127,127,127,.18);}
[data-fm-note]{font-size:12px;opacity:.62;line-height:1.5;}
[data-fm-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-fm-grow]{flex:1;min-width:180px;}
[data-fm-label]{font-size:13px;}
[data-fm-input]{padding:6px 9px;border-radius:7px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-size:13px;min-width:120px;}
[data-fm-num]{width:88px;min-width:88px;}
[data-fm-btn]{padding:6px 12px;border-radius:7px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-size:13px;cursor:pointer;}
[data-fm-btn]:hover{background:rgba(127,127,127,.12);}
[data-fm-btn][disabled]{opacity:.5;cursor:default;}
[data-fm-msg]{font-size:12px;opacity:.8;min-height:16px;}
[data-fm-tl]{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto;}
[data-fm-tlrow]{display:flex;gap:8px;font-size:12px;line-height:1.6;}
[data-fm-time]{opacity:.55;width:78px;flex:0 0 78px;}
[data-fm-mood]{opacity:.85;width:34px;flex:0 0 34px;}
[data-fm-delta]{width:40px;flex:0 0 40px;opacity:.8;}
[data-fm-reason]{opacity:.85;}
[data-fm-quote]{font-size:13px;line-height:1.65;white-space:pre-wrap;padding:10px 12px;border-radius:9px;background:rgba(127,127,127,.10);border-left:3px solid rgba(127,127,127,.35);}
[data-fm-quote][data-fm-dim]{opacity:.62;}
`

    function Panel() {
      const [cfg, setCfg] = React.useState(null)
      const [st, setSt] = React.useState(null)
      const [sessions, setSessions] = React.useState([])
      const [models, setModels] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')

      const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 2500) }

      const load = React.useCallback(async () => {
        try {
          const [c, s] = await Promise.all([getJson(API + '/config'), getJson(API + '/state')])
          if (c && c.config) setCfg(c.config)
          if (s && s.ok) setSt(s)
        } catch (e) {
          setMsg('读取失败：' + (e && e.message))
        }
      }, [])

      React.useEffect(() => {
        load()
        getJson(API + '/sessions').then((r) => setSessions((r && r.sessions) || [])).catch(() => {})
        getJson(API + '/models').then((r) => setModels((r && r.providers) || [])).catch(() => {})
        const t = setInterval(() => { getJson(API + '/state').then((s) => s && s.ok && setSt(s)).catch(() => {}) }, 20000)
        return () => clearInterval(t)
      }, [load])

      const patch = async (p, label) => {
        setCfg((c) => ({ ...c, ...p }))
        try {
          const r = await postJson(API + '/config', p)
          if (r && r.config) setCfg(r.config)
          flash((label || '设置') + ' 已保存')
        } catch (e) { flash('保存失败：' + (e && e.message)) }
      }

      const onReset = async () => {
        setBusy('reset')
        try {
          await postJson(API + '/reset', {})
          await load()
          flash('已重置到基线')
        } catch (e) { flash('重置失败：' + (e && e.message)) }
        setBusy('')
      }

      if (!cfg) return h('div', { 'data-fm-wrap': '' }, h('div', { 'data-fm-note': '' }, '读取中…'))

      const sw = (key, label) => h('input', {
        type: 'checkbox',
        checked: Boolean(cfg[key]),
        onChange: (e) => patch({ [key]: e.target.checked }, label),
      })

      const numInput = (key, label, note, min, max) => h('div', { 'data-fm-row': '' },
        h('div', { 'data-fm-grow': '' },
          h('div', { 'data-fm-label': '' }, label),
          note ? h('div', { 'data-fm-note': '' }, note) : null),
        h('input', {
          'data-fm-input': '', 'data-fm-num': '', type: 'number', min, max,
          value: String(cfg[key] ?? ''),
          onChange: (e) => setCfg((c) => ({ ...c, [key]: e.target.value })),
          onBlur: () => {
            const n = Math.max(min, Math.min(Number(cfg[key]) || 0, max))
            patch({ [key]: n }, label)
          },
        }))

      return h('div', { 'data-fm-wrap': '' },

        /* ── 当前心情 ── */
        h('div', { 'data-fm-hero': '' },
          h('img', { 'data-fm-face': '', src: faceImg(st && st.mood), alt: '' }),
          h('div', { 'data-fm-grow': '' },
            h('div', { 'data-fm-big': '' }, (st && st.mood != null ? st.mood : '—')
              + (st && st.moodLabel ? '　' + st.moodLabel : '')),
            h('div', { 'data-fm-sub': '' },
              ((st && st.lastReason) || '还没有记录 —— 跟 TA 聊起来就有了'),
              (st && st.updatedAt ? '（' + new Date(st.updatedAt).toLocaleString() + '）' : ''),
              (st && st.lastReason
                ? (st.injectMode === 'off'
                  ? '　· 心情不告诉她'
                  : (st.injectable ? '　· 这条还没跟她说' : '　· 这条已经说过了'))
                : '')),
          h('button', { 'data-fm-btn': '', disabled: busy === 'reset', onClick: onReset }, '重置到基线'))),

        /* ── 她会听到的那句话 ── */
        h('div', { 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '她会听到的那句话'),
          (st && st.injectPreview && st.injectPreview.state === 'off')
            ? h('div', { 'data-fm-note': '' }, '现在选的是「不告诉她」—— 心情只记在后台，不影响她说话。')
            : null,
          (st && st.injectPreview && st.injectPreview.state === 'pending')
            ? h('div', {},
              h('div', { 'data-fm-note': '' }, '下一次她开口时，会看到这句（预览 —— 括号里的话会随机换一句）：'),
              h('div', { 'data-fm-quote': '' }, st.injectPreview.text || '（这会儿没有可说的）'))
            : null,
          (st && st.injectPreview && st.injectPreview.state === 'said')
            ? h('div', {},
              h('div', { 'data-fm-note': '' },
                '最近一次说给 TA 的话'
                + (st.lastInjectedAt ? '（' + new Date(st.lastInjectedAt).toLocaleString() + '）' : '')
                + (st.injectPreview.replay
                  ? ' —— 这句是旧版本说的，当时没存原文，按记录重现（大意一致，字面可能略有出入）：'
                  : ' —— 同一件事不会再说第二遍，之后这句就留在对话记录里：')),
              h('div', { 'data-fm-quote': '', 'data-fm-dim': st.lastInjectedText ? undefined : '' },
                st.lastInjectedText || '（还没有说过；等下一次心情有变化就有了）'))
            : null),

        /* ── 称呼 ── */
        h('div', { 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '称呼'),
          h('div', { 'data-fm-note': '' }, '这两个名字会写进判断提示词；换了名字，心情描述里也跟着换。'),
          h('div', { 'data-fm-row': '' },
            h('div', { 'data-fm-grow': '' }, h('div', { 'data-fm-label': '' }, 'TA 叫什么（被关心的那个人）')),
            h('input', {
              'data-fm-input': '', value: cfg.ownerName || '',
              placeholder: '小鱿鱼',
              onChange: (e) => setCfg((c) => ({ ...c, ownerName: e.target.value })),
              onBlur: () => patch({ ownerName: cfg.ownerName }, '称呼'),
            })),
          h('div', { 'data-fm-row': '' },
            h('div', { 'data-fm-grow': '' }, h('div', { 'data-fm-label': '' }, 'TA 自己叫什么（有心情的那个人）')),
            h('input', {
              'data-fm-input': '', value: cfg.selfName || '',
              placeholder: '大肥鱼',
              onChange: (e) => setCfg((c) => ({ ...c, selfName: e.target.value })),
              onBlur: () => patch({ selfName: cfg.selfName }, '称呼'),
            })),
          h('div', { 'data-fm-row': '' },
            h('div', { 'data-fm-grow': '' },
              h('div', { 'data-fm-label': '' }, 'TA 平时怎么叫你（昵称）'),
              h('div', { 'data-fm-note': '' }, '逗号分隔，比如：大肥鱼,宝宝,老婆,鱼鱼。判断时会把这些词当成「在叫你」，不会把「宝宝视频」当成一个东西')),
            h('input', {
              'data-fm-input': '', value: cfg.selfAliases || '',
              placeholder: '大肥鱼,宝宝,老婆',
              onChange: (e) => setCfg((c) => ({ ...c, selfAliases: e.target.value })),
              onBlur: () => patch({ selfAliases: cfg.selfAliases }, '昵称'),
            }))),

        /* ── 在哪个会话里生效 ── */
        h('div', { 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '在哪个会话里生效'),
          h('div', { 'data-fm-note': '' }, '心情是全局一份，但只在下面这个会话里判断和注入。换会话不用重启。'),
          h('select', {
            'data-fm-input': '', value: cfg.targetSession || '',
            onChange: (e) => patch({ targetSession: e.target.value }, '目标会话'),
          },
            h('option', { value: '' }, '（未选）'),
            (sessions || []).map((s) => h('option', { key: s.id, value: s.id }, s.title)),
            // 当前值不在列表里（比如归档了）也要能看到
            cfg.targetSession && !(sessions || []).some((s) => s.id === cfg.targetSession)
              ? h('option', { value: cfg.targetSession }, '（当前：' + cfg.targetSession.slice(0, 18) + '…）')
              : null)),

        /* ── 判断用哪个模型 ── */
        h('div', { 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '判断用哪个模型'),
          h('div', { 'data-fm-note': '' }, '心情判断是一次很短的小调用。想更准就指到更强的模型，想省钱就指到便宜的；留空 = 跟着当前会话的模型走。'),
          h('div', { 'data-fm-row': '' },
            h('div', { 'data-fm-grow': '' }, h('div', { 'data-fm-label': '' }, 'provider（厂商）')),
            h('select', {
              'data-fm-input': '', value: cfg.judgeProvider || '',
              onChange: (e) => {
                const v = e.target.value
                const list = ((models || []).find((p) => p.id === v)?.models) || []
                const nextModel = v ? (list[0]?.id || '') : ''
                setCfg((c) => ({ ...c, judgeProvider: v, judgeModel: nextModel }))
                patch({ judgeProvider: v, judgeModel: nextModel }, '判断模型')
              },
            },
              h('option', { value: '' }, '（跟着会话走）'),
              (models || []).map((p) => h('option', { key: p.id, value: p.id }, p.name || p.id)),
              cfg.judgeProvider && !(models || []).some((p) => p.id === cfg.judgeProvider)
                ? h('option', { value: cfg.judgeProvider }, cfg.judgeProvider)
                : null)),
          h('div', { 'data-fm-row': '' },
            h('div', { 'data-fm-grow': '' }, h('div', { 'data-fm-label': '' }, 'model（型号）')),
            h('select', {
              'data-fm-input': '', value: cfg.judgeModel || '', disabled: !cfg.judgeProvider,
              onChange: (e) => { const v = e.target.value; setCfg((c) => ({ ...c, judgeModel: v })); patch({ judgeModel: v }, '判断模型') },
            },
              h('option', { value: '' }, '（默认）'),
              (((models || []).find((p) => p.id === cfg.judgeProvider) || {}).models || [])
                .map((m) => h('option', { key: m.id, value: m.id }, m.name || m.id)),
              cfg.judgeModel && !((((models || []).find((p) => p.id === cfg.judgeProvider) || {}).models) || []).some((m) => m.id === cfg.judgeModel)
                ? h('option', { value: cfg.judgeModel }, cfg.judgeModel)
                : null))),

        /* ── 开关 ── */
        h('div', { 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '开关'),
          h('div', { 'data-fm-row': '' },
            h('div', { 'data-fm-grow': '' },
              h('div', { 'data-fm-label': '' }, '每轮判断心情'),
              h('div', { 'data-fm-note': '' }, '关掉就完全不判断、不改数值（也不花判断的 token）')),
            sw('autoJudge', '每轮判断')),
          h('div', { 'data-fm-row': '' },
            h('div', { 'data-fm-grow': '' },
              h('div', { 'data-fm-label': '' }, '心情怎么告诉她'),
              h('div', { 'data-fm-note': '' }, '不告诉她 = 完全不受影响（挂饰照常显示）；只说心情 = 给一句「此刻心情怎样」；说她刚才那件事 = 把她自己刚才心里那句话带进去，每轮都不一样，最不像被安排')),
            h('select', {
              'data-fm-input': '', value: cfg.injectMode || 'event',
              onChange: (e) => patch({ injectMode: e.target.value }, '心情怎么告诉她'),
            },
              h('option', { value: 'off' }, '不告诉她'),
              h('option', { value: 'label' }, '只说心情'),
              h('option', { value: 'event' }, '说她刚才那件事'))),
          h('div', { 'data-fm-note': '' }, '不管选哪个，同一次心情变化只说一次 —— 那句话进了对话就留在记录里，之后不再重复（以前每轮都说一遍，会变成背景音把她的口气定死）。'),
          numInput('injectConfidence', '可信度门槛', '判断模型自己对这次判断有多确定；低于这个数就只记进后台、不进她的嘴（0–100，默认 60）。调高更保守，调低更爱说。', 0, 100)),

        /* ── 数值 ── */
        h('div', { 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '数值'),
          numInput('moodBase', '基线心情', '没情绪时心情会慢慢回到这个数（30–100）', 30, 100),
          numInput('moodFloor', '心情下限', '最低能掉到多少；0 = 不设底线（0–100）', 0, 100)),

        /* ── 时间线 ── */
        h('div', { 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '完整记录'),
          h('div', { 'data-fm-tl': '' },
            ((st && st.timeline) || []).slice().reverse().slice(0, 40).map((t, i) => h('div', { 'data-fm-tlrow': '', key: i },
              h('span', { 'data-fm-time': '' }, new Date(t.at).toLocaleString()),
              h('span', { 'data-fm-mood': '' }, String(t.mood)),
              h('span', { 'data-fm-delta': '' }, (t.delta > 0 ? '+' : '') + (t.delta ?? 0)),
              h('span', { 'data-fm-reason': '' }, (t.reason || '—')
                + (t.conf != null ? '（可信 ' + t.conf + '）' : ''))))),
          (st && st.timeline && st.timeline.length > 40
            ? h('div', { 'data-fm-note': '' }, '只显示最近 40 条，共 ' + st.timeline.length + ' 条')
            : null)),

        h('div', { 'data-fm-msg': '' }, msg),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-feiyu-mood')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-feiyu-mood: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'mood', order: 40, label: '鱼的心情' },
          () => h(Panel),
        ))
      },
    }
  },
})
