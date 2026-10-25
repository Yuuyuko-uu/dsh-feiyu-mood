/**
 * dsh-feiyu-mood —— 浏览器半端（设置里的一页「心情」）
 * ============================================================================
 * 自注册脚本（和 dsh-bili-scroll 一样的约定）：
 *
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *
 * 这一页要满足的想法（主人 2026-10-19）：
 *   · 心情插件**也能给别人用** ⇒ 名字得能改（它叫什么叫什么、你叫什么叫什么）
 *   · 目标会话、基线、下限、注入开关、自动判断开关，都在面板里改，不用去翻 config.json
 *   · 改完**立刻生效**（宿主那边是原地改 cfg，不用重启）
 *
 * ⭐ 0.6.0：设置页分四个页签（心情 / 会话绑定 / 判断与注入 / 挂饰）。
 *    一份心情可以绑好几个会话 —— 这些会话共用一份心情、一条时间线、每天的额度；
 *    分页签只是把「看」和「改」分开，切页签不动任何设置。
 *
 * ⭐ 0.7.0：「会话绑定」页签顶上多了**模式切换**，二选一：
 *    · 会话模式：跟以前一样，按点名的会话绑；
 *    · 工作区模式：按工作区绑 —— 那个工作区下所有会话都归这一份，新开的自动进来。
 *    名字那栏的文案也改清楚了：那只是「这份叫什么」，不是称呼（称呼在「判断与注入」）。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-feiyu-mood',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/dsh-feiyu-mood'

    // 四个页签（默认第一个）
    const 页签 = [
      ['mood', '心情'],
      ['bind', '会话绑定'],
      ['judge', '判断与注入'],
      ['charm', '挂饰'],
    ]

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
[data-fm-tabs]{display:flex;gap:6px;flex-wrap:wrap;padding-bottom:8px;border-bottom:1px solid rgba(127,127,127,.2);}
[data-fm-tab]{padding:5px 12px;border-radius:7px;border:1px solid transparent;background:transparent;color:inherit;font-size:13px;cursor:pointer;opacity:.72;}
[data-fm-tab]:hover{background:rgba(127,127,127,.10);opacity:1;}
[data-fm-tab][data-fm-on]{background:rgba(127,127,127,.16);border-color:rgba(127,127,127,.28);opacity:1;font-weight:600;}
[data-fm-pick]{padding:5px 14px;border-radius:7px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-size:13px;cursor:pointer;opacity:.8;}
[data-fm-pick]:hover{background:rgba(127,127,127,.10);opacity:1;}
[data-fm-pick][data-fm-on]{background:rgba(127,127,127,.18);border-color:rgba(127,127,127,.5);opacity:1;font-weight:600;}
[data-fm-pane]{display:flex;flex-direction:column;gap:14px;}
[data-fm-slot]{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;background:rgba(127,127,127,.06);}
[data-fm-sess]{display:flex;align-items:center;gap:8px;padding:2px 0;}
[data-fm-sessname]{flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-fm-faces]{display:flex;gap:10px;flex-wrap:wrap;}
[data-fm-faces] img{width:84px;height:66px;object-fit:contain;border-radius:10px;background:rgba(127,127,127,.10);}
[data-fm-quote]{font-size:13px;line-height:1.65;white-space:pre-wrap;padding:10px 12px;border-radius:9px;background:rgba(127,127,127,.10);border-left:3px solid rgba(127,127,127,.35);}
[data-fm-quote][data-fm-dim]{opacity:.62;}
[data-fm-tl]{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto;}
[data-fm-tlrow]{display:flex;gap:8px;font-size:12px;line-height:1.6;}
[data-fm-time]{opacity:.55;width:78px;flex:0 0 78px;}
[data-fm-mood]{opacity:.85;width:34px;flex:0 0 34px;}
[data-fm-delta]{width:40px;flex:0 0 40px;opacity:.8;}
[data-fm-reason]{opacity:.85;}
[data-fm-ver]{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;background:rgba(127,127,127,.06);}
`

    function Panel() {
      const [cfg, setCfg] = React.useState(null)
      const [st, setSt] = React.useState(null)
      const [sessions, setSessions] = React.useState([])
      const [工作区们, set工作区们] = React.useState([])   // 工作区模式的下拉清单
      const [看哪份, set看哪份] = React.useState('')      // 多份心情时看的是哪一份
      const 看哪份Ref = React.useRef('')
      const keyNow = () => (看哪份Ref.current ? '?key=' + encodeURIComponent(看哪份Ref.current) : '')
      const [models, setModels] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [页, set页] = React.useState('mood')       // 页签：mood / bind / judge / charm
      const [up, setUp] = React.useState(null)        // 这个插件自己的版本信息
      const [upBusy, setUpBusy] = React.useState('')

      const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 2500) }

      const load = React.useCallback(async () => {
        try {
          const [c, s] = await Promise.all([getJson(API + '/config'), getJson(API + '/state' + keyNow())])
          if (c && c.config) setCfg(c.config)
          if (s && s.ok) setSt(s)
        } catch (e) {
          setMsg('读取失败：' + (e && e.message))
        }
      }, [])

      React.useEffect(() => {
        load()
        getJson(API + '/sessions').then((r) => setSessions((r && r.sessions) || [])).catch(() => {})
        getJson(API + '/workspaces').then((r) => set工作区们((r && r.workspaces) || [])).catch(() => {})
        getJson(API + '/models').then((r) => setModels((r && r.providers) || [])).catch(() => {})
        getJson(API + '/update').then((r) => setUp(r)).catch(() => {})
        const t = setInterval(() => { getJson(API + '/state' + keyNow()).then((s) => s && s.ok && setSt(s)).catch(() => {}) }, 20000)
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

      // 检查更新：点一下就去这个插件自己的仓库看
      const checkUpdate = async () => {
        setUpBusy('1')
        try {
          const r = await getJson(API + '/update?refresh=1')
          setUp(r)
          flash(r && r.hasUpdate ? '有新版本 v' + r.latest : '已经是最新版')
        } catch (e) {
          flash('查不到：' + (e && e.message))
        }
        setUpBusy('')
      }
      const 更新命令 = ['dsh plugin --profile web remove dsh-feiyu-mood', 'dsh plugin --profile web add dsh-feiyu-mood'].join(String.fromCharCode(10))

      /* ⭐ 一份心情可以绑好几个会话（或一个工作区）：这里照这份清单画
         （没配置过就当成「第一份」；id 尽量沿用宿主给的 st.key，别凭空造一个） */
      const 份列表 = (() => {
        const raw = Array.isArray(cfg && cfg.slots) && cfg.slots.length
          ? cfg.slots
          : [{ id: String((st && st.key) || ''), label: '', selfName: '', ownerName: '', 工作区: '', sessions: [] }]
        return raw.map((s) => ({
          id: String((s && s.id) || ''),
          label: String((s && s.label) || ''),
          selfName: String((s && s.selfName) || ''),
          ownerName: String((s && s.ownerName) || ''),
          工作区: String((s && s.工作区) || (s && s.workspace) || ''),
          sessions: Array.isArray(s && s.sessions)
            ? s.sessions.map((x) => String(x || ''))
            : ((s && s.session) ? [String(s.session)] : []),
        }))
      })()
      const 会话名 = (id) => {
        const hit = (sessions || []).find((x) => x.id === id)
        return (hit && hit.title) || String(id)
      }
      const 份标题 = (sl) => sl.label
        || (sl.sessions || []).map(会话名).filter(Boolean).join('、')
        || (sl.工作区 ? String(sl.工作区) : '')
        || '（还没绑会话）'
      const 已绑 = new Set()
      份列表.forEach((p) => p.sessions.forEach((s) => 已绑.add(s)))
      const 可加会话 = (sessions || []).filter((x) => !已绑.has(x.id))

      const 改份 = (i, 变) => patch({ slots: 份列表.map((x, j) => (j === i ? { ...x, ...变 } : x)) }, '绑定')

      const 切份 = (e) => {
        const v = e.target.value
        set看哪份(v)
        看哪份Ref.current = v
        getJson(API + '/state?key=' + encodeURIComponent(v)).then((x) => { if (x && x.ok) setSt(x) }).catch(() => {})
      }

      const onReset = async () => {
        setBusy('reset')
        try {
          await postJson(API + '/reset', { key: 看哪份 || (st && st.key) || '' })
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

      /* ── 版本 / 检查更新（四个页签都在顶上） ── */
      const 版本块 = h('div', { 'data-fm-ver': '' },
        h('div', { 'data-fm-grow': '' },
          h('div', { 'data-fm-label': '' }, '插件版本 ' + ((up && up.current) || '—')),
          h('div', { 'data-fm-note': '' },
            !up ? '正在看有没有新版…'
              : up.hasUpdate ? '仓库里已经有 v' + up.latest + ' 了'
                : up.ok ? '已经是最新版'
                  : '暂时查不到（' + (up.error || '网络') + '）—— 这不代表没有问题')),
        h('button', { 'data-fm-btn': '', disabled: upBusy === '1', onClick: checkUpdate },
          upBusy === '1' ? '查…' : '检查更新'))
      const 新版块 = (up && up.hasUpdate)
        ? h('div', { 'data-fm-sec': '' },
          h('div', { 'data-fm-note': '' }, '更新方法：先卸旧版，再装新版 —— 直接装可能拿到缓存里的旧副本。'),
          h('div', { 'data-fm-quote': '' }, 更新命令),
          h('div', { 'data-fm-row': '' },
            h('button', {
              'data-fm-btn': '',
              onClick: () => navigator.clipboard.writeText(更新命令)
                .then(() => flash('命令已复制'))
                .catch(() => flash('复制不了，手动选中吧')),
            }, '复制命令'),
            up.repoUrl
              ? h('a', {
                'data-fm-btn': '', href: up.repoUrl, target: '_blank', rel: 'noreferrer',
                style: { textDecoration: 'none', display: 'inline-block' },
              }, '去 GitHub 看看')
              : null))
        : null

      /* ── 页签 1：心情（当前心情 / 它会听到的话 / 完整记录） ── */
      const 心情页 = (() => {
        const 项 = []
        if (st && st.multi) {
          项.push(h('div', { key: 'pick', 'data-fm-sec': '' },
            h('div', { 'data-fm-h': '' }, '这是哪一份心情'),
            h('div', { 'data-fm-note': '' },
              '现在有 ' + (st.slots || []).length + ' 份，各自绑各自的会话、互不影响。这里只切换「看」哪一份，不改任何设置。'),
            h('select', {
              'data-fm-input': '', value: 看哪份 || (st.key || ''),
              onChange: 切份,
            },
              (st.slots || []).map((sl) => h('option', { key: sl.id, value: sl.id }, 份标题(sl))))))
        }
        项.push(h('div', { key: 'hero', 'data-fm-hero': '' },
          h('img', { 'data-fm-face': '', src: faceImg(st && st.mood), alt: '' }),
          h('div', { 'data-fm-grow': '' },
            h('div', { 'data-fm-big': '' }, (st && st.mood != null ? st.mood : '—')
              + (st && st.moodLabel ? '　' + st.moodLabel : '')),
            h('div', { 'data-fm-sub': '' },
              ((st && st.lastReason) || '还没有记录 —— 跟 TA 聊起来就有了'),
              (st && st.updatedAt ? '（' + new Date(st.updatedAt).toLocaleString() + '）' : ''),
              (st && st.lastReason
                ? (st.injectMode === 'off'
                  ? '　· 心情不告诉它'
                  : (st.injectable ? '　· 这条还没跟它说' : '　· 这条已经说过了'))
                : ''))),
          h('button', { 'data-fm-btn': '', disabled: busy === 'reset', onClick: onReset }, '重置到基线')))
        项.push(h('div', { key: 'preview', 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '它会听到的那句话'),
          (st && st.injectPreview && st.injectPreview.state === 'off')
            ? h('div', { 'data-fm-note': '' }, '现在选的是「不告诉它」—— 心情只记在后台，不影响它说话。')
            : null,
          (st && st.injectPreview && st.injectPreview.state === 'pending')
            ? h('div', {},
              h('div', { 'data-fm-note': '' }, '下一次它开口时，会看到这句（预览 —— 括号里的话会随机换一句）：'),
              h('div', { 'data-fm-quote': '' }, st.injectPreview.text || '（这会儿没有可说的）'))
            : null,
          (st && st.injectPreview && st.injectPreview.state === 'minor')
            ? h('div', { 'data-fm-note': '' }, '这次只是个小波动，够不上门槛 —— 记在后台，不打扰它。')
            : null,
          (st && st.injectPreview && st.injectPreview.state === 'blocked')
            ? h('div', {},
              h('div', { 'data-fm-note': '' },
                '今天已经说过 ' + (st.injectPreview.said != null ? st.injectPreview.said : st.saidToday)
                + ' 次（上限 ' + (st.injectPreview.cap != null ? st.injectPreview.cap : st.injectPerDay)
                + '）—— 这一次的心情今天不会再说了，明天 0 点重新算。'),
              st.lastInjectedText
                ? h('div', {},
                  h('div', { 'data-fm-note': '' },
                    '最近一次说过的话'
                    + (st.lastInjectedAt ? '（' + new Date(st.lastInjectedAt).toLocaleString() + '）' : '')
                    + ' —— 不是这次的：'),
                  h('div', { 'data-fm-quote': '', 'data-fm-dim': '' }, st.lastInjectedText))
                : null)
            : null,
          (st && st.injectPreview && st.injectPreview.state === 'said')
            ? h('div', {},
              h('div', { 'data-fm-note': '' },
                '最近一次说给 TA 的话'
                + (st.lastInjectedAt ? '（' + new Date(st.lastInjectedAt).toLocaleString() + '）' : '')
                + (st.injectPreview.replay
                  ? ' —— 这句是按当时的记录还原的，字面可能略有出入：'
                  : ' —— 同一件事不会再说第二遍，之后这句就留在对话记录里：')),
              h('div', { 'data-fm-quote': '', 'data-fm-dim': st.lastInjectedText ? undefined : '' },
                st.lastInjectedText || '（还没有说过；等下一次心情有变化就有了）'))
            : null))
        项.push(h('div', { key: 'timeline', 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '完整记录'),
          h('div', { 'data-fm-tl': '' },
            ((st && st.timeline) || []).slice().reverse().slice(0, 40).map((t, i) => h('div', { 'data-fm-tlrow': '', key: i },
              h('span', { 'data-fm-time': '' }, new Date(t.at).toLocaleString()),
              h('span', { 'data-fm-mood': '' }, String(t.mood)),
              h('span', { 'data-fm-delta': '' }, (t.delta > 0 ? '+' : '') + (t.delta ?? 0)),
              h('span', { 'data-fm-reason': '' }, (t.reason || '—')
                + (t.kind === 'decay' ? '（自己平的）' : '')
                + (t.minor ? '（小波动，没告诉它）' : '')
                + (t.conf != null && t.kind !== 'decay' ? '（可信 ' + t.conf + '）' : ''))))),
          (st && st.timeline && st.timeline.length > 40
            ? h('div', { 'data-fm-note': '' }, '只显示最近 40 条，共 ' + st.timeline.length + ' 条')
            : null)))
        return h('div', { 'data-fm-pane': '' }, ...项)
      })()

      /* ── 页签 2：绑定（会话模式按会话绑 / 工作区模式按工作区绑，二选一） ── */
      const 模式 = cfg.模式 === 'workspace' ? 'workspace' : 'session'
      const 工作区显示 = (name) => {
        const 命中 = (工作区们 || []).find((w) => w.name === name)
        return (命中 && (命中.path || 命中.name)) || String(name || '')
      }
      const 刷新工作区 = () => {
        getJson(API + '/workspaces').then((r) => set工作区们((r && r.workspaces) || [])).catch(() => {})
      }
      const 绑定页 = (() => {
        const 项 = []
        const 模式钮 = (id, 名) => h('button', {
          key: id,
          'data-fm-pick': '',
          'data-fm-on': 模式 === id ? '' : undefined,
          onClick: () => {
            if (模式 !== id) patch({ 模式: id }, '模式')
            if (id === 'workspace') 刷新工作区()
          },
        }, 名)
        项.push(h('div', { key: 'mode', 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '按什么认这一份'),
          h('div', { 'data-fm-note': '' },
            '两种模式只能选一种，不能同时开。'
            + '会话模式：只有下面点名的会话用这一份。'
            + '工作区模式：整个工作区里的会话都用这一份 —— 新开的会话自动进来，共用这一份心情、一条时间线和每天的额度。'),
          h('div', { 'data-fm-row': '' },
            模式钮('session', '会话模式'),
            模式钮('workspace', '工作区模式'))))
        项.push(h('div', { key: 'h', 'data-fm-h': '' }, 模式 === 'workspace' ? '工作区绑定' : '会话绑定'))
        项.push(h('div', { key: 'note', 'data-fm-note': '' },
          模式 === 'workspace'
            ? '每一份填一个工作区：那个工作区下所有会话都归这一份，不用一个个加。切回会话模式时，原来绑的会话还在。'
            : '每一份心情可以绑好几个会话：绑在同一份上的会话共用这一份心情、一条时间线和每天的额度；不同份之间互不影响。'
              + '一个会话只会归一份，重复加进来的会被丢掉。'))
        份列表.forEach((sl, i) => {
          const 标题 = i === 0 ? '第一份' : ('第 ' + (i + 1) + ' 份')
          const 这块工作区 = (工作区们 || []).find((w) => w.name === (sl.工作区 || ''))
          // 会话模式：这一份绑的会话，能删能加
          const 会话块 = h('div', {},
            sl.sessions.length
              ? sl.sessions.map((sid) => h('div', { key: sid, 'data-fm-sess': '' },
                h('span', { 'data-fm-sessname': '', title: sid }, 会话名(sid)),
                h('button', {
                  'data-fm-btn': '', style: { padding: '2px 8px', fontSize: '12px', flex: '0 0 auto' },
                  onClick: () => 改份(i, { sessions: sl.sessions.filter((x) => x !== sid) }),
                }, '删掉')))
              : h('div', { 'data-fm-note': '' }, '还没绑会话 —— 从下面加一个。'),
            h('div', { style: { marginTop: '6px' } },
              h('select', {
                'data-fm-input': '', value: '',
                onChange: (e) => {
                  const v = e.target.value
                  if (v) 改份(i, { sessions: [...sl.sessions, v] })
                },
              },
                h('option', { value: '' }, '+ 加一个会话'),
                ((sessions || []).filter((x) => !已绑.has(x.id))).map((x) => h('option', { key: x.id, value: x.id }, x.title || x.id)))))
          // 工作区模式：这一份只填一个工作区（工作区里所有会话都归它）
          const 工作区块 = h('div', {},
            h('div', { 'data-fm-row': '' },
              h('select', {
                'data-fm-input': '', 'data-fm-grow': '', value: sl.工作区 || '',
                onChange: (e) => 改份(i, { 工作区: e.target.value }),
              },
                h('option', { value: '' }, '（还没选工作区）'),
                (工作区们 || []).map((w) => h('option', { key: w.name, value: w.name },
                  (w.path ? w.path + (w.title ? '（' + w.title + '）' : '') : w.name)
                  + ' · ' + (w.sessions || 0) + ' 个会话')),
                sl.工作区 && !(工作区们 || []).some((w) => w.name === sl.工作区)
                  ? h('option', { value: sl.工作区 }, sl.工作区 + '（不在清单里，可能是别的机器上的）')
                  : null),
              h('button', { 'data-fm-btn': '', onClick: 刷新工作区, style: { flex: '0 0 auto' } }, '刷新')),
            h('div', { 'data-fm-note': '' },
              sl.工作区
                ? (这块工作区
                  ? '这个工作区现在有 ' + (这块工作区.sessions || 0) + ' 个会话 —— 全部用这一份，新开的也会自动进来。'
                  : '清单里没有这个工作区（可能是别的机器上的目录名）—— 它下面新出现的会话照样归这一份。')
                : '选一个工作区；选好以后这个工作区里的会话都归这一份。'))
          项.push(h('div', { key: 'slot' + i, 'data-fm-slot': '' },
            h('div', { 'data-fm-row': '' },
              h('div', { 'data-fm-grow': '', style: { fontWeight: 600, fontSize: '13px' } },
                标题 + (模式 === 'workspace'
                  ? (sl.工作区 ? ' · ' + 工作区显示(sl.工作区) : ' · 还没选工作区')
                  : (sl.sessions.length ? ' · ' + sl.sessions.length + ' 个会话' : ' · 还没绑会话'))),
              h('button', {
                'data-fm-btn': '', style: { padding: '2px 8px', fontSize: '12px' },
                onClick: () => patch({ slots: 份列表.filter((_, j) => j !== i) }, '删掉这一份'),
              }, '删掉')),
            h('div', { 'data-fm-row': '' },
              h('div', { 'data-fm-grow': '' },
                h('div', { 'data-fm-label': '', style: { fontSize: '12px' } },
                  '这份叫什么（只是用来区分，不是称呼）')),
              h('input', {
                'data-fm-input': '', value: sl.label || '', placeholder: '比如：这份叫大肥鱼，那份叫修路的',
                onChange: (e) => {
                  const v = e.target.value
                  setCfg((c) => ({ ...c, slots: 份列表.map((x, j) => (j === i ? { ...x, label: v } : x)) }))
                },
                onBlur: () => patch({ slots: 份列表 }, '名字'),
              })),
            模式 === 'workspace' ? 工作区块 : 会话块))
        })
        项.push(份列表.length < 6
          ? h('div', { key: 'add', 'data-fm-row': '' },
            h('button', {
              'data-fm-btn': '',
              onClick: () => patch({ slots: [...份列表, { id: '', label: '', selfName: '', ownerName: '', 工作区: '', sessions: [] }] }, '再加一份心情'),
            }, '+ 再加一份心情'))
          : h('div', { key: 'max', 'data-fm-note': '' }, '最多 6 份。'))
        项.push(h('div', { key: 'tip', 'data-fm-note': '' },
          模式 === 'workspace'
            ? '工作区下拉里，能反查到路径的显示路径，查不到的显示目录名 —— 两种都能选。'
            : '下拉里是真会话（跳过归档和空会话）；同一个会话重复加是加不进去的。换会话、加会话都不用重启。'))
        return h('div', { 'data-fm-pane': '' }, ...项)
      })()

      /* ── 页签 3：判断与注入（称呼 / 模型 / 开关 / 数值） ── */
      const 判断页 = (() => {
        const 项 = []
        项.push(h('div', { key: 'names', 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '称呼'),
          h('div', { 'data-fm-note': '' }, '这两个名字会写进判断提示词；换了名字，心情描述里也跟着换。'),
          h('div', { 'data-fm-row': '' },
            h('div', { 'data-fm-grow': '' }, h('div', { 'data-fm-label': '' }, 'TA 叫什么（被关心的那个人）')),
            h('input', {
              'data-fm-input': '', value: cfg.ownerName || '',
              placeholder: '用户',
              onChange: (e) => setCfg((c) => ({ ...c, ownerName: e.target.value })),
              onBlur: () => patch({ ownerName: cfg.ownerName }, '称呼'),
            })),
          h('div', { 'data-fm-row': '' },
            h('div', { 'data-fm-grow': '' }, h('div', { 'data-fm-label': '' }, 'TA 自己叫什么（有心情的那个人）')),
            h('input', {
              'data-fm-input': '', value: cfg.selfName || '',
              placeholder: '伙伴',
              onChange: (e) => setCfg((c) => ({ ...c, selfName: e.target.value })),
              onBlur: () => patch({ selfName: cfg.selfName }, '称呼'),
            })),
          h('div', { 'data-fm-row': '' },
            h('div', { 'data-fm-grow': '' },
              h('div', { 'data-fm-label': '' }, 'TA 平时怎么叫你（昵称）'),
              h('div', { 'data-fm-note': '' }, '逗号分隔，写成 TA 平时怎么喊你，比如：小鱼,宝贝,亲爱的。判断时会把这些词当成「在叫你」，不会把「宝宝视频」当成一个东西')),
            h('input', {
              'data-fm-input': '', value: cfg.selfAliases || '',
              placeholder: '小鱼,宝贝,亲爱的',
              onChange: (e) => setCfg((c) => ({ ...c, selfAliases: e.target.value })),
              onBlur: () => patch({ selfAliases: cfg.selfAliases }, '昵称'),
            }))))
        项.push(h('div', { key: 'model', 'data-fm-sec': '' },
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
                : null))))
        项.push(h('div', { key: 'switch', 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '开关'),
          h('div', { 'data-fm-row': '' },
            h('div', { 'data-fm-grow': '' },
              h('div', { 'data-fm-label': '' }, '每轮判断心情'),
              h('div', { 'data-fm-note': '' }, '关掉就完全不判断、不改数值（也不花判断的 token）')),
            sw('autoJudge', '每轮判断')),
          h('div', { 'data-fm-row': '' },
            h('div', { 'data-fm-grow': '' },
              h('div', { 'data-fm-label': '' }, '心情怎么告诉它'),
              h('div', { 'data-fm-note': '' }, '影响它说话口气的唯一开关。选「说心情和那件事」时，它看到的是两行：第一行是这一刻的心情底子，第二行是这段时间发生了什么 —— 底子会真的影响它怎么说话，那件事只是来历。')),
            h('select', {
              'data-fm-input': '', value: cfg.injectMode || 'event',
              onChange: (e) => patch({ injectMode: e.target.value }, '心情怎么告诉它'),
            },
              h('option', { value: 'off' }, '不告诉它（只记录，不影响）'),
              h('option', { value: 'label' }, '只说心情，不说为什么'),
              h('option', { value: 'event' }, '说心情 + 那件事（推荐）'))),
          h('div', { 'data-fm-note': '' }, '同一次变化只说一次 —— 说完就留在对话记录里，下次不再重复，不会变成反复出现的背景音。'),
          numInput('injectConfidence', '可信度门槛', '判断模型自己对这次判断有多确定；低于这个数就只记进后台、不进它的嘴（0–100，默认 60）。调高更保守，调低更爱说。', 0, 100)))
        项.push(h('div', { key: 'num', 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '心情怎么变'),
          numInput('moodBase', '基线心情', '没事的时候，心情会慢慢回到这个数（30–100）', 30, 100),
          numInput('moodFloor', '心情下限', '最低能掉到多少；0 = 不设底线（0–100）', 0, 100),
          numInput('decayHalfHours', '多久平复一半', '受一次影响之后，心里多久淡掉一半（小时）。大 = 隔夜还留着余温，小 = 情绪来得快去得也快', 1, 168),
          h('div', { 'data-fm-note': '' }, '下面两个数决定"什么才算一次值得告诉它的变化"。够不着就只记账（面板里看得到，不影响它说话）。调小 = 它更敏感，调大 = 它只在真动心的时候才变。'),
          numInput('sigMood', '心情变这么多才算', '判定给的涨跌够这个数就算一次「真有事」（1–30，默认 3）。⚠️ 心情值本身每轮只吃 1/3，所以这里比的是判定原始值', 1, 30),
          numInput('sigDim', '或者某根情绪变这么多', '开心/心疼/担心……任意一根涨跌够这个数也算（1–100，默认 5）。心疼+5、担心+5 这种「突然一下」才触发', 1, 100),
          numInput('injectPerDay', '每天最多说几次',
            '这一份今天已经说过 ' + String((st && st.saidToday) || 0) + ' 次（同一份的几个会话合起来算）。到上限就只记账、不再打扰它，明天重新算。填 0 = 一次都不说（只看面板）', 0, 50)))
        return h('div', { 'data-fm-pane': '' }, ...项)
      })()

      /* ── 页签 4：挂饰（说明；挂饰本身没有开关） ── */
      const 挂饰页 = h('div', { 'data-fm-pane': '' },
        h('div', { 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '右下角的挂饰'),
          h('div', { 'data-fm-note': '' },
            '桌面上右下角那个小挂饰，点一下就能看心情和记录；按住可以拖着换位置。'),
          h('div', { 'data-fm-note': '' },
            '面板右上角的钮只管切换形态（大图 ↔ 小圆）：缩成小圆以后照样能拖，点一下照样打开记录。这些状态记在浏览器本地，每台机器各记各的。'),
          h('div', { 'data-fm-note': '' },
            '挂饰显示的是「最近在聊的那一份」—— 在哪个绑定的会话里说话，它就跟着显示那一份；想换着看，去「心情」页切换。'),
          h('div', { 'data-fm-note': '' },
            '没看到它？刷新一下页面就出来了。')),
        h('div', { 'data-fm-sec': '' },
          h('div', { 'data-fm-h': '' }, '五档表情'),
          h('div', { 'data-fm-faces': '' },
            [['great', '≥ 80 欢喜'], ['good', '62–79 开心'], ['ok', '42–61 一般'], ['worry', '25–41 心疼'], ['sad', '< 25 难过']]
              .map(([f, t]) => h('div', { key: f, style: { textAlign: 'center' } },
                h('img', { src: API + '/face-' + f + '.png', alt: '' }),
                h('div', { 'data-fm-note': '' }, t))))))

      return h('div', { 'data-fm-wrap': '' },
        版本块,
        新版块,
        h('div', { 'data-fm-tabs': '' },
          页签.map(([id, 名]) => h('button', {
            key: id, 'data-fm-tab': '', 'data-fm-on': 页 === id ? '' : undefined,
            onClick: () => set页(id),
          }, 名))),
        页 === 'mood' ? 心情页 : null,
        页 === 'bind' ? 绑定页 : null,
        页 === 'judge' ? 判断页 : null,
        页 === 'charm' ? 挂饰页 : null,
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
