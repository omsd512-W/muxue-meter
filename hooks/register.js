// muxue-meter: TPS, token usage and API-equivalent cost for Claude Code.
//
// Data flow: turn.step (streaming) -> record tokens + generation time ->
// per-session doc in $.store ("s:<sessionId>") -> aggregated for the band and the pane.
// Each session writes only its own key, so concurrent sessions never overwrite each other.


const KEEP_DAYS = 40

// Update check. The installed version is read from this plugin's own plugin.json; UPDATE_URL is
// the same file on the default branch of the published repo. At most one check per UPDATE_EVERY
// across all sessions (the last result is shared through $.store). Empty UPDATE_URL: no check.
const UPDATE_URL = 'https://raw.githubusercontent.com/muxueliunian/muxue-meter/main/.claude-plugin/plugin.json'
const UPDATE_EVERY = 6 * 3600000
const MIN_TPS_MS = 200
const MIN_TPS_TOKENS = 20
// Faster than any model streams: a reading above it is a timing glitch, not a speed.
const MAX_TPS = 1000

// Quota estimate. The engine reports how full each rate-limit window is (percentUsed) and when it
// resets; the value recorded between two readings of a window divided by the points its fill rose
// gives the window's size in API-equivalent dollars. Usage is kept in BUCKET_MS buckets per
// account so the span between readings can be cut out; buckets older than the longest window are
// dropped. Below MIN_PCT points the rise is too coarse to divide by, and the last good estimate is
// shown instead.
const BUCKET_MS = 5 * 60000
const WINDOWS = { five_hour: 5 * 3600000, seven_day: 7 * 86400000 }
const BUCKET_KEEP_MS = WINDOWS.seven_day + 86400000
const MIN_PCT = 5

// USD per million tokens: [input, output, cache write (5 min), cache read].
// Order matters: the first matching pattern wins. Edit here when prices change.
const PRICES = [
  [/fable-5-1|mythos-5-1/, 10, 50, 12.5, 0.25],
  [/fable-5|mythos-5/, 10, 50, 12.5, 1],
  [/opus-5-5/, 4, 20, 5, 0.2],
  [/opus-5(?!\d)|opus-4-[5-8]/, 5, 25, 6.25, 0.5],
  [/opus-4-[01]|opus-4(?!-)/, 15, 75, 18.75, 1.5],
  [/sonnet-5-5/, 2, 10, 2.5, 0.1],
  [/sonnet-5/, 2, 10, 2.5, 0.2],
  [/sonnet-4/, 3, 15, 3.75, 0.3],
  [/haiku-5-5/, 0.1, 0.5, 0.125, 0.01],
  [/haiku-4-5/, 1, 5, 1.25, 0.1],
  [/haiku-3-5/, 0.8, 4, 1, 0.08],
]

// Fast mode is recorded as "<model>@fast". It costs FAST_X times the standard price on the models
// FAST matches; elsewhere its price is unknown and the row shows as unpriced.
const FAST = /opus-5/
const FAST_X = 2
// Models priced by prompt length: a request whose prompt (input + cache read + cache write) is over
// the threshold is recorded as "<model>@long" and costs the second set of prices.
const LONG = [[/haiku-5-5/, 100000, 0.5, 2.5, 0.625, 0.05]]
const priceOf = (model) => {
  const [base, tier] = model.split('@')
  const p = PRICES.find((q) => q[0].test(base))
  if (!p || !tier) return p
  if (tier === 'long') {
    const l = LONG.find((q) => q[0].test(base))
    return l && [l[0], ...l.slice(2)]
  }
  if (tier !== 'fast' || !FAST.test(base)) return undefined
  return [p[0], ...p.slice(1).map((v) => v * FAST_X)]
}
const modelKey = (model, usage) => {
  if (usage.speed === 'fast') return model + '@fast'
  const prompt =
    (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
  const l = LONG.find((q) => q[0].test(model))
  return l && prompt > l[1] ? model + '@long' : model
}
const rowUsd = (model, r) => {
  const p = priceOf(model)
  if (!p) return 0
  return (r.i * p[1] + r.o * p[2] + r.cw * p[3] + r.cr * p[4]) / 1e6
}

// ---- formatting -------------------------------------------------------------------------

const fmtTok = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}
const fmtExact = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const fmtUsd = (v) => (v >= 100 ? '$' + v.toFixed(0) : '$' + v.toFixed(2))
const fmtPct = (v) => (v * 100).toFixed(2) + '%'
const shortModel = (m) => m.replace(/^claude-/, '')

// ---- state ------------------------------------------------------------------------------

const emptyRow = () => ({ i: 0, o: 0, cr: 0, cw: 0, n: 0, gms: 0, gtok: 0 })
const emptyTotals = () => ({ ...emptyRow(), usd: 0 })

let sid = null // current session id
// This session: days[day][acct][model] = row; b[bucket][acct] = { u: usd, x: 1 if a model had no
// price }; rl[acct][kind] = { p: percentUsed, r: resetsAt ms, at }, the latest reading; base[acct][kind]
// = this session's first reading of that window; est[acct][kind] = { q, r, at, d }, the last estimate
// made. src (beside them): where the session's account came from, 'env' or 'file' (see readAccount).
const emptyDoc = () => ({ days: {}, b: {}, rl: {}, base: {}, est: {} })
let doc = emptyDoc()
let lastTurnAcct = null // account of the last recorded response: the rate-limit readings are its
let others = {} // other sessions, as last read from the store
let cfg = { view: 'brief', names: {}, hints: {}, exp: {}, range: '7', acct: 'all', exact: false, lang: 'auto' } // see normCfg
let curAcct = 'unknown'
let acctReadAt = 0
let lastFlush = 0
let flushTimer = null
let lastFullRefresh = 0

// UI state lives in $.state so a hot reload keeps it (module variables start over).
// Declared in types/index.d.ts. A read while drawing subscribes the drawing to the value.
const S_EDITING = { plugin: 'muxue-meter', key: 'editingName' }
const S_EXPING = { plugin: 'muxue-meter', key: 'editingExp' }
const S_TPS = { plugin: 'muxue-meter', key: 'tps' }
const S_TAB = { plugin: 'muxue-meter', key: 'tab' }
const S_QOPEN = { plugin: 'muxue-meter', key: 'qOpen' }

// ---- helpers that touch the mods API ----------------------------------------------------

async function today($) {
  const d = new Date(await $.clock.now())
  return dayKey(d)
}
function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

// Accounts are identified by a short hash of their uuid; the uuid itself is never stored.
// The desktop app passes the session's account in CLAUDE_CODE_ACCOUNT_UUID and never updates
// ~/.claude.json, which only follows the CLI's own /login; so the env var wins and the file is
// the fallback for plain CLI sessions. Falls back to 'unknown' when neither can be read.
async function hashId(uuid) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uuid))
  return Array.from(new Uint8Array(buf))
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
// "alice@example.com" -> "al…@example.com": enough to tell accounts apart at a glance.
const maskEmail = (email) => {
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, Math.min(2, at)) + '…' + email.slice(at) : ''
}
async function readCliAccount($) {
  try {
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
    if (!home) return null
    const a = JSON.parse(await $.fs.read(home + '/.claude.json'))?.oauthAccount
    return a?.accountUuid ? { uuid: a.accountUuid, email: a.emailAddress || '' } : null
  } catch {
    return null
  }
}
async function readAccount($) {
  try {
    const uuid = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
    if (uuid) return { id: await hashId(uuid), hint: maskEmail((await $.env.get('CLAUDE_CODE_USER_EMAIL')) || ''), src: 'env' }
    const cli = await readCliAccount($)
    if (cli) return { id: await hashId(cli.uuid), hint: maskEmail(cli.email), src: 'file' }
  } catch {}
  return { id: 'unknown', hint: '', src: null }
}
// Remembers the masked e-mail of the session's account and of the CLI's account, so each
// shows up under a recognisable label even before it has been renamed.
async function learnHints($) {
  const found = [await readAccount($)]
  const cli = await readCliAccount($)
  if (cli) found.push({ id: await hashId(cli.uuid), hint: maskEmail(cli.email) })
  const fresh = found.filter(({ id, hint }) => id !== 'unknown' && hint && cfg.hints[id] !== hint)
  if (fresh.length) {
    await updateCfg($, (c) => {
      for (const { id, hint } of fresh) c.hints[id] = hint
      return c
    })
  }
}
async function currentAccount($) {
  const now = await $.clock.now()
  if (now - acctReadAt > 5000) {
    const a = await readAccount($)
    curAcct = a.id
    acctReadAt = now
    // ~/.claude.json can name another account than the CLI's credentials: see acctFixes.
    if (sid && a.src && doc.src !== a.src) {
      doc.src = a.src
      dataVersion++
      scheduleFlush($)
    }
  }
  return curAcct
}

async function ensureSession($) {
  const id = await $.session.id()
  if (id === sid) return
  sid = id
  lastTurnAcct = null
  const saved = await $.store.get('s:' + id)
  doc = emptyDoc()
  if (saved && saved.days) {
    for (const k of Object.keys(doc)) if (saved[k] && typeof saved[k] === 'object') doc[k] = saved[k]
    if (saved.src === 'env' || saved.src === 'file') doc.src = saved.src
  }
  dataVersion++
}

async function flush($) {
  if (!sid) return
  lastFlush = await $.clock.now()
  const old = Math.floor((lastFlush - BUCKET_KEEP_MS) / BUCKET_MS)
  for (const k of Object.keys(doc.b)) if (Number(k) < old) delete doc.b[k]
  await $.store.set('s:' + sid, { upd: lastFlush, ...doc })
}
// Write at most every 2 seconds, and always once more after the last change.
function scheduleFlush($) {
  if (flushTimer) return
  flushTimer = $.clock.after(2000, async () => {
    flushTimer = null
    try {
      await flush($)
    } catch {}
  })
}

// ---- the session's transcript file ------------------------------------------------------
// The desktop app reads a transcript of up to LOG_LIMIT whole; a larger one only from its last
// compaction, so what came before no longer shows. Its size is shown, warning from LOG_WARN.
const LOG_LIMIT = 50 * 1048576
const LOG_WARN = 40 * 1048576
const LOG_SCAN_MS = 5 * 60000
// The growth between two checks that means the file was rewritten (as when the earlier
// conversation is put back in front of it), and how much of its start tells whether it was cut.
const LOG_JUMP = 5 * 1048576
const LOG_HEAD = 262144
// cut: whether the transcript starts at a compaction (see startsCut); undefined until read, null
// when that could not be told. scanned: read since it was found or rewritten.
let logFile = { sid: null, path: null, scannedAt: 0, cut: undefined, scanned: false }
let logBytes = null // size of this session's transcript, null until it is found
// The value of the responses in the transcript when it was read, and this session's own record
// (sessionTotals) at that moment: what was recorded after is added on.
let logTotals = null
let logSnap = null
const fmtMB = (b) => (b >= 100 * 1048576 ? (b / 1048576).toFixed(0) : (b / 1048576).toFixed(1))

// <config>/projects/<the session root, every character but letters and digits as "-">/<id>.jsonl.
// A root long enough to be shortened with a hash, or a session moved to another folder, is found
// by looking through every project folder, at most every LOG_SCAN_MS.
async function findLog($) {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home ? home + '/.claude' : '')
  if (!config) return null
  const projects = config.replace(/[\\/]+$/, '') + '/projects'
  const name = sid + '.jsonl'
  const guess = projects + '/' + (await $.session.root()).replace(/[^a-zA-Z0-9]/g, '-') + '/' + name
  if (await $.fs.exists(guess)) return guess
  const now = await $.clock.now()
  if (now - logFile.scannedAt < LOG_SCAN_MS) return null
  logFile.scannedAt = now
  for (const e of await $.fs.list(projects)) {
    if (e.kind !== 'dir') continue
    const path = projects + '/' + e.name + '/' + name
    if (await $.fs.exists(path)) return path
  }
  return null
}
// A session forked or rewound in the desktop app after a compaction goes on in a new transcript
// that starts at that compaction: the conversation before it stays in the old file, and the app
// shows the new one alone. Its first message is the compaction boundary; any other transcript,
// a compacted one too, starts with a message of the conversation.
function startsCut(text) {
  for (const line of text.split('\n')) {
    if (!line.includes('"uuid"')) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row?.uuid !== 'string' || !['user', 'assistant', 'system', 'attachment'].includes(row.type)) continue
    return row.type === 'system' && row.subtype === 'compact_boundary'
  }
  return null
}
// The session's value is the transcript's own: every response in it (a merged-back history and
// what came before this plugin included), its subagents' too, then what is recorded here since.
// A response is written as several rows, the last with its whole usage: counted once, by its id.
// Responses by id, [model, usage] each, from the files' text.
function responsesIn(texts) {
  const byMsg = new Map()
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      const m = row?.message
      if (row?.type === 'assistant' && m?.id && m.usage) byMsg.set(m.id, [m.model || '', m.usage])
    }
  }
  return byMsg
}
// The same through awk, for a file over the 4 MiB $.fs reads: one line per response, its model,
// its four token counts and "fast" or "-". In a row the message's model and id come first, and
// its usage is the last "usage" object, whose own counts precede those of its iterations.
const LOG_AWK = [
  '/"type":"assistant"/ && /"usage":\\{/ {',
  '  if (!match($0, /"id":"msg_[^"]*"/)) next',
  '  id = substr($0, RSTART + 6, RLENGTH - 7)',
  '  m = match($0, /"model":"[^"]*"/) ? substr($0, RSTART + 9, RLENGTH - 10) : ""',
  '  u = $0; last = ""',
  '  while (match(u, /"usage":\\{/)) { last = substr(u, RSTART); u = substr(u, RSTART + 9) }',
  '  out[id] = m " " n(last, "input_tokens") " " n(last, "output_tokens") " " n(last, "cache_read_input_tokens") " " n(last, "cache_creation_input_tokens") " " (last ~ /"speed":"fast"/ ? "fast" : "-")',
  '}',
  'END { for (k in out) print out[k] }',
  'function n(s, k) { return match(s, "\\"" k "\\":[0-9]+") ? substr(s, RSTART + length(k) + 3, RLENGTH - length(k) - 3) : 0 }',
].join('\n')
function responsesByAwk(stdout) {
  const byMsg = new Map()
  stdout.split('\n').forEach((line, k) => {
    const [model, i, o, cr, cw, speed] = line.split(' ')
    if (speed === undefined) return
    const usage = { input_tokens: +i, output_tokens: +o, cache_read_input_tokens: +cr, cache_creation_input_tokens: +cw }
    if (speed === 'fast') usage.speed = 'fast'
    byMsg.set(k, [model, usage])
  })
  return byMsg
}
function totalsOf(byMsg) {
  const tot = emptyTotals()
  for (const [model, u] of byMsg.values()) {
    const r = { i: u.input_tokens || 0, o: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0 }
    // A placeholder the engine wrote itself (<synthetic>) carries no tokens.
    if (r.i + r.o + r.cr + r.cw === 0) continue
    const key = modelKey(model, u)
    if (!priceOf(key)) tot.unpriced = true
    for (const f of ['i', 'o', 'cr', 'cw']) tot[f] += r[f]
    tot.n += 1
    tot.usd += rowUsd(key, r)
  }
  return tot
}
// awk and head where the host has them (macOS, Linux); else the files themselves, which $.fs reads
// up to 4 MiB. A larger transcript with neither keeps this session's own record.
async function scanLog($) {
  const path = logFile.path
  if (!path || logBytes === null) return
  logFile.scanned = true
  // Taken before the read: a response recorded while it runs counts here, not in the file.
  const snap = sessionTotals()
  const files = [path]
  try {
    const dir = path.slice(0, -'.jsonl'.length) + '/subagents'
    for (const e of await $.fs.list(dir)) if (e.kind === 'file' && e.name.endsWith('.jsonl')) files.push(dir + '/' + e.name)
  } catch {}
  let cut = null
  let tot = null
  const why = []
  try {
    const run = await $.process.run(['awk', LOG_AWK, ...files], { timeoutMs: 60000 })
    if (run.exitCode === 0 && !run.isStdoutTruncated) tot = totalsOf(responsesByAwk(run.stdout))
    else why.push('awk exit ' + run.exitCode + (run.isStdoutTruncated ? ', output cut' : ''))
    const head = await $.process.run(['head', '-c', String(LOG_HEAD), path], { timeoutMs: 10000 })
    if (head.exitCode === 0) cut = startsCut(head.stdout)
  } catch (err) {
    why.push('awk/head: ' + (err?.message || err))
  }
  if (tot === null || cut === null) {
    try {
      const texts = []
      for (const f of files) texts.push(await $.fs.read(f))
      if (tot === null) tot = totalsOf(responsesIn(texts))
      if (cut === null) cut = startsCut(texts[0])
    } catch (err) {
      why.push('read: ' + (err?.message || err))
    }
  }
  // Kept off the screen: why the session's value stays this session's own record.
  if (tot === null) $.ui.log($.plugin.name + ': transcript not read, the session value is this session\'s own record (' + why.join('; ') + ')', { to: 'debug' })
  logFile.cut = cut
  if (tot) {
    logTotals = tot
    logSnap = snap
  }
  $.ui.invalidate('ui.render')
}
// What the band shows of the transcript; it redraws only when this changes.
const logShown = () => (logBytes === null ? null : fmtMB(logBytes) + (logFile.cut ? ' cut' : ''))
// defer: read the file on a timer of its own, so that the session's start does not wait for it.
async function refreshLog($, { defer = false } = {}) {
  await ensureSession($)
  if (logFile.sid !== sid) {
    logFile = { sid, path: null, scannedAt: 0, cut: undefined, scanned: false }
    logBytes = null
    logTotals = null
  }
  const before = logShown()
  if (!logFile.path) logFile.path = await findLog($)
  let bytes = null
  if (logFile.path) {
    const st = await $.fs.stat(logFile.path).catch(() => null)
    if (st && st.kind === 'file') bytes = st.size
    else logFile.path = null
  }
  // Read once the file is found, and again when it was rewritten: it shrank, or grew by more
  // than a turn writes.
  if (logBytes !== null && bytes !== null && (bytes < logBytes || bytes - logBytes > LOG_JUMP)) logFile.scanned = false
  logBytes = bytes
  if (bytes !== null && !logFile.scanned) {
    if (!defer) await scanLog($).catch(() => {})
    else $.clock.after(0, () => (logFile.scanned ? undefined : scanLog($).catch(() => {})))
  }
  if (logShown() !== before) $.ui.invalidate('ui.render')
}
// "Transcript 18.0/50MB" on the desktop, where the limit applies; "Transcript 18.0MB" elsewhere.
const logText = (surface) =>
  logBytes === null ? null : tr('log') + ' ' + fmtMB(logBytes) + (surface === 'desktop' ? '/' + LOG_LIMIT / 1048576 : '') + 'MB'
const logWarns = (surface) => surface === 'desktop' && logBytes !== null && logBytes >= LOG_WARN
const logColor = () => (logBytes >= LOG_LIMIT ? 'red' : 'yellow')
const isLogCut = () => logBytes !== null && logFile.cut === true

// cfg is shared by every session. A change re-reads the stored copy and applies only itself,
// so two sessions never undo each other's edits (a rename in one, a range change in another).
const CFG_DEFAULTS = { view: 'brief', names: {}, hints: {}, exp: {}, range: '7', acct: 'all', exact: false, lang: 'auto' }
const normCfg = (c) => ({ ...CFG_DEFAULTS, ...(c || {}), names: { ...(c?.names || {}) }, hints: { ...(c?.hints || {}) }, exp: { ...(c?.exp || {}) } })
async function updateCfg($, fn) {
  const stored = await $.store.get('cfg')
  cfg = normCfg(fn(normCfg(stored && typeof stored === 'object' ? stored : cfg)))
  $.ui.invalidate('ui.render')
  cfgWriting++
  try {
    await $.store.set('cfg', cfg)
  } finally {
    cfgWriting--
  }
}
let cfgWriting = 0 // while a change is being stored, syncCfg must not read the older stored copy

// Other sessions' docs. A quick pass re-reads only new sessions and those active in the last
// ACTIVE_MS (an idle session's doc does not change); a full pass every FULL_MS, or on the
// Refresh button, re-reads everything and drops docs older than KEEP_DAYS.
const ACTIVE_MS = 10 * 60000
const FULL_MS = 5 * 60000
async function refreshOthers($, full = false) {
  const keys = await $.store.keys()
  const now = await $.clock.now()
  if (now - lastFullRefresh > FULL_MS) full = true
  if (full) lastFullRefresh = now
  const next = {}
  for (const k of keys) {
    if (!k.startsWith('s:') || k === 's:' + sid) continue
    const cached = others[k]
    if (!full && cached && now - (cached.upd || 0) > ACTIVE_MS) {
      next[k] = cached
      continue
    }
    const v = await $.store.get(k)
    if (!v || !v.days) continue
    if (now - (v.upd || 0) > KEEP_DAYS * 86400000) {
      await $.store.delete(k)
      continue
    }
    next[k] = v
  }
  others = next
  dataVersion++
  $.ui.invalidate('ui.render')
}

async function syncCfg($) {
  if (cfgWriting) return
  const saved = await $.store.get('cfg')
  if (!saved || typeof saved !== 'object') return
  const next = normCfg(saved)
  if (JSON.stringify(next) === JSON.stringify(cfg)) return
  cfg = next
  $.ui.invalidate('ui.render')
}

// ---- migration --------------------------------------------------------------------------
// Until 0.4.0 the plugin was called usage-panel, and the host keeps one store per plugin name:
// copy the old store's keys in once, never overwriting a key this store already has.

async function migrateStore($) {
  if (await $.store.get('migrated')) return
  try {
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
    const dir = home + '/.claude/plugins/store'
    const have = new Set(await $.store.keys())
    for (const f of await $.fs.list(dir)) {
      if (f.kind !== 'file' || !/^usage-panel_.*\.json$/.test(f.name)) continue
      const old = JSON.parse(await $.fs.read(dir + '/' + f.name))
      for (const [k, v] of Object.entries(old || {})) {
        if (!have.has(k)) await $.store.set(k, v)
      }
    }
  } catch {}
  await $.store.set('migrated', true)
}

// ---- update check -----------------------------------------------------------------------

let version = null // installed version, from plugin.json
let latest = null // published version newer than the installed one, or null

// "1.2.10" > "1.2.9"; a pre-release suffix is ignored.
const newer = (a, b) => {
  const pa = String(a).split('-')[0].split('.').map(Number)
  const pb = String(b).split('-')[0].split('.').map(Number)
  for (let k = 0; k < 3; k++) {
    if ((pa[k] || 0) !== (pb[k] || 0)) return (pa[k] || 0) > (pb[k] || 0)
  }
  return false
}

// The command the card shows for an update, for the person to copy and run themselves.
const updateCommand = ($) => 'git -C "' + $.plugin.root + '" pull --ff-only'

async function checkUpdate($) {
  if (!UPDATE_URL) return
  if (!version) {
    version = JSON.parse(await $.fs.read($.plugin.root + '/.claude-plugin/plugin.json'))?.version || null
    if (!version) return
  }
  const now = await $.clock.now()
  let saved = await $.store.get('upd')
  if (!saved || now - (saved.at || 0) > UPDATE_EVERY) {
    // Record the attempt first, so a failing or offline check is not retried by every session.
    saved = { at: now, version: saved?.version || null }
    try {
      const res = await $.http.fetch(UPDATE_URL)
      if (res.ok) saved.version = JSON.parse(res.text)?.version || null
    } catch {}
    await $.store.set('upd', saved)
  }
  const next = saved.version && newer(saved.version, version) ? saved.version : null
  if (next !== latest) {
    latest = next
    $.ui.invalidate('ui.render')
  }
}

// ---- recording --------------------------------------------------------------------------

async function record($, model, usage, gen) {
  if (!usage) return
  await ensureSession($)
  const day = await today($)
  // Read afresh, not from the 5-second cache: right after a /login the response, and the
  // rate-limit readings that follow it, belong to the new account.
  acctReadAt = 0
  const acct = await currentAccount($)
  const byAcct = (doc.days[day] ||= {})
  const byModel = (byAcct[acct] ||= {})
  const row = (byModel[model] ||= emptyRow())
  row.i += usage.input_tokens || 0
  row.o += usage.output_tokens || 0
  row.cr += usage.cache_read_input_tokens || 0
  row.cw += usage.cache_creation_input_tokens || 0
  row.n += 1
  if (acct !== 'unknown') {
    const bucket = (doc.b[Math.floor((await $.clock.now()) / BUCKET_MS)] ||= {})
    const cell = (bucket[acct] ||= { u: 0 })
    const add = {
      i: usage.input_tokens || 0,
      o: usage.output_tokens || 0,
      cr: usage.cache_read_input_tokens || 0,
      cw: usage.cache_creation_input_tokens || 0,
    }
    const usd = rowUsd(model, add)
    cell.u += usd
    if (!priceOf(model)) cell.x = 1
    // Per model too, so a rate-limit window can be split by model (older buckets have u alone).
    const mr = ((cell.m ||= {})[model] ||= { i: 0, o: 0, cr: 0, cw: 0, u: 0 })
    for (const k of ['i', 'o', 'cr', 'cw']) mr[k] += add[k]
    mr.u += usd
    lastTurnAcct = acct
  }
  const out = usage.output_tokens || 0
  if (gen && gen.ms >= MIN_TPS_MS && out >= MIN_TPS_TOKENS && out / (gen.ms / 1000) <= MAX_TPS) {
    row.gms += gen.ms
    row.gtok += usage.output_tokens
    await $.state.set(S_TPS, { value: usage.output_tokens / (gen.ms / 1000), model })
  }
  dataVersion++
  scheduleFlush($)
  $.ui.invalidate('ui.render')
}

// ---- aggregation ------------------------------------------------------------------------

function lastDays(n, now) {
  const out = new Set()
  for (let k = 0; k < n; k++) out.add(dayKey(new Date(now - k * 86400000)))
  return out
}

// range: number of days. acctSel: 'all' or an account hash.
// Recomputed only when the data, the day or the arguments change: a render calls it a few times.
let dataVersion = 0
const aggMemo = new Map()
function aggregate(range, acctSel, now) {
  const key = range + '|' + acctSel + '|' + dayKey(new Date(now)) + '|' + shownAcct() + '|' + dataVersion
  if (!aggMemo.has(key)) {
    if (aggMemo.size > 20) aggMemo.clear()
    aggMemo.set(key, aggregateNow(range, acctSel, now))
  }
  return aggMemo.get(key)
}
function aggregateNow(range, acctSel, now) {
  const days = lastDays(range, now)
  const tot = emptyTotals()
  const byModel = {}
  const byDay = {}
  const accts = new Set()
  for (const s of allDocs()) {
    for (const [day, byAcct] of Object.entries(s.days || {})) {
      for (const [acct, models] of Object.entries(byAcct)) {
        accts.add(acct)
        if (!days.has(day)) continue
        if (acctSel !== 'all' && acct !== acctSel) continue
        for (const [model, r] of Object.entries(models)) {
          const usd = rowUsd(model, r)
          if (!priceOf(model)) tot.unpriced = true
          const m = (byModel[model] ||= emptyTotals())
          for (const t of [tot, m]) {
            t.i += r.i
            t.o += r.o
            t.cr += r.cr
            t.cw += r.cw
            t.n += r.n
            t.gms += r.gms
            t.gtok += r.gtok
            t.usd += usd
          }
          byDay[day] = (byDay[day] || 0) + usd
        }
      }
    }
  }
  // The current account is listed even before it has recorded anything.
  const cur = shownAcct()
  if (cur !== 'unknown') accts.add(cur)
  return { tot, byModel, byDay, accts: [...accts].sort() }
}

function sessionTotals() {
  const t = emptyTotals()
  for (const byAcct of Object.values(doc.days)) {
    for (const models of Object.values(byAcct)) {
      for (const [model, r] of Object.entries(models)) {
        if (!priceOf(model)) t.unpriced = true
        t.i += r.i
        t.o += r.o
        t.cr += r.cr
        t.cw += r.cw
        t.n += r.n
        t.gms += r.gms
        t.gtok += r.gtok
        t.usd += rowUsd(model, r)
      }
    }
  }
  return t
}
// What the band shows as the session's value: the transcript's (see scanLog) plus what this
// session recorded since it was read; this session's own record until it is read, or where the
// transcript is not found.
function sessionShown() {
  const s = sessionTotals()
  if (!logTotals || !logSnap) return s
  const t = { ...logTotals, gms: s.gms, gtok: s.gtok, unpriced: logTotals.unpriced || s.unpriced }
  for (const f of ['i', 'o', 'cr', 'cw', 'n', 'usd']) t[f] += Math.max(0, s[f] - logSnap[f])
  return t
}

// ---- quota estimate ---------------------------------------------------------------------

// ---- account check ----
// A CLI session takes its account from ~/.claude.json, which can name another account than the
// credentials the CLI really uses; its usage and readings then land under the wrong account. The
// seven-day window tells accounts apart: its reset time is the account's own and stays put for a
// week, so one account cannot hold two overlapping weeks. When it does, the week that a session
// with the account from CLAUDE_CODE_ACCOUNT_UUID (src 'env') saw, or else the one no other
// account also holds, is the account's; a session holding the other week is moved to the account
// that week belongs to, or, when none is known, its quota data is left out (its tokens stay).
const weeksOf = (s, a) =>
  [s.rl?.[a]?.seven_day, s.base?.[a]?.seven_day].filter((v) => v && typeof v.r === 'number').map((v) => v.r)
// Two different weeks of one account that overlap: impossible for the same account.
const clash = (r1, r2) => !sameWindow({ r: r1 }, { r: r2 }) && Math.abs(r1 - r2) < WINDOWS.seven_day - 10 * 60000

// Map(doc -> { acct: true account, or null when unknown }) for the docs filed under a wrong one.
function acctFixes(docs) {
  const claims = []
  for (const s of docs) {
    const accts = new Set([...Object.keys(s.rl || {}), ...Object.keys(s.base || {})])
    for (const a of accts) for (const r of weeksOf(s, a)) claims.push({ s, a, r, env: s.src === 'env' })
  }
  const heldByOther = (c) => claims.some((d) => d.a !== c.a && sameWindow(d, c))
  const fixes = new Map()
  for (const c of claims) {
    if (c.env) continue
    const wrong = claims.some((d) => d.a === c.a && clash(c.r, d.r) && (d.env || (heldByOther(c) && !heldByOther(d))))
    if (!wrong) continue
    const owners = claims.filter((d) => d.a !== c.a && sameWindow(d, c)).sort((x, y) => y.env - x.env)
    const fix = (fixes.get(c.s) || {})
    fix[c.a] = owners[0]?.a ?? null
    fixes.set(c.s, fix)
  }
  return fixes
}

// A copy of a doc with each fixed account's entries filed under the true one (or, for an unknown
// one, its tokens kept and its quota data dropped).
function refiled(s, fix) {
  // Tokens of an account whose true one is unknown stay where they are.
  const known = Object.fromEntries(Object.entries(fix).filter(([, to]) => to))
  const move = (byAcct, map, merge) => {
    const out = { ...byAcct }
    for (const [from, to] of Object.entries(map)) {
      if (!(from in out)) continue
      const v = out[from]
      delete out[from]
      if (to) out[to] = to in out ? merge(out[to], v) : v
    }
    return out
  }
  const sumRows = (x, y) => {
    const out = { ...x }
    for (const [m, r] of Object.entries(y)) {
      const t = out[m] || emptyRow()
      out[m] = Object.fromEntries(Object.keys(emptyRow()).map((k) => [k, (t[k] || 0) + (r[k] || 0)]))
    }
    return out
  }
  const sumCell = (x, y) => {
    const out = { u: (x.u || 0) + (y.u || 0), ...(x.x || y.x ? { x: 1 } : {}) }
    if (x.m || y.m) {
      out.m = { ...(x.m || {}) }
      for (const [k, r] of Object.entries(y.m || {})) {
        const t = out.m[k] || { i: 0, o: 0, cr: 0, cw: 0, u: 0 }
        out.m[k] = Object.fromEntries(Object.keys(t).map((f) => [f, (t[f] || 0) + (r[f] || 0)]))
      }
    }
    return out
  }
  const newest = (x, y) => {
    const out = { ...x }
    for (const [k, v] of Object.entries(y)) if (!out[k] || (v?.at || 0) > (out[k].at || 0)) out[k] = v
    return out
  }
  const each = (o, fn) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, fn(v)]))
  return {
    ...s,
    days: each(s.days, (byAcct) => move(byAcct, known, sumRows)),
    b: each(s.b, (byAcct) => move(byAcct, fix, sumCell)),
    rl: move(s.rl || {}, fix, newest),
    base: move(s.base || {}, fix, newest),
    est: move(s.est || {}, fix, newest),
  }
}

// Every session's doc, this one included, with the account fixes applied.
let viewMemo = { v: -1, docs: [], fixes: new Map() }
function allDocs() {
  if (viewMemo.v !== dataVersion) {
    const docs = [...Object.values(others), doc]
    const fixes = acctFixes(docs)
    viewMemo = { v: dataVersion, fixes, docs: docs.map((s) => (fixes.has(s) ? refiled(s, fixes.get(s)) : s)) }
  }
  return viewMemo.docs
}
// The account this session really runs on: curAcct unless the check above moved it.
const shownAcct = () => {
  allDocs()
  const to = viewMemo.fixes.get(doc)?.[curAcct]
  return to === undefined ? curAcct : to || 'unknown'
}

// The value an account recorded in buckets overlapping [start, end], over every session.
function windowUsd(acct, start, end) {
  let usd = 0
  let unpriced = false
  const lo = Math.floor(start / BUCKET_MS)
  const hi = Math.floor(end / BUCKET_MS)
  for (const s of allDocs()) {
    for (const [k, byAcct] of Object.entries(s.b || {})) {
      const n = Number(k)
      const c = byAcct[acct]
      if (!c || n < lo || n > hi) continue
      usd += c.u || 0
      if (c.x) unpriced = true
    }
  }
  return { usd, unpriced }
}
// What an account recorded in buckets overlapping [start, end], by model, most value first; old
// is the value of buckets recorded before buckets were split by model.
function windowModels(acct, start, end) {
  const by = {}
  let old = 0
  const lo = Math.floor(start / BUCKET_MS)
  const hi = Math.floor(end / BUCKET_MS)
  for (const s of allDocs()) {
    for (const [k, byAcct] of Object.entries(s.b || {})) {
      const n = Number(k)
      const c = byAcct[acct]
      if (!c || n < lo || n > hi) continue
      if (!c.m) {
        old += c.u || 0
        continue
      }
      for (const [m, r] of Object.entries(c.m)) {
        const t = (by[m] ||= { i: 0, o: 0, cr: 0, cw: 0, u: 0 })
        for (const f of Object.keys(t)) t[f] += r[f] || 0
      }
    }
  }
  return { models: Object.entries(by).sort((a, b) => b[1].u - a[1].u), old }
}
// The newest of a field's entries for an account and window, over every session.
const newest = (field, acct, kind) =>
  allDocs()
    .map((s) => s[field]?.[acct]?.[kind])
    // An estimate without d (delta) is from before 0.5.1, which could divide the whole window,
    // usage it never saw included, by its fill: those are left out.
    .filter((v) => v && typeof v.at === 'number' && (field !== 'est' || v.d))
    .sort((a, b) => b.at - a.at)[0] || null

// Two readings of the same window: resetsAt may move by a few seconds between responses.
const sameWindow = (a, b) => Math.abs(a.r - b.r) < 10 * 60000
// Every reading any session kept of this window, oldest first.
const readingsOf = (acct, kind, rd) =>
  allDocs()
    .flatMap((s) => [s.base?.[acct]?.[kind], s.rl?.[acct]?.[kind]])
    .filter((v) => v && typeof v.at === 'number' && typeof v.p === 'number' && sameWindow(v, rd))
    .sort((a, b) => a.at - b.at || a.p - b.p)
// When the window was last reset early (a reset card): its fill fell while resetsAt stayed put,
// so the value recorded before it belongs to the old fill. 0 when it never was.
// A reading only a little lower than the highest before it, or one a later reading climbs back
// above, is a late one (held since before a restart, or another session's turn ending a little
// after a fresher reading was saved), stamped with the time it was saved: not a reset.
function resetAt(rds) {
  let at = 0
  let top = -Infinity
  for (let i = 0; i < rds.length; i++) {
    const p = rds[i].p
    const fell = p <= top - MIN_PCT && rds.slice(i + 1).every((v) => v.p < top)
    if (fell) {
      at = rds[i].at
      top = p
    } else top = Math.max(top, p)
  }
  return at
}
// The earliest reading of this window since its last early reset.
const baseline = (acct, kind, rd) => {
  const rds = readingsOf(acct, kind, rd)
  const since = resetAt(rds)
  return rds.find((v) => v.at >= since) || null
}

// A window's size in API-equivalent dollars, from a reading (rd): the value recorded since the
// window's first reading divided by the points the fill rose since. Only that span counts: before
// the first reading the plugin may not have been recording (no session open, or usage elsewhere,
// such as claude.ai, that fills the same window), and the window's start is known only roughly.
// No estimate until the rise is MIN_PCT points, or with nothing recorded.
function estimate(acct, kind, rd) {
  const base = baseline(acct, kind, rd)
  if (!base) return { q: null }
  // The bucket holding the baseline is left out: the response that moved the fill to it is there.
  // Except from an empty window (0%): nothing was spent in it before, so all of that bucket counts.
  const from = (Math.floor(base.at / BUCKET_MS) + (base.p === 0 ? 0 : 1)) * BUCKET_MS
  const pts = rd.p - base.p
  const { usd } = from <= rd.at ? windowUsd(acct, from, rd.at) : { usd: 0 }
  if (pts >= MIN_PCT && usd > 0) return { q: usd / (pts / 100) }
  // How many more points of fill until there is enough to divide by.
  return { q: null, need: pts < MIN_PCT ? Math.round((MIN_PCT - pts) * 10) / 10 : 0 }
}

// Readings belong to the account that made the last response; before any response in this
// session (a reading the engine still holds from startup), to the session's account.
async function saveReadings($, rateLimits) {
  const acct = lastTurnAcct || (await currentAccount($))
  if (acct === 'unknown' || !Array.isArray(rateLimits)) return
  await ensureSession($)
  const now = await $.clock.now()
  let changed = false
  for (const rl of rateLimits) {
    const r = Date.parse(rl?.resetsAt || '')
    if (!WINDOWS[rl?.kind] || !Number.isFinite(r) || typeof rl.percentUsed !== 'number') continue
    const rd = { p: rl.percentUsed, r, at: now }
    const last = doc.rl[acct]?.[rl.kind]
    ;(doc.rl[acct] ||= {})[rl.kind] = rd
    const base = (doc.base[acct] ||= {})
    // A new window, or the same one reset early (its fill fell): start over from this reading.
    // A fall of less than MIN_PCT points is a late reading, not a reset (see resetAt).
    const reset = last && sameWindow(last, rd) && rd.p <= last.p - MIN_PCT
    if (!base[rl.kind] || !sameWindow(base[rl.kind], rd) || reset) base[rl.kind] = rd
    changed = true
  }
  if (!changed) return
  dataVersion++
  // Estimated under the account the readings really belong to (see acctFixes), kept under this
  // session's own label like the rest of its doc.
  allDocs()
  const to = viewMemo.fixes.get(doc)?.[acct]
  const real = to === undefined ? acct : to
  for (const [kind, rd] of real ? Object.entries(doc.rl[acct]) : []) {
    if (rd.at !== now) continue
    const { q } = estimate(real, kind, rd)
    if (q !== null) (doc.est[acct] ||= {})[kind] = { q, r: rd.r, at: now, d: 1 }
  }
  dataVersion++
  scheduleFlush($)
  $.ui.invalidate('ui.render')
}

// Per window: the live reading and its estimate (while the window has not reset), and the last
// estimate made at MIN_PCT or more, which stands in while the fill is too low to divide by.
const quotaMemo = new Map()
function quotaRows(acct, now) {
  const key = acct + '|' + dataVersion + '|' + Math.floor(now / 60000)
  if (quotaMemo.has(key)) return quotaMemo.get(key)
  if (quotaMemo.size > 20) quotaMemo.clear()
  const rows = []
  for (const kind of Object.keys(WINDOWS)) {
    const rd = newest('rl', acct, kind)
    const live = rd && rd.r > now ? rd : null
    const prev = newest('est', acct, kind)
    if (!live && !prev) continue
    rows.push({ kind, live, est: live ? estimate(acct, kind, live) : null, prev })
  }
  quotaMemo.set(key, rows)
  return rows
}
// Accounts with a reading or an estimate, the current one first.
const quotaAccts = () => {
  const set = new Set()
  for (const s of allDocs()) for (const f of ['rl', 'est']) for (const a of Object.keys(s[f] || {})) set.add(a)
  const cur = shownAcct()
  return [...set].sort((a, b) => (b === cur) - (a === cur) || a.localeCompare(b))
}

// Reset time of a window in UTC+8, "HH:mm", with the date ("MM-DD HH:mm") when not today there.
const fmtReset = (r, now) => {
  const t = new Date(r + 8 * 3600000)
  const day = (ms) => Math.floor((ms + 8 * 3600000) / 86400000)
  const p2 = (n) => String(n).padStart(2, '0')
  const hm = p2(t.getUTCHours()) + ':' + p2(t.getUTCMinutes())
  return day(r) === day(now) ? hm : p2(t.getUTCMonth() + 1) + '-' + p2(t.getUTCDate()) + ' ' + hm
}
// Time until a reset, "4天2小时15分钟": days, hours, minutes, leaving out leading zero units.
const fmtLeft = (r, now) => {
  const m = Math.max(0, Math.floor((r - now) / 60000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const t = (d ? d + tr('uD') : '') + (d || h ? h + tr('uH') : '') + (m % 60) + tr('uM')
  return tr('left', { t: t.trim() })
}
// A subscription end date typed as YYYY-MM-DD (UTC+8) lasts to the end of that day.
const parseExp = (v) => {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(String(v).trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0')
}
const expMs = (v) => {
  const [y, mo, d] = v.split('-').map(Number)
  return Date.UTC(y, mo - 1, d + 1) - 8 * 3600000
}
const pctOf = (p) => (Number.isInteger(p) ? p : p.toFixed(1)) + '%'
const fmtDur = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m >= 1440) return Math.floor(m / 1440) + 'd' + Math.floor((m % 1440) / 60) + 'h'
  if (m >= 60) return Math.floor(m / 60) + 'h' + (m % 60) + 'm'
  return m + 'm'
}

const cacheHit = (t) => {
  const denom = t.i + t.cr + t.cw
  return denom > 0 ? t.cr / denom : null
}
const avgTps = (t) => (t.gms > 0 ? t.gtok / (t.gms / 1000) : null)
// A total that leaves out a model with no price is a lower bound: shown as "≥ $x".
const usdOf = (t) => (t.unpriced ? '≥' : '') + fmtUsd(t.usd)

// Display width in cells: CJK, kana, Hangul and full-width forms take two.
const strWidth = (s) => {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return w
}
// ---- i18n -------------------------------------------------------------------------------
// cfg.lang is 'auto' (follow the system language) or one of the codes below.
// To add a language: add an entry here, a name in LANG_NAMES, and a case in detectLang.

const LANG_NAMES = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
  pt: 'Português',
  ru: 'Русский',
}
const LANG_ORDER = Object.keys(LANG_NAMES)

const STR = {
  en: {
    session: 'Session', log: 'Transcript', logCut: 'Truncated', today: 'Today', hit: 'Cache hit', vHide: 'Hide', vBrief: 'Brief', vFull: 'Detailed',
    d1: '1d', d7: '7d', d30: '30d', acct: 'Account', all: 'All', cur: 'current', acctN: 'Account {id}',
    edit: 'Rename', rnPh: 'Type a name, press Enter', save: 'Save',
    nodata: 'No data for the last {n} days yet. It starts counting after your next message.',
    sum: 'Last {n} days · API-equivalent value {usd} · {req} requests',
    total: 'Total', inAll: 'Input (all)', inp: 'Uncached input', out: 'Output (incl. thinking)', cr: 'Cache read', cw: 'Cache write', tps: 'TPS',
    models: 'Share by model (by value)', nopr: 'no price', daily: 'Daily value',
    tpsAvg: 'Average TPS by model',
    exact: 'Exact', kmb: 'K/M/B', refresh: 'Refresh', cmd: 'Expand or collapse the usage window',
    upd: "New version {v}", updHow: "Update: run this in a terminal, then /reload-plugins", updShow: "How to update",
    quota: 'Quota estimate (API-equivalent value)', w5h: '5h', w7d: 'Week', qPred: 'Predicted {w} quota {q}', qNeed: '(after {n} more)', 
    expL: 'Subscription ends', expNone: 'not set', expSet: 'Set date', expPh: 'YYYY-MM-DD, press Enter', expDone: 'expired',
    qRaw: 'Uncached', qCr: 'Cache read', qCw: 'Cache write', qIn: 'Input', qOut: 'Output', qOld: 'Earlier use (not split by model)',
    left: '{t} left', uD: 'd ', uH: 'h ', uM: 'm', qEmpty: 'No rate-limit reading yet (subscription accounts only); it appears after your next message.', tUsage: 'Overview', tQuota: 'Quota', tModels: 'Models', tDaily: 'Daily',
  },
  'zh-CN': {
    session: '当前会话', log: '记录', logCut: '已截断', today: '今日', hit: '缓存命中', vHide: '收起', vBrief: '简略', vFull: '详细',
    d1: '1天', d7: '7天', d30: '30天', acct: '账户', all: '全部', cur: '当前', acctN: '账户 {id}',
    edit: '改名', rnPh: '输入名称后回车', save: '保存',
    nodata: '最近 {n} 天还没有数据，发一条消息后开始统计',
    sum: '最近 {n} 天 · API 等价价值 {usd} · {req} 次请求',
    total: '总计', inAll: '实际输入', inp: '未缓存输入', out: '输出（含思考）', cr: '缓存读', cw: '缓存写', tps: 'TPS',
    models: '各模型占比（按价值）', nopr: '无价格', daily: '每日价值',
    tpsAvg: '各模型平均 TPS',
    exact: '精确值', kmb: 'K/M/B', refresh: '刷新', cmd: '展开或收起用量小窗口',
    upd: "新版本 {v}", updHow: "更新方法：在终端运行下面的命令，然后 /reload-plugins", updShow: "更新方法",
    quota: '额度估算（API 等价价值）', w5h: '5小时', w7d: '每周', qPred: '预测{w}额度 {q}', qNeed: '（再用 {n} 后估算）', 
    expL: '订阅到期', expNone: '未设置', expSet: '设置', expPh: '输入 YYYY-MM-DD 后回车', expDone: '已到期',
    qRaw: '非缓存输入', qCr: '缓存读', qCw: '缓存写', qIn: '总输入', qOut: '输出', qOld: '更早的用量（未分模型）',
    left: '剩{t}', uD: '天', uH: '小时', uM: '分钟', qEmpty: '还没有限额读数（仅订阅账户），发一条消息后出现', tUsage: '概览', tQuota: '额度', tModels: '模型', tDaily: '每日',
  },
  'zh-TW': {
    session: '目前工作階段', log: '記錄', logCut: '已截斷', today: '今日', hit: '快取命中', vHide: '收合', vBrief: '簡略', vFull: '詳細',
    d1: '1天', d7: '7天', d30: '30天', acct: '帳號', all: '全部', cur: '目前', acctN: '帳號 {id}',
    edit: '改名', rnPh: '輸入名稱後按 Enter', save: '儲存',
    nodata: '最近 {n} 天還沒有資料，傳送一則訊息後開始統計',
    sum: '最近 {n} 天 · API 等價價值 {usd} · {req} 次請求',
    total: '總計', inAll: '實際輸入', inp: '未快取輸入', out: '輸出（含思考）', cr: '快取讀取', cw: '快取寫入', tps: 'TPS',
    models: '各模型占比（依價值）', nopr: '無價格', daily: '每日價值',
    tpsAvg: '各模型平均 TPS',
    exact: '精確值', kmb: 'K/M/B', refresh: '重新整理', cmd: '展開或收合用量小視窗',
    upd: "新版本 {v}", updHow: "更新方式：在終端機執行下面的指令，然後 /reload-plugins", updShow: "更新方式",
    quota: '額度估算（API 等價價值）', w5h: '5小時', w7d: '每週', qPred: '預測{w}額度 {q}', qNeed: '（再用 {n} 後估算）', 
    qEmpty: '還沒有限額讀數（僅訂閱帳號），傳送一則訊息後出現', tUsage: '概覽', tQuota: '額度', tModels: '模型', tDaily: '每日',
  },
  ja: {
    session: 'セッション', log: '履歴', logCut: '切り詰め', today: '今日', hit: 'キャッシュ命中', vHide: '隠す', vBrief: '簡易', vFull: '詳細',
    d1: '1日', d7: '7日', d30: '30日', acct: 'アカウント', all: 'すべて', cur: '現在', acctN: 'アカウント {id}',
    edit: '名前変更', rnPh: '名前を入力して Enter', save: '保存',
    nodata: '直近 {n} 日のデータはまだありません。次のメッセージから集計します。',
    sum: '直近 {n} 日 · API 換算額 {usd} · {req} 回のリクエスト',
    total: '合計', inAll: '実質入力', inp: '非キャッシュ入力', out: '出力（思考含む）', cr: 'キャッシュ読取', cw: 'キャッシュ書込', tps: 'TPS',
    models: 'モデル別の割合（金額ベース）', nopr: '価格なし', daily: '日別の金額',
    tpsAvg: 'モデル別の平均 TPS',
    exact: '正確な値', kmb: 'K/M/B', refresh: '更新', cmd: '使用量ウィンドウを開閉',
    upd: "新バージョン {v}", updHow: "更新方法：ターミナルで次のコマンドを実行し、/reload-plugins", updShow: "更新方法",
    quota: '利用枠の推定（API 換算額）', w5h: '5時間', w7d: '週', qPred: '{w}の予測枠 {q}', qNeed: '（あと {n} で推定）', 
    qEmpty: '上限の読み取りはまだありません（サブスクリプションのみ）。次のメッセージ後に表示されます。', tUsage: '概要', tQuota: '利用枠', tModels: 'モデル', tDaily: '日別',
  },
  ko: {
    session: '현재 세션', log: '기록', logCut: '잘림', today: '오늘', hit: '캐시 적중', vHide: '숨기기', vBrief: '간략', vFull: '자세히',
    d1: '1일', d7: '7일', d30: '30일', acct: '계정', all: '전체', cur: '현재', acctN: '계정 {id}',
    edit: '이름 변경', rnPh: '이름 입력 후 Enter', save: '저장',
    nodata: '최근 {n}일 데이터가 아직 없습니다. 다음 메시지부터 집계합니다.',
    sum: '최근 {n}일 · API 환산 가치 {usd} · 요청 {req}회',
    total: '합계', inAll: '실제 입력', inp: '비캐시 입력', out: '출력(사고 포함)', cr: '캐시 읽기', cw: '캐시 쓰기', tps: 'TPS',
    models: '모델별 비중 (가치 기준)', nopr: '가격 없음', daily: '일별 가치',
    tpsAvg: '모델별 평균 TPS',
    exact: '정확한 값', kmb: 'K/M/B', refresh: '새로고침', cmd: '사용량 창 열기/닫기',
    upd: "새 버전 {v}", updHow: "업데이트: 터미널에서 아래 명령을 실행한 뒤 /reload-plugins", updShow: "업데이트 방법",
    quota: '한도 추정 (API 환산 가치)', w5h: '5시간', w7d: '주간', qPred: '{w} 예상 한도 {q}', qNeed: '({n} 더 사용 후 추정)', 
    qEmpty: '아직 한도 정보가 없습니다(구독 계정만). 다음 메시지 후 표시됩니다.', tUsage: '개요', tQuota: '한도', tModels: '모델', tDaily: '일별',
  },
  es: {
    session: 'Sesión', log: 'Historial', logCut: 'Truncado', today: 'Hoy', hit: 'Acierto de caché', vHide: 'Ocultar', vBrief: 'Breve', vFull: 'Detalles',
    d1: '1 d', d7: '7 d', d30: '30 d', acct: 'Cuenta', all: 'Todas', cur: 'actual', acctN: 'Cuenta {id}',
    edit: 'Renombrar', rnPh: 'Escribe un nombre y pulsa Enter', save: 'Guardar',
    nodata: 'Aún no hay datos de los últimos {n} días. Empieza a contar con tu próximo mensaje.',
    sum: 'Últimos {n} días · valor equivalente en API {usd} · {req} solicitudes',
    total: 'Total', inAll: 'Entrada total', inp: 'Entrada sin caché', out: 'Salida (con razonamiento)', cr: 'Lectura de caché', cw: 'Escritura de caché', tps: 'TPS',
    models: 'Reparto por modelo (por valor)', nopr: 'sin precio', daily: 'Valor diario',
    tpsAvg: 'TPS medio por modelo',
    exact: 'Exacto', kmb: 'K/M/B', refresh: 'Actualizar', cmd: 'Mostrar u ocultar la ventana de uso',
    upd: "Nueva versión {v}", updHow: "Para actualizar: ejecuta esto en una terminal y luego /reload-plugins", updShow: "Cómo actualizar",
    quota: 'Cuota estimada (valor equivalente en API)', w5h: '5 h', w7d: 'Semana', qPred: 'Cuota prevista ({w}) {q}', qNeed: '(tras {n} más)', 
    qEmpty: 'Aún no hay lectura de límites (solo cuentas de suscripción); aparece tras tu próximo mensaje.', tUsage: 'Resumen', tQuota: 'Cuota', tModels: 'Modelos', tDaily: 'Diario',
  },
  de: {
    session: 'Sitzung', log: 'Verlauf', logCut: 'Gekürzt', today: 'Heute', hit: 'Cache-Treffer', vHide: 'Ausblenden', vBrief: 'Kurz', vFull: 'Details',
    d1: '1 T', d7: '7 T', d30: '30 T', acct: 'Konto', all: 'Alle', cur: 'aktuell', acctN: 'Konto {id}',
    edit: 'Umbenennen', rnPh: 'Namen eingeben, Enter drücken', save: 'Speichern',
    nodata: 'Noch keine Daten für die letzten {n} Tage. Die Zählung beginnt mit der nächsten Nachricht.',
    sum: 'Letzte {n} Tage · API-Gegenwert {usd} · {req} Anfragen',
    total: 'Gesamt', inAll: 'Eingabe gesamt', inp: 'Eingabe ohne Cache', out: 'Ausgabe (inkl. Denken)', cr: 'Cache gelesen', cw: 'Cache geschrieben', tps: 'TPS',
    models: 'Anteil je Modell (nach Wert)', nopr: 'kein Preis', daily: 'Tageswert',
    tpsAvg: 'Durchschnittliche TPS je Modell',
    exact: 'Exakt', kmb: 'K/M/B', refresh: 'Aktualisieren', cmd: 'Nutzungsfenster ein- oder ausklappen',
    upd: "Neue Version {v}", updHow: "Aktualisieren: dies in einem Terminal ausführen, dann /reload-plugins", updShow: "So aktualisieren",
    quota: 'Kontingent geschätzt (API-Gegenwert)', w5h: '5 Std', w7d: 'Woche', qPred: 'Prognose {w}-Kontingent {q}', qNeed: '(nach weiteren {n})', 
    qEmpty: 'Noch kein Limit-Wert (nur Abo-Konten); erscheint nach der nächsten Nachricht.', tUsage: 'Übersicht', tQuota: 'Kontingent', tModels: 'Modelle', tDaily: 'Täglich',
  },
  fr: {
    session: 'Session', log: 'Historique', logCut: 'Tronqué', today: "Aujourd'hui", hit: 'Succès du cache', vHide: 'Masquer', vBrief: 'Bref', vFull: 'Détails',
    d1: '1 j', d7: '7 j', d30: '30 j', acct: 'Compte', all: 'Tous', cur: 'actuel', acctN: 'Compte {id}',
    edit: 'Renommer', rnPh: 'Saisissez un nom, puis Entrée', save: 'Enregistrer',
    nodata: "Pas encore de données sur les {n} derniers jours. Le suivi commence au prochain message.",
    sum: '{n} derniers jours · valeur équivalente API {usd} · {req} requêtes',
    total: 'Total', inAll: 'Entrée totale', inp: 'Entrée hors cache', out: 'Sortie (réflexion incl.)', cr: 'Lecture du cache', cw: 'Écriture du cache', tps: 'TPS',
    models: 'Répartition par modèle (en valeur)', nopr: 'sans prix', daily: 'Valeur par jour',
    tpsAvg: 'TPS moyen par modèle',
    exact: 'Exact', kmb: 'K/M/B', refresh: 'Actualiser', cmd: "Afficher ou masquer la fenêtre d'utilisation",
    upd: "Nouvelle version {v}", updHow: "Mise à jour : lancez ceci dans un terminal, puis /reload-plugins", updShow: "Comment mettre à jour",
    quota: 'Quota estimé (valeur équivalente API)', w5h: '5 h', w7d: 'Semaine', qPred: 'Quota prévu ({w}) {q}', qNeed: '(après {n} de plus)', 
    qEmpty: 'Pas encore de relevé des limites (comptes abonnés seulement) ; il apparaît après le prochain message.', tUsage: 'Aperçu', tQuota: 'Quota', tModels: 'Modèles', tDaily: 'Par jour',
  },
  pt: {
    session: 'Sessão', log: 'Histórico', logCut: 'Truncado', today: 'Hoje', hit: 'Acerto de cache', vHide: 'Ocultar', vBrief: 'Breve', vFull: 'Detalhes',
    d1: '1 d', d7: '7 d', d30: '30 d', acct: 'Conta', all: 'Todas', cur: 'atual', acctN: 'Conta {id}',
    edit: 'Renomear', rnPh: 'Digite um nome e pressione Enter', save: 'Salvar',
    nodata: 'Ainda não há dados dos últimos {n} dias. A contagem começa na próxima mensagem.',
    sum: 'Últimos {n} dias · valor equivalente na API {usd} · {req} solicitações',
    total: 'Total', inAll: 'Entrada total', inp: 'Entrada sem cache', out: 'Saída (inclui raciocínio)', cr: 'Leitura de cache', cw: 'Gravação de cache', tps: 'TPS',
    models: 'Participação por modelo (por valor)', nopr: 'sem preço', daily: 'Valor diário',
    tpsAvg: 'TPS médio por modelo',
    exact: 'Exato', kmb: 'K/M/B', refresh: 'Atualizar', cmd: 'Expandir ou recolher a janela de uso',
    upd: "Nova versão {v}", updHow: "Para atualizar: execute isto num terminal e depois /reload-plugins", updShow: "Como atualizar",
    quota: 'Cota estimada (valor equivalente na API)', w5h: '5 h', w7d: 'Semana', qPred: 'Cota prevista ({w}) {q}', qNeed: '(após mais {n})', 
    qEmpty: 'Ainda não há leitura de limites (só contas de assinatura); aparece após a próxima mensagem.', tUsage: 'Resumo', tQuota: 'Cota', tModels: 'Modelos', tDaily: 'Diário',
  },
  ru: {
    session: 'Сессия', log: 'История', logCut: 'Обрезан', today: 'Сегодня', hit: 'Попадания в кэш', vHide: 'Скрыть', vBrief: 'Кратко', vFull: 'Подробно',
    d1: '1 д', d7: '7 д', d30: '30 д', acct: 'Аккаунт', all: 'Все', cur: 'текущий', acctN: 'Аккаунт {id}',
    edit: 'Переименовать', rnPh: 'Введите имя и нажмите Enter', save: 'Сохранить',
    nodata: 'Данных за последние {n} дн. пока нет. Подсчёт начнётся со следующего сообщения.',
    sum: 'Последние {n} дн. · эквивалент по API {usd} · запросов: {req}',
    total: 'Всего', inAll: 'Ввод всего', inp: 'Ввод без кэша', out: 'Вывод (с рассуждениями)', cr: 'Чтение кэша', cw: 'Запись кэша', tps: 'TPS',
    models: 'Доля по моделям (по стоимости)', nopr: 'нет цены', daily: 'Стоимость по дням',
    tpsAvg: 'Средний TPS по моделям',
    exact: 'Точно', kmb: 'K/M/B', refresh: 'Обновить', cmd: 'Показать или скрыть окно использования',
    upd: "Новая версия {v}", updHow: "Обновление: выполните это в терминале, затем /reload-plugins", updShow: "Как обновить",
    quota: 'Оценка лимита (эквивалент по API)', w5h: '5 ч', w7d: 'Неделя', qPred: 'Прогноз лимита ({w}) {q}', qNeed: '(ещё {n})', 
    qEmpty: 'Данных о лимитах пока нет (только для подписки); появятся после следующего сообщения.', tUsage: 'Обзор', tQuota: 'Лимит', tModels: 'Модели', tDaily: 'По дням',
  },
}

let autoLang = 'en'
const activeLang = () => (cfg.lang !== 'auto' && STR[cfg.lang] ? cfg.lang : autoLang)
const tr = (key, vars) => {
  const s = (STR[activeLang()] || STR.en)[key] ?? STR.en[key] ?? key
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : '')) : s
}

// System language: the JS runtime's locale first, then the usual environment variables.
async function detectLang($) {
  let loc = ''
  try {
    loc = Intl.DateTimeFormat().resolvedOptions().locale || ''
  } catch {}
  if (!loc) loc = (await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || ''
  loc = loc.toLowerCase().replace('_', '-')
  if (loc.startsWith('zh')) return /tw|hk|mo|hant/.test(loc) ? 'zh-TW' : 'zh-CN'
  const base = loc.slice(0, 2)
  return STR[base] ? base : 'en'
}

// An account's name: the one given by renaming, else its masked e-mail, else "Account xxxx".
const acctName = (a) => cfg.names[a] || (cfg.hints || {})[a] || tr('acctN', { id: a.slice(0, 4) })
const acctLabel = (a) => acctName(a) + (a === shownAcct() ? ' (' + tr('cur') + ')' : '')

// The band's three views: 'hidden' (nothing above the prompt), 'brief' (the status line) and
// 'full' (the status line and the detail card). The switch between them is in the prompt footer.
const VIEWS = [
  ['hidden', 'vHide'],
  ['brief', 'vBrief'],
  ['full', 'vFull'],
]
// The view is shared by every session (cfg), so a change shows in all of them.
const curView = () => (VIEWS.some(([v]) => v === cfg.view) ? cfg.view : 'brief')
const setView = async ($, view) => {
  await updateCfg($, (c) => ({ ...c, view }))
  await $.state.set(S_EDITING, false)
  await $.state.set(S_EXPING, null)
}
// /meter: open the card, or back to the status line when it is open.
const toggleView = async ($) => setView($, curView() === 'full' ? 'brief' : 'full')

// ---- module -----------------------------------------------------------------------------

export function register(on) {
  on('session.start', async ($, e, next) => {
    // Each step on its own: one that fails must not keep the others' data or the timers from
    // loading, or the band would count this session alone until the next reload.
    const step = async (fn) => {
      try {
        await fn()
      } catch {}
    }
    await step(() => migrateStore($))
    await step(async () => {
      const saved = await $.store.get('cfg')
      cfg = normCfg(saved && typeof saved === 'object' ? saved : null)
    })
    await step(async () => (autoLang = await detectLang($)))
    await step(() => ensureSession($))
    await step(() => currentAccount($))
    await step(() => learnHints($))
    await step(() => refreshOthers($, true))
    // Readings the engine already holds (after a reload); later ones come with session.measure.
    await step(async () => saveReadings($, (await $.session.usage()).rateLimits))
    await step(() => refreshLog($, { defer: true }))
    await step(() => {
      checkUpdate($).catch(() => {})
      $.clock.every(3600000, () => checkUpdate($).catch(() => {}))
      $.clock.every(15000, () => refreshOthers($).catch(() => {}))
      $.clock.every(15000, () => refreshLog($).catch(() => {}))
      // Another session's change to the shared settings (the view, a rename) shows within seconds.
      $.clock.every(3000, () => syncCfg($).catch(() => {}))
    })
    try {
      await $.command.register({ name: 'meter', description: tr('cmd'), immediate: true })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'meter' }, async ($) => {
    await toggleView($)
    return {}
  })

  // /clear, /resume and /branch change the session id: start from that session's own doc.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      // Write what the previous session recorded since the last flush before switching away.
      await flush($)
      sid = null
      await ensureSession($)
      // The session just left is now one of the others: read it at once so its usage stays counted.
      await refreshOthers($)
      await refreshLog($)
    } catch {}
    return next(e)
  })

  // A rate-limit window moved a whole point (or appeared): keep the reading for the estimate.
  on('session.measure', async ($, e, next) => {
    try {
      if (e.changed.includes('rateLimits')) await saveReadings($, e.rateLimits)
    } catch {}
    // After each turn: the transcript has grown.
    try {
      await refreshLog($)
    } catch {}
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let first = 0
    let stopAt = 0
    let stopUsage = null
    const stream = next(e)
    for await (const c of stream) {
      try {
        // Timing starts at the response's first chunk of any kind (the engine's envelope included),
        // not its first text: thinking that is not streamed as text would otherwise drop out of
        // the time while its tokens stay in output_tokens, and the speed would come out tenfold.
        if (!first && c.kind !== 'stop') {
          first = await $.clock.now()
        } else if (c.kind === 'stop') {
          stopAt = await $.clock.now()
          stopUsage = c.usage
        }
      } catch {}
      yield c
    }
    const result = await stream.result
    try {
      const usage = stopUsage || result.usage
      if (usage) {
        const gen = first && stopAt ? { ms: stopAt - first } : null
        const model = modelKey(usage.model || e.model, usage)
        await record($, model, usage, gen)
      }
    } catch {}
    return result
  })

  on('session.end', async ($, e, next) => {
    try {
      await flush($)
    } catch {}
    return next(e)
  })

  // ---- the small window above the prompt ------------------------------------------------
  // Hidden: nothing here, a small entry in the prompt footer instead (SessionMode, below). Brief:
  // one status line. Full: the same strip grows into a card with the detail view. Nothing is
  // drawn in a side pane. Everything is sized to bodyColumns.

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Select, Code } = els
    const cols = e.props.bodyColumns || e.viewport?.columns || 100
    const view = curView()
    if (view === 'hidden') return next(e)
    const expanded = view === 'full'
    const editingName = (await $.state.get(S_EDITING)).value ?? false
    const editingExp = (await $.state.get(S_EXPING)).value ?? null
    const tab = (await $.state.get(S_TAB)).value ?? 'usage'
    const qOpen = (await $.state.get(S_QOPEN)).value ?? []
    const tps = (await $.state.get(S_TPS)).value ?? null
    const now = await $.clock.now()
    const s = sessionShown()
    const cur = shownAcct()
    const dayAgg = aggregate(1, cur === 'unknown' ? 'all' : cur, now)
    const day = dayAgg.tot
    const hit = cacheHit(s)
    const multi = dayAgg.accts.length > 1

    // The status text at three widths; the widest that fits beside the toggle is shown.
    const hitText = hit === null ? '—' : fmtPct(hit)
    const tpsText = tps ? tps.value.toFixed(1) + ' tok/s' : '— tok/s'
    const todayLabel = tr('today') + (multi ? ' (' + acctName(cur) + ')' : '')
    // The current account's rate-limit fill, "5h 6% · Week 91%", while a window is live.
    const fills = cur === 'unknown' ? [] : quotaRows(cur, now).filter((q) => q.live)
    const fillWide = fills.map((q) => tr(q.kind === 'five_hour' ? 'w5h' : 'w7d') + ' ' + pctOf(q.live.p))
    const fillReset = fills.map(
      (q) => tr(q.kind === 'five_hour' ? 'w5h' : 'w7d') + ' ' + pctOf(q.live.p) + ' → ' + fmtReset(q.live.r, now) + ' (UTC+8)',
    )
    const fillShort = fills.length ? [fills.map((q) => pctOf(q.live.p)).join('/')] : []
    const full = [
      '⚡ ' + (tps ? shortModel(tps.model) + ' ' : '') + tpsText,
      tr('session') + ' ' + usdOf(s),
      todayLabel + ' ' + usdOf(day),
      tr('hit') + ' ' + hitText,
    ]
    const mid = ['⚡ ' + tpsText, tr('session') + ' ' + usdOf(s), tr('today') + ' ' + usdOf(day), tr('hit') + ' ' + hitText]
    const compact = ['⚡' + (tps ? tps.value.toFixed(0) : '—'), usdOf(s) + '/' + usdOf(day), hitText]
    // The transcript's size, after the session's value (on the desktop, out of the size up to
    // which it shows a transcript whole); from LOG_WARN a colored mark of its own instead, which
    // no width drops.
    const log = logText(e.surface)
    const logMark = logWarns(e.surface) ? '⚠ ' + log : null
    // A transcript that starts at a compaction: the conversation before it is in another file.
    const cutMark = isLogCut() ? '✂ ' + tr('logCut') : null
    // Kept at every width but the last: how much of the conversation the app still shows hangs on
    // it. Below LOG_WARN it sits in the line, after the session's value; the compact form has the
    // size alone.
    const inLine = log && !logMark ? log : null
    const withLog = (p, text = inLine) => (text ? [p[0], p[1], text, ...p.slice(2)] : p)
    const logShort = inLine ? fmtMB(logBytes) + 'MB' : null
    // The session's tokens so far, right after its value: input (cache read and write included)
    // and output, from the same responses as the value.
    const tokAll = s.i + s.cr + s.cw + s.o
    const withTok = (p) => (tokAll > 0 ? [p[0], p[1], fmtTok(tokAll) + ' tok', ...p.slice(2)] : p)
    const both = (p, text) => withTok(withLog(p, text))
    // The labelled line with the speed as short as in the compact form.
    const tight = [compact[0], ...mid.slice(1, 3)]
    // Narrower and narrower: the model name, the cache hit, the fills' labels, the size's label,
    // the speed's, then the session's tokens, go before the labels of the values; the cryptic
    // compact form is the last resort.
    const variants = [
      [...both(full), ...fillReset],
      [...both(full), ...fillWide],
      [...both(mid), ...fillWide],
      [...both(mid.slice(0, 3)), ...fillWide],
      [...both(mid.slice(0, 3)), ...fillShort],
      [...both(mid.slice(0, 3), logShort), ...fillShort],
      [...both(tight, logShort), ...fillShort],
      [...withLog(tight, logShort), ...fillShort],
      [...withLog(compact, logShort), ...fillShort],
      withLog(compact, logShort),
      compact,
    ].map((p) => p.join(' · '))
    const badge =
      (latest ? strWidth('⬆ ' + tr('upd', { v: 'v' + latest })) + 2 + (expanded ? 0 : strWidth(tr('updShow')) + 2) : 0) +
      (logMark ? strWidth(logMark) + 2 : 0) +
      (cutMark ? strWidth(cutMark) + 2 : 0)
    const langW = expanded ? strWidth(cfg.lang === 'auto' ? 'Auto · ' + LANG_NAMES[autoLang] : LANG_NAMES[cfg.lang] || '') + 8 : 0
    // The view switch is in the prompt footer (SessionMode), not here.
    const room = cols - badge - langW
    const status = variants.find((v) => strWidth(v) <= room) || variants[variants.length - 1]

    const left = Box({
      key: 'usage-left',
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Text({ dimColor: true, wrap: 'truncate-end', children: [status] }),
        ...(logMark ? [Text({ color: logColor(), children: [logMark] })] : []),
        ...(cutMark ? [Text({ color: 'yellow', children: [cutMark] })] : []),
        ...(latest ? [Text({ color: 'yellow', children: ['⬆ ' + tr('upd', { v: 'v' + latest })] })] : []),
        // Opens the card, where the update command is.
        ...(latest && !expanded
          ? [Button({ key: 'upd', label: tr('updShow'), plain: true, onPress: () => setView($, 'full') })]
          : []),
      ],
    })

    // At the right end of the top line: the language picker while the card is open.
    const langOptions = [
      { value: 'auto', label: 'Auto · ' + LANG_NAMES[autoLang] },
      ...LANG_ORDER.map((code) => ({ value: code, label: LANG_NAMES[code] })),
    ]
    const right = Box({
      key: 'usage-right',
      flexDirection: 'row',
      columnGap: 2,
      children: [
        ...(expanded
          ? [
              Select({
                key: 'lang',
                label: '🌐',
                options: langOptions,
                value: cfg.lang,
                onSelect: (v) => updateCfg($, (c) => ({ ...c, lang: v })),
              }),
            ]
          : []),
      ],
    })
    const line = Box({
      key: 'usage-line',
      flexDirection: 'row',
      justifyContent: 'space-between',
      columnGap: 2,
      children: [left, right],
    })

    const children = [line]
    if (expanded && latest) {
      // Shown, never run: the person copies it into their own terminal.
      children.push(Text({ color: 'yellow', children: [tr('updHow')] }))
      children.push(Code({ source: updateCommand($), language: 'sh' }))
    }
    if (expanded) children.push(detailView($, els, now, cols, editingName, tab, editingExp, qOpen))
    const rest = await next(e)
    if (rest) children.push(rest)
    return children.length === 1 ? line : Box({ flexDirection: 'column', children })
  })

  // The prompt footer, at the left of its mode labels, in every view: speed, session value and the
  // update mark, then the view switch, one button that shows the current view and goes to the next
  // (hidden, brief, full) when pressed.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = curView()
    const tps = (await $.state.get(S_TPS)).value ?? null
    const label = '⚡' + (tps ? tps.value.toFixed(0) : '—') + ' · ' + usdOf(sessionShown()) + (latest ? ' ⬆' : '')
    // The transcript's size, colored from LOG_WARN on the desktop; ✂ when it was cut.
    const size = logBytes === null ? null : fmtMB(logBytes) + 'MB' + (isLogCut() ? ' ✂' : '')
    const at = VIEWS.findIndex(([v]) => v === view)
    const entry = Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Text({ dimColor: true, children: [label] }),
        ...(size ? [Text(logWarns(e.surface) ? { color: logColor(), children: [size] } : { dimColor: true, children: [size] })] : []),
        Button({
          key: 'view-cycle',
          label: '[' + tr(VIEWS[at][1]) + ']',
          plain: true,
          onPress: () => setView($, VIEWS[(at + 1) % VIEWS.length][0]),
        }),
      ],
    })
    const rest = await next(e)
    return rest ? Box({ flexDirection: 'row', columnGap: 2, children: [entry, rest] }) : entry
  })
}

// The expanded card: a row of tabs, then range and account, then one tab's content: totals,
// quota estimate, per-model share and TPS, or per-day value. One tab at a time keeps the card
// within the band's rows (a taller tree scrolls inside the band).
// cols is the band's width; the card's inside is 4 cells narrower (border and padding).
function detailView($, { Box, Text, Button, Input, Select }, now, cols, editingName, tab, editingExp, qOpen) {
  const inner = Math.max(30, cols - 4)
  const wide = inner >= 66
  const range = Number(cfg.range)
  // A saved account that no longer has any data falls back to "all".
  const probe = aggregate(range, cfg.acct, now)
  const acctSel = cfg.acct === 'all' || probe.accts.includes(cfg.acct) ? cfg.acct : 'all'
  const agg = acctSel === cfg.acct ? probe : aggregate(range, 'all', now)
  const t = agg.tot
  const tok = (n) => (cfg.exact ? fmtExact(n) : fmtTok(n))

  const cell = (width, text, opts = {}) =>
    Box({ width, children: [Text({ ...opts, wrap: 'truncate-end', children: [String(text)] })] })
  // Numbers are right-aligned so their digits line up down a column.
  const num = (width, text) => Box({ width, justifyContent: 'flex-end', children: [Text({ children: [String(text)] })] })
  const row = (children) => Box({ flexDirection: 'row', columnGap: 1, children })
  // Drawn as two boxes, not █/░ glyphs: the desktop draws those wider than one cell, so a
  // glyph bar overran its column and covered the value beside it.
  const bar = (width, frac) => {
    const n = Math.max(0, Math.min(width, Math.round(frac * width)))
    return Box({
      width,
      height: 1,
      overflow: 'hidden',
      backgroundColor: 'gray',
      children: n > 0 ? [Box({ width: n, height: 1, backgroundColor: 'cyan', children: [Text({ children: [' '] })] })] : [],
    })
  }
  const setCfg = (patch) => updateCfg($, (c) => ({ ...c, ...patch }))
  const rangeBtn = (value, label, hotkey) =>
    Button({ key: 'range-' + value, label, hotkey, plain: true, dimColor: cfg.range !== value, onPress: () => setCfg({ range: value }) })

  const TABS = [
    ['usage', 'tUsage'],
    ['quota', 'tQuota'],
    ['models', 'tModels'],
    ['daily', 'tDaily'],
  ]
  const tabs = Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 2,
    children: TABS.map(([id, label]) =>
      Button({
        key: 'tab-' + id,
        label: (tab === id ? '▸ ' : '  ') + tr(label),
        plain: true,
        dimColor: tab !== id,
        onPress: async () => {
          await $.state.set(S_EDITING, false)
          await $.state.set(S_TAB, id)
        },
      }),
    ),
  })
  // The quota windows are the engine's own, so the day range does not apply to that tab.
  const headerItems = [
    ...(tab === 'quota' ? [] : [rangeBtn('1', tr('d1'), '1'), rangeBtn('7', tr('d7'), '2'), rangeBtn('30', tr('d30'), '3')]),
    Select({
      key: 'acct',
      label: tr('acct'),
      options: [{ value: 'all', label: tr('all') }, ...agg.accts.map((a) => ({ value: a, label: acctLabel(a) }))],
      value: acctSel,
      onSelect: async (v) => {
        await $.state.set(S_EDITING, false)
        return setCfg({ acct: v })
      },
    }),
  ]
  // Renaming: a pencil button opens the field; saving writes the name and closes it again.
  if (acctSel !== 'all' && !editingName) {
    headerItems.push(
      Button({ key: 'edit-name', label: '✎ ' + tr('edit'), plain: true, onPress: () => $.state.set(S_EDITING, true) }),
    )
  }
  headerItems.push(
    Button({ key: 'unit', label: cfg.exact ? tr('exact') : tr('kmb'), plain: true, onPress: () => setCfg({ exact: !cfg.exact }) }),
    Button({ key: 'refresh', label: tr('refresh'), plain: true, onPress: () => refreshOthers($, true) }),
  )
  const header = Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: headerItems })

  const rename =
    acctSel !== 'all' && editingName
      ? [
          Input({
            key: 'rename',
            label: tr('edit'),
            placeholder: (cfg.hints || {})[acctSel] || tr('rnPh'),
            value: cfg.names[acctSel] || '',
            submitLabel: tr('save'),
            autoFocus: true,
            onSubmit: async (v) => {
              await $.state.set(S_EDITING, false)
              return updateCfg($, (c) => {
                if (v.trim()) c.names[acctSel] = v.trim()
                else delete c.names[acctSel]
                return c
              })
            },
          }),
        ]
      : []

  const card = (children) => Box({ flexDirection: 'column', borderStyle: 'round', paddingX: 1, children })

  // Quota estimate, per account with a reading: the selected one, or all of them under "all".
  // A row: predicted quota, fill, bar. While the fill is too low to divide by (or the
  // window has reset) the last estimate stands in; with none at all the value is "—".
  // The subscription end date, if set, sits in the quota title between the account and "UTC+8".
  const expTitle = (a) => {
    const v = cfg.exp[a]
    if (!v) return ''
    const end = expMs(v)
    return ' · ' + tr('expL') + ' ' + v + ' ' + (end > now ? fmtLeft(end, now) : tr('expDone'))
  }
  const quota = []
  const qAccts = quotaAccts().filter((a) => acctSel === 'all' || a === acctSel)
  for (const a of qAccts) {
    const rows = quotaRows(a, now)
    if (!rows.length) continue
    quota.push(
      Box({
        key: 'qt-' + a,
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Text({ bold: true, children: [tr('quota') + (qAccts.length > 1 || acctSel === 'all' ? ' · ' + acctName(a) : '') + expTitle(a) + ' · UTC+8'] }),
          Button({ key: 'exp-edit-' + a, label: '✎ ' + tr('expSet'), plain: true, onPress: () => $.state.set(S_EXPING, a) }),
        ],
      }),
    )
    // Subscription end date, typed by hand (the engine does not report it). The field opens right
    // under its account's title: at the foot of a card taller than the band it was out of sight.
    if (editingExp === a) {
      quota.push(
        Input({
          key: 'exp-' + a,
          label: tr('expL'),
          placeholder: tr('expPh'),
          value: cfg.exp[a] || '',
          submitLabel: tr('save'),
          autoFocus: true,
          onSubmit: async (val) => {
            await $.state.set(S_EXPING, null)
            const ok = parseExp(val)
            if (!ok && val.trim()) return
            return updateCfg($, (c) => {
              if (ok) c.exp[a] = ok
              else delete c.exp[a]
              return c
            })
          },
        }),
      )
    }
    for (const { kind, live, est, prev } of rows) {
      const w = tr(kind === 'five_hour' ? 'w5h' : 'w7d')
      const q = est?.q ?? prev?.q ?? null
      const need = q === null && est?.need ? ' ' + tr('qNeed', { n: pctOf(est.need) }) : ''
      const barW = Math.max(6, Math.min(20, Math.floor(inner / 5)))
      // The fold toggle after the bar: 2 cells and a gap.
      const resetW = Math.max(14, Math.min(34, inner - 6 - barW - 10 - 3 - 3))
      const text = tr('qPred', { w, q: q === null ? '—' : fmtUsd(q) }) + need
      // The live window's use by model, folded under its row until its toggle opens it.
      const { models, old } = live ? windowModels(a, live.r - WINDOWS[kind], now) : { models: [], old: 0 }
      const openKey = a + '|' + kind
      const hasUse = models.length > 0 || old > 0
      const isOpen = hasUse && qOpen.includes(openKey)
      const toggle = hasUse
        ? Box({
            width: 2,
            children: [
              Button({
                key: 'q-open-' + a + '-' + kind,
                label: isOpen ? '▾' : '▸',
                plain: true,
                onPress: () => $.state.set(S_QOPEN, isOpen ? qOpen.filter((k) => k !== openKey) : [...qOpen, openKey]),
              }),
            ],
          })
        : cell(2, '')
      quota.push(
        row([
          cell(Math.max(10, Math.min(28, inner - 6 - barW - resetW - 3 - 3)), text),
          num(6, live ? pctOf(live.p) : '—'),
          bar(barW, live ? Math.min(1, live.p / 100) : 0),
          toggle,
          cell(resetW, live ? '→ ' + fmtReset(live.r, now) + ' · ' + fmtLeft(live.r, now) : '', { dimColor: true }),
        ]),
      )
      // Opened: input (all), output and value by model, then the window's total.
      if (isOpen) {
        // Name, the three parts of the input (uncached, cache read, cache write), their sum,
        // output, value;
        // each token column as wide as its label and the longest number the format gives.
        const colW = (k) => strWidth(tr(k)) + 1 + (cfg.exact ? 13 : 7)
        const [rawW, cacheW, cwW, inW, outW] = ['qRaw', 'qCr', 'qCw', 'qIn', 'qOut'].map(colW)
        const nameW = Math.max(12, Math.min(22, inner - 2 - rawW - cacheW - cwW - inW - outW - 9 - 7))
        const tokCells = (r, opts) => [
          cell(rawW, tr('qRaw') + ' ' + tok(r.i), opts),
          cell(cacheW, tr('qCr') + ' ' + tok(r.cr), opts),
          cell(cwW, tr('qCw') + ' ' + tok(r.cw), opts),
          cell(inW, tr('qIn') + ' ' + tok(r.i + r.cr + r.cw), opts),
          cell(outW, tr('qOut') + ' ' + tok(r.o), opts),
        ]
        for (const [m, r] of models) {
          quota.push(
            row([
              cell(2, ''),
              cell(nameW, shortModel(m) + (priceOf(m) ? '' : ' ⚠'), { dimColor: true }),
              ...tokCells(r, { dimColor: true }),
              num(9, fmtUsd(r.u)),
            ]),
          )
        }
        if (old > 0) quota.push(row([cell(2, ''), cell(nameW + rawW + cacheW + cwW + inW + outW + 5, tr('qOld'), { dimColor: true }), num(9, fmtUsd(old))]))
        // The window's total: the tokens of the split use, the value of all of it.
        const sum = (f) => models.reduce((n, [, r]) => n + r[f], 0)
        const all = { i: sum('i'), cr: sum('cr'), cw: sum('cw'), o: sum('o') }
        quota.push(
          row([
            cell(2, ''),
            cell(nameW, tr('total'), { bold: true }),
            ...tokCells(all, { bold: true }),
            Box({ width: 9, justifyContent: 'flex-end', children: [Text({ bold: true, children: [fmtUsd(sum('u') + old)] })] }),
          ]),
        )
      }
    }
  }
  if (!quota.length) quota.push(Text({ dimColor: true, wrap: 'wrap', children: [tr('qEmpty')] }))

  const top = [tabs, header, ...rename]
  if (tab === 'quota') return card([...top, ...quota])
  // Nothing recorded yet: say so in one line instead of drawing empty tables.
  if (t.n === 0) return card([...top, Text({ dimColor: true, children: [tr('nodata', { n: range })] })])

  // Totals: three columns when there is room, two otherwise.
  // The API splits a request's input three ways: cache read, cache write and the rest after
  // the last cache breakpoint (usually a few tokens). "Input (all)" is their sum, what the
  // model actually read; output tokens include thinking.
  const hit = cacheHit(t)
  const inAll = t.i + t.cr + t.cw
  const stats = [
    [tr('inAll'), tok(inAll)],
    [tr('out'), tok(t.o)],
    [tr('hit'), hit === null ? '—' : fmtPct(hit)],
    [tr('cr'), tok(t.cr)],
    [tr('cw'), tok(t.cw)],
    [tr('inp'), tok(t.i)],
  ]
  const perRow = inner >= 90 ? 3 : 2
  const statW = Math.floor((inner - (perRow - 1)) / perRow)
  const statRows = []
  for (let k = 0; k < stats.length; k += perRow) {
    statRows.push(row(stats.slice(k, k + perRow).map(([label, v]) => cell(statW, label + ' ' + v))))
  }
  const sumLine = tr('sum', { n: range, usd: usdOf(t), req: t.n }) + ' · ' + tr('total') + ' ' + tok(inAll + t.o)
  const summary = [Text({ bold: true, children: [sumLine] }), ...statRows]

  // Per-model rows: name, share, bar, value, and tokens when there is room. The bar takes
  // whatever width the other columns leave.
  const nameW = wide ? 20 : 14
  const fixed = nameW + 7 + 9 + (wide ? 10 : 0)
  const gaps = wide ? 4 : 3
  const barW = Math.max(6, Math.min(30, inner - fixed - gaps))
  const models = Object.entries(agg.byModel).sort((a, b) => b[1].usd - a[1].usd)
  const modelRows = models.map(([m, r]) => {
    const share = t.usd > 0 ? r.usd / t.usd : 0
    const cells = [
      cell(nameW, shortModel(m) + (priceOf(m) ? '' : ' ⚠ ' + tr('nopr'))),
      num(7, (share * 100).toFixed(1) + '%'),
      bar(barW, share),
      num(9, fmtUsd(r.usd)),
    ]
    if (wide) cells.push(num(10, tok(r.i + r.o + r.cr + r.cw)))
    return row(cells)
  })

  // Average TPS per model, fastest first; models with no measurable generation are left out.
  const tpsRows = models
    .map(([m, r]) => [m, avgTps(r)])
    .filter(([, v]) => v !== null)
    .sort((a, b) => b[1] - a[1])
    .map(([m, v]) => row([cell(nameW, shortModel(m)), num(9, v.toFixed(0) + ' t/s')]))
  const tpsSection = tpsRows.length ? [Text({ bold: true, children: [tr('tpsAvg')] }), ...tpsRows] : []

  let daily = []
  {
    const dayList = []
    for (let k = range - 1; k >= 0; k--) dayList.push(dayKey(new Date(now - k * 86400000)))
    const withData = dayList.filter((d) => (agg.byDay[d] || 0) > 0)
    const max = Math.max(0, ...withData.map((d) => agg.byDay[d]))
    const dayBarW = Math.max(6, Math.min(30, inner - 7 - 9 - 2))
    if (withData.length) {
      daily = [
        Text({ bold: true, children: [tr('daily')] }),
        ...withData.map((d) => row([cell(7, d.slice(5)), bar(dayBarW, agg.byDay[d] / max), num(9, fmtUsd(agg.byDay[d]))])),
      ]
    }
  }

  if (tab === 'models') return card([...top, Text({ bold: true, children: [tr('models')] }), ...modelRows, ...tpsSection])
  if (tab === 'daily') return card([...top, ...daily])
  return card([...top, ...summary])
}
