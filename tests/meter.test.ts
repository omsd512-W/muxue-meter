import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Run with: claude plugin test .
// Every test runs on both surfaces that take input, and none depends on the host OS: the
// Windows and macOS/Linux account paths are both driven through mocked env vars and files.

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.UTC(2026, 9, 2, 3, 0, 0)

const band = (columns = 120) =>
  ({
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: columns, scroll: { offset: 0, bodyRows: 30 }, view: {} },
  }) as const

const footer = () => ({ component: 'SessionMode', props: { modes: ['focus'] } }) as const

const hash = async (uuid: string) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uuid))
  return Array.from(new Uint8Array(buf))
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

type World = {
  env: Record<string, string>
  files?: Record<string, string>
  store?: Record<string, unknown>
  // Answer $.store from this map itself, so a test can change it as another session would.
  liveStore?: Map<string, unknown>
  published?: string | null
  rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[]
  // Transcript files by full path and their size in bytes; change it to grow one.
  logs?: Record<string, number>
  // Folders listed under .../.claude/projects.
  projectDirs?: string[]
}

// Answers every noun the plugin calls beneath it. Files are matched by path suffix, so the
// same table serves C:\Users\x and /Users/x homes.
function world(on: On, w: World) {
  const clock = mock.clock(on, { now: NOW })
  if (w.liveStore) {
    const m = w.liveStore
    on('store.get', ($, e) => ({ value: m.get(e.key) }))
    on('store.set', ($, e) => (m.set(e.key, e.value), { value: undefined }))
    on('store.delete', ($, e) => (m.delete(e.key), { value: undefined }))
    on('store.keys', () => ({ value: [...m.keys()] }))
  } else mock.store(on, w.store ?? {})
  mock.env(on, w.env)
  const files: Record<string, string> = { '/.claude-plugin/plugin.json': JSON.stringify({ version: '0.4.0' }), ...(w.files ?? {}) }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('fs.read', ($, e) => {
    const hit = Object.keys(files).find((k) => e.path.replace(/\\/g, '/').endsWith(k))
    if (!hit) throw new Error('ENOENT: ' + e.path)
    return { value: files[hit] }
  })
  const logs = w.logs ?? {}
  on('session.root', () => ({ value: '/work' }))
  on('fs.exists', ($, e) => ({ value: e.path in logs }))
  on('fs.stat', ($, e) => {
    if (!(e.path in logs)) throw new Error('ENOENT: ' + e.path)
    return { value: { kind: 'file', size: logs[e.path], mtimeMs: NOW, isLink: false } }
  })
  on('fs.list', ($, e) => ({
    value: e.path.endsWith('/.claude/projects')
      ? (w.projectDirs ?? []).map((name) => ({ name, kind: 'dir', size: 0, mtimeMs: NOW, isLink: false }))
      : [],
  }))
  on('http.fetch', () =>
    w.published
      ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ version: w.published }) } }
      : { value: { status: 404, ok: false, headers: {}, text: '' } },
  )
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: w.rateLimits ?? [] } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  return clock
}

const start = ($: any, surface: string) => $.session.start({ cwd: '/work', surface, isInteractive: true })

test('desktop session: account from CLAUDE_CODE_ACCOUNT_UUID, labelled by masked e-mail', async ($, on) => {
  world(on, { env: { USERPROFILE: 'C:\\Users\\me', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop', CLAUDE_CODE_USER_EMAIL: 'alice@example.com' } })
  const id = await hash('uuid-desktop')
  await start($, 'desktop')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await $.command.run({ command: 'meter', args: '' } as any)
    const acct = await ui.find({ key: 'acct' })
    expect(acct?.props.options).toContainEqual({ value: id, label: expect.stringContaining('al…@example.com') })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

test('macOS / Linux CLI session: no USERPROFILE, account read from $HOME/.claude.json', async ($, on) => {
  world(on, {
    env: { HOME: '/Users/mac' },
    files: { '/Users/mac/.claude.json': JSON.stringify({ oauthAccount: { accountUuid: 'uuid-cli', emailAddress: 'bob@example.org' } }) },
  })
  const id = await hash('uuid-cli')
  await start($, 'terminal')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await $.command.run({ command: 'meter', args: '' } as any)
    const acct = await ui.find({ key: 'acct' })
    expect(acct?.props.options).toContainEqual({ value: id, label: expect.stringContaining('bo…@example.org') })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

test('a newer published version shows the update badge', async ($, on) => {
  world(on, { env: { HOME: '/Users/mac' }, published: '0.5.0' })
  await start($, 'desktop')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    expect(await ui.find({ type: 'Text', text: /v0\.5\.0/ })).toBeDefined()
    // The command is shown in the card only, never run.
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.press({ key: 'upd' })
    const cmd = await ui.find({ type: 'Code' })
    expect(cmd?.props.source).toMatch(/^git -C ".+" pull --ff-only$/)
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

test('no update badge when the published version is not newer', async ($, on) => {
  world(on, { env: { HOME: '/Users/mac' }, published: '0.4.0' })
  await start($, 'desktop')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    expect(await ui.find({ type: 'Text', text: /⬆/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('narrow band: the status line drops to its compact form', async ($, on) => {
  world(on, { env: { HOME: '/Users/mac' } })
  await start($, 'desktop')
  for (const surface of SURFACES) {
    // The band has no view switch now, so it is narrower still before the compact form is used.
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band(30) })
    expect(await ui.find({ type: 'Text', text: /^⚡— · \$0\.00\/\$0\.00/ })).toBeDefined()
    await ui.unmount()
  }
})

test('view switch: one button in the footer, beside speed and value, cycles hidden, brief and full', async ($, on) => {
  world(on, { env: { HOME: '/Users/mac' }, store: { cfg: { names: {}, hints: {}, range: '7', acct: 'all', exact: false, lang: 'en' } } })
  await start($, 'desktop')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    const foot = await $.ui.mount({ plugin: 'muxue-meter', surface, ...footer() })
    // The band has no switch of its own; the footer has the one button in every view.
    for (const key of ['view-hidden', 'view-brief', 'view-full']) expect(await ui.find({ key })).toBeUndefined()
    expect(await foot.find({ type: 'Text', text: /^⚡— · \$0\.00$/ })).toBeDefined()
    // Brief by default: the status line, no card.
    expect(await foot.find({ key: 'view-cycle', text: '[Brief]' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Session \$/ })).toBeDefined()
    expect(await ui.find({ key: 'acct' })).toBeUndefined()
    // brief -> full: the card.
    await foot.press({ key: 'view-cycle' })
    expect(await foot.find({ key: 'view-cycle', text: '[Detailed]' })).toBeDefined()
    expect(await ui.find({ key: 'acct' })).toBeDefined()
    // full -> hidden: nothing above the prompt, the footer stays.
    await foot.press({ key: 'view-cycle' })
    expect(await foot.find({ key: 'view-cycle', text: '[Hide]' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Session \$/ })).toBeUndefined()
    expect(await foot.find({ type: 'Text', text: /^⚡— · \$0\.00$/ })).toBeDefined()
    // hidden -> brief.
    await foot.press({ key: 'view-cycle' })
    expect(await ui.find({ type: 'Text', text: /Session \$/ })).toBeDefined()
    // /meter opens the card and goes back to the status line.
    await $.command.run({ command: 'meter', args: '' } as any)
    expect(await ui.find({ key: 'acct' })).toBeDefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    expect(await ui.find({ key: 'acct' })).toBeUndefined()
    await foot.unmount()
    await ui.unmount()
  }
})

test('a rename keeps names another session saved meanwhile', async ($, on) => {
  const other = await hash('uuid-other')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: { names: { [other]: 'work' }, hints: {}, range: '7', acct: 'all', exact: false, lang: 'en' },
      's:old': { upd: NOW, days: { '2026-10-02': { [other]: { 'claude-opus-5-5': { i: 1, o: 1, cr: 0, cw: 0, n: 1, gms: 0, gtok: 0 } } } } },
    },
  })
  const id = await hash('uuid-desktop')
  await start($, 'desktop')
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  await $.command.run({ command: 'meter', args: '' } as any)
  await ui.select({ key: 'acct', value: id })
  await ui.press({ key: 'edit-name' })
  await ui.input({ key: 'rename', text: 'home' })
  const acct = await ui.find({ key: 'acct' })
  expect(acct?.props.options).toContainEqual({ value: id, label: expect.stringContaining('home') })
  expect(acct?.props.options).toContainEqual({ value: other, label: 'work' })
  await ui.unmount()
})

// ---- quota estimate ----------------------------------------------------------------------

const H = 3600000
const BUCKET = 5 * 60000
const bucket = (t: number) => String(Math.floor(t / BUCKET))
const iso = (t: number) => new Date(t).toISOString()
const enCfg = { names: {}, hints: {}, range: '7', acct: 'all', exact: false, lang: 'en' }
const measure = ($: any, rateLimits: unknown[]) =>
  $.session.measure({ context: { window: 200000 }, rateLimits, changed: ['rateLimits'] })

test('quota: value recorded since the first reading divided by the rise of the fill', async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      // Another session of the same account read both windows at 0% two hours ago; $10 came
      // after that, $99 before it (not part of the rise).
      's:old': {
        upd: NOW,
        days: {},
        base: {
          [id]: {
            five_hour: { p: 0, r: NOW + 2 * H, at: NOW - 2 * H },
            seven_day: { p: 0, r: NOW + 72 * H, at: NOW - 2 * H },
          },
        },
        b: { [bucket(NOW - H)]: { [id]: { u: 10 } }, [bucket(NOW - 4 * H)]: { [id]: { u: 99 } } },
      },
    },
  })
  await start($, 'desktop')
  await measure($, [
    { kind: 'five_hour', percentUsed: 20, resetsAt: iso(NOW + 2 * H) },
    { kind: 'seven_day', percentUsed: 2, resetsAt: iso(NOW + 72 * H) },
  ])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.press({ key: 'tab-quota' })
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$50\.00$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Predicted Week quota — \(after 3% more\)$/ })).toBeDefined()
    // Another tab: the quota rows give way, and the collapsed line still carries the fill.
    await ui.press({ key: 'tab-usage' })
    expect(await ui.find({ type: 'Text', text: /Predicted/ })).toBeUndefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    expect(await ui.find({ type: 'Text', text: /· 5h 20% .*· Week 2%/ })).toBeDefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

test('quota: recording that started mid-window divides only what came after the first reading', async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      // Recording began an hour ago, inside a window already 88% full ($100 before the first
      // reading at 88%, $5 after it). Dividing $105 by 92% would give a tiny, wrong quota.
      's:old': {
        upd: NOW,
        days: {},
        base: { [id]: { five_hour: { p: 88, r: NOW + 3 * H, at: NOW - 40 * 60000 } } },
        b: { [bucket(NOW - 50 * 60000)]: { [id]: { u: 100 } }, [bucket(NOW - 20 * 60000)]: { [id]: { u: 5 } } },
      },
    },
  })
  await start($, 'terminal')
  // Only 4 points since the first reading: too few to divide by.
  await measure($, [{ kind: 'five_hour', percentUsed: 92, resetsAt: iso(NOW + 3 * H) }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.press({ key: 'tab-quota' })
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota — \(after 1% more\)$/ })).toBeDefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
  // 10 points since the first reading: $5 / 10% = $50.
  await measure($, [{ kind: 'five_hour', percentUsed: 98, resetsAt: iso(NOW + 3 * H + 3000) }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.press({ key: 'tab-quota' })
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$50\.00$/ })).toBeDefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

test('quota: an estimate saved by 0.5.0 drafts (a part divided by the whole fill) is ignored', async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: { cfg: enCfg, 's:old': { upd: NOW, days: {}, est: { [id]: { seven_day: { q: 1.41, low: true, r: NOW + H, at: NOW - H } } } } },
  })
  await start($, 'desktop')
  await measure($, [{ kind: 'seven_day', percentUsed: 92, resetsAt: iso(NOW + 6 * H) }])
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  await $.command.run({ command: 'meter', args: '' } as any)
  await ui.press({ key: 'tab-quota' })
  expect(await ui.find({ type: 'Text', text: /^Predicted Week quota — \(after 5% more\)$/ })).toBeDefined()
  await ui.unmount()
})

test('tabs are labelled in the chosen language; the toggle and language picker share the top line', async ($, on) => {
  world(on, { env: { HOME: '/Users/mac' }, store: { cfg: { ...enCfg, lang: 'zh-CN' } } })
  await start($, 'desktop')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await $.command.run({ command: 'meter', args: '' } as any)
    for (const [key, label] of [['tab-usage', '概览'], ['tab-quota', '额度'], ['tab-models', '模型'], ['tab-daily', '每日']]) {
      expect((await ui.find({ key }))?.props.label).toContain(label)
    }
    const right = await ui.find({ key: 'usage-right' })
    expect(right).toBeDefined()
    expect(await ui.find({ key: 'lang' })).toBeDefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    expect(await ui.find({ key: 'lang' })).toBeUndefined()
    await ui.unmount()
  }
})

test('quota: each account keeps its own readings; selecting one hides the others', async ($, on) => {
  const id = await hash('uuid-desktop')
  const other = await hash('uuid-other')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: { ...enCfg, names: { [other]: 'work' } },
      's:old': {
        upd: NOW,
        days: { '2026-10-02': { [other]: { 'claude-opus-5-5': { i: 1, o: 1, cr: 0, cw: 0, n: 1, gms: 0, gtok: 0 } } } },
        base: { [other]: { five_hour: { p: 0, r: NOW + H, at: NOW - 2 * H } } },
        b: { [bucket(NOW - H)]: { [other]: { u: 30 } } },
        rl: { [other]: { five_hour: { p: 60, r: NOW + H, at: NOW - 10 * 60000 } } },
      },
    },
  })
  await start($, 'desktop')
  // This session's account: nothing recorded, so it has no estimate and must not borrow the other's $30.
  await measure($, [{ kind: 'five_hour', percentUsed: 10, resetsAt: iso(NOW + 4 * H) }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.press({ key: 'tab-quota' })
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$50\.00$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota — \(after 5% more\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /· work · UTC\+8$/ })).toBeDefined()
    await ui.select({ key: 'acct', value: id })
    expect(await ui.find({ type: 'Text', text: /\$50\.00/ })).toBeUndefined()
    await ui.select({ key: 'acct', value: 'all' })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

test('quota: a resumed session keeps its own saved estimate', async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      's:session-1': { upd: NOW - 6 * H, days: {}, b: {}, est: { [id]: { five_hour: { q: 42, r: NOW - 5 * H, at: NOW - 6 * H, d: 1 } } } },
    },
  })
  await start($, 'desktop')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.press({ key: 'tab-quota' })
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$42\.00$/ })).toBeDefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})


test("quota: a new window starts over from its own first reading", async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      // The last window ended an hour ago (its baseline at 40%); the new one was first read at 0%
      // 30 minutes ago, in another session.
      's:old': {
        upd: NOW,
        days: {},
        base: { [id]: { five_hour: { p: 40, r: NOW - H, at: NOW - 3 * H } } },
        rl: { [id]: { five_hour: { p: 95, r: NOW - H, at: NOW - 2 * H } } },
        b: { [bucket(NOW - 2 * H)]: { [id]: { u: 70 } }, [bucket(NOW - 20 * 60000)]: { [id]: { u: 6 } } },
      },
      's:new': { upd: NOW, days: {}, base: { [id]: { five_hour: { p: 0, r: NOW + 4.5 * H, at: NOW - 30 * 60000 } } } },
    },
  })
  await start($, 'desktop')
  await measure($, [{ kind: 'five_hour', percentUsed: 6, resetsAt: iso(NOW + 4.5 * H) }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.press({ key: 'tab-quota' })
    // $6 in the new window over its 6%; the old window's $70 and its baseline play no part.
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$100$/ })).toBeDefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

test('quota: a window reset early (its fill fell, resetsAt kept) starts over from the fall', async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      // The week was first read at 0% three days ago and filled to 96% ($300); a reset card then
      // emptied it without moving resetsAt, and another session read it at 0% two hours ago.
      's:before': {
        upd: NOW,
        days: {},
        base: { [id]: { seven_day: { p: 0, r: NOW + 48 * H, at: NOW - 72 * H } } },
        rl: { [id]: { seven_day: { p: 96, r: NOW + 48 * H, at: NOW - 3 * H } } },
        b: { [bucket(NOW - 24 * H)]: { [id]: { u: 300 } } },
      },
      's:after': {
        upd: NOW,
        days: {},
        base: { [id]: { seven_day: { p: 0, r: NOW + 48 * H + 3000, at: NOW - 2 * H } } },
        b: { [bucket(NOW - H)]: { [id]: { u: 25 } } },
      },
    },
  })
  await start($, 'desktop')
  await measure($, [{ kind: 'seven_day', percentUsed: 10, resetsAt: iso(NOW + 48 * H) }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.press({ key: 'tab-quota' })
    // $25 since the reset over 10%; the $300 from before it is not divided by the new fill.
    expect(await ui.find({ type: 'Text', text: /^Predicted Week quota \$250$/ })).toBeDefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

test('quota: a session open across an early reset starts over from its first reading after it', async ($, on) => {
  const id = await hash('uuid-desktop')
  const clock = world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: { cfg: enCfg, 's:other': { upd: NOW, days: {}, b: { [bucket(NOW - H)]: { [id]: { u: 200 } }, [bucket(NOW + H)]: { [id]: { u: 20 } } } } },
  })
  await start($, 'desktop')
  await measure($, [{ kind: 'seven_day', percentUsed: 80, resetsAt: iso(NOW + 48 * H) }])
  // A reset card empties the week; resetsAt stays put.
  await clock.advance(30 * 60000)
  await measure($, [{ kind: 'seven_day', percentUsed: 0, resetsAt: iso(NOW + 48 * H) }])
  await clock.advance(2 * H)
  await measure($, [{ kind: 'seven_day', percentUsed: 8, resetsAt: iso(NOW + 48 * H) }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.press({ key: 'tab-quota' })
    // $20 since the 0% reading over 8%.
    expect(await ui.find({ type: 'Text', text: /^Predicted Week quota \$250$/ })).toBeDefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

test('quota: a late reading a little lower, or one later readings climb back above, is not a reset', async ($, on) => {
  const id = await hash('uuid-desktop')
  const r = NOW + 2 * H
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      // Read at 0% first, 37% and 91% by other sessions; then two late readings, saved after the
      // 91% one: 84% (7 points lower, but 93% follows) and 89% (2 points lower).
      's:a': {
        upd: NOW,
        days: {},
        base: { [id]: { five_hour: { p: 0, r, at: NOW - 160 * 60000 } } },
        rl: { [id]: { five_hour: { p: 89, r, at: NOW - 6 * 60000 } } },
        b: { [bucket(NOW - 2 * H)]: { [id]: { u: 28.3 } }, [bucket(NOW)]: { [id]: { u: 0.8 } } },
      },
      's:b': { upd: NOW, days: {}, base: { [id]: { five_hour: { p: 37, r, at: NOW - 2 * H } } } },
      's:c': {
        upd: NOW,
        days: {},
        base: { [id]: { five_hour: { p: 91, r, at: NOW - 7 * 60000 } } },
        rl: { [id]: { five_hour: { p: 93, r, at: NOW - 5 * 60000 } } },
      },
      's:d': { upd: NOW, days: {}, base: { [id]: { five_hour: { p: 84, r, at: NOW - 6.5 * 60000 } } } },
    },
  })
  await start($, 'desktop')
  await measure($, [{ kind: 'five_hour', percentUsed: 97, resetsAt: iso(r) }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.press({ key: 'tab-quota' })
    // $29.10 since the 0% reading over 97%; starting over from the 89% reading would give $10.
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$30\.00$/ })).toBeDefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

test('quota: a CLI session whose ~/.claude.json names another account is filed under the true one', async ($, on) => {
  const named = await hash('uuid-cli')
  const real = await hash('uuid-real')
  world(on, {
    env: { HOME: '/Users/mac' },
    files: { '/Users/mac/.claude.json': JSON.stringify({ oauthAccount: { accountUuid: 'uuid-cli', emailAddress: 'bob@example.org' } }) },
    store: {
      cfg: { ...enCfg, names: { [named]: 'named', [real]: 'real' } },
      // Desktop sessions (account from the env var) saw each account's own week.
      's:a': {
        upd: NOW,
        src: 'env',
        days: { '2026-10-02': { [named]: { 'claude-opus-5-5': { i: 1, o: 1, cr: 0, cw: 0, n: 1, gms: 0, gtok: 0 } } } },
        base: { [named]: { seven_day: { p: 10, r: NOW + 100 * H, at: NOW - H } } },
      },
      's:b': {
        upd: NOW,
        src: 'env',
        days: {},
        base: { [real]: { five_hour: { p: 0, r: NOW + 3 * H, at: NOW - 2 * H }, seven_day: { p: 30, r: NOW + 50 * H, at: NOW - 2 * H } } },
      },
      // This CLI session, under the named account, already spent $10 an hour ago.
      's:session-1': {
        upd: NOW,
        src: 'file',
        days: {},
        b: { [bucket(NOW - H)]: { [named]: { u: 10 } } },
        base: { [named]: { seven_day: { p: 31, r: NOW + 50 * H, at: NOW - 90 * 60000 } } },
      },
    },
  })
  await start($, 'terminal')
  // Its readings carry the real account's week: they, and the $10, are the real account's.
  await measure($, [
    { kind: 'five_hour', percentUsed: 20, resetsAt: iso(NOW + 3 * H) },
    { kind: 'seven_day', percentUsed: 35, resetsAt: iso(NOW + 50 * H) },
  ])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await $.command.run({ command: 'meter', args: '' } as any)
    const acct = await ui.find({ key: 'acct' })
    expect(acct?.props.options).toContainEqual({ value: real, label: 'real (current)' })
    await ui.press({ key: 'tab-quota' })
    expect(await ui.find({ type: 'Text', text: /· real · UTC\+8$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$50\.00$/ })).toBeDefined()
    // The named account keeps only its own week, at 10%, with nothing to divide.
    await ui.select({ key: 'acct', value: named })
    expect(await ui.find({ type: 'Text', text: /\$50\.00/ })).toBeUndefined()
    await ui.select({ key: 'acct', value: 'all' })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

test('a session whose own saved doc is unreadable still counts the other sessions', async ($, on) => {
  const other = await hash('uuid-other')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      's:session-1': 'not a doc',
      's:old': { upd: NOW, days: { '2026-10-02': { [other]: { 'claude-sonnet-5-5': { i: 0, o: 1e6, cr: 0, cw: 0, n: 1, gms: 0, gtok: 0 } } } } },
    },
  })
  await start($, 'desktop')
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  await $.command.run({ command: 'meter', args: '' } as any)
  expect(await ui.find({ type: 'Text', text: /API-equivalent value \$10\.00/ })).toBeDefined()
  await ui.unmount()
})

test('expanded at desktop width: the status line keeps labels instead of the compact form', async ($, on) => {
  world(on, { env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' }, store: { cfg: { ...enCfg, lang: 'zh-CN' } } })
  await start($, 'desktop')
  await measure($, [
    { kind: 'five_hour', percentUsed: 14, resetsAt: iso(NOW + 2 * H) },
    { kind: 'seven_day', percentUsed: 92, resetsAt: iso(NOW + 6 * H) },
  ])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band(100) })
    await $.command.run({ command: 'meter', args: '' } as any)
    expect(await ui.find({ type: 'Text', text: /当前会话 \$0\.00 · 今日 \$0\.00 .*5小时 14% · 每周 92%$/ })).toBeDefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

test('an impossible speed (a timing glitch) is neither shown nor recorded', async ($, on) => {
  const clock = world(on, { env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' }, store: { cfg: enCfg } })
  const usage = { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  // 1000 tokens whose first chunk came 0.5 s before the stop: 2000 tok/s, more than any model streams.
  on('turn.step', async function* ($: any, e: any, next: any) {
    await clock.advance(10000)
    yield { kind: 'text', index: 0, text: 'hi' }
    await clock.advance(500)
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: 't', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage }
  } as any)
  await start($, 'desktop')
  const stream: any = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as any)
  for await (const _ of stream) {
  }
  await stream.result
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  expect(await ui.find({ type: 'Text', text: /^⚡ — tok\/s · Session \$0\.0\d/ })).toBeDefined()
  await $.command.run({ command: 'meter', args: '' } as any)
  await ui.press({ key: 'tab-models' })
  expect(await ui.find({ type: 'Text', text: /t\/s$/ })).toBeUndefined()
  await ui.unmount()
})

test("a subagent's requests count toward the session, and several at once keep their own timing", async ($, on) => {
  const clock = world(on, { env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' }, store: { cfg: enCfg } })
  // Sonnet 5.5 output at $10 per million: 100k tokens = $1.00 per request.
  const usage = { model: 'claude-sonnet-5-5', input_tokens: 0, output_tokens: 100000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('turn.step', async function* ($: any, e: any, next: any) {
    yield { kind: 'text', index: 0, text: 'x' }
    await clock.advance(1000)
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: e.index, answer: 'x', toolUses: [], stopReason: 'end_turn', usage }
  } as any)
  await start($, 'desktop')
  const run = async (input: any) => {
    const stream: any = $.turn.step(input)
    for await (const _ of stream) {
    }
    await stream.result
  }
  await Promise.all([
    run({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 }),
    run({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'agent-1' }),
    run({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'agent-2' }),
  ])
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  expect(await ui.find({ type: 'Text', text: /Session \$3\.00/ })).toBeDefined()
  await ui.unmount()
})

test('Haiku 5.5 is priced by prompt length, and Sonnet 5.5 cache reads at $0.10', async ($, on) => {
  const clock = world(on, { env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' }, store: { cfg: enCfg } })
  const usages: Record<string, any> = {
    // 1M output at $0.50: a short prompt.
    a: { model: 'claude-haiku-5-5', input_tokens: 0, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    // 150k prompt (over 100k, counting the cache read): 50k input at $0.50 + 100k cache read at $0.05 + 1M output at $2.50.
    b: { model: 'claude-haiku-5-5', input_tokens: 50000, output_tokens: 1e6, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0 },
    // 10M cache read at $0.10.
    c: { model: 'claude-sonnet-5-5', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e7, cache_creation_input_tokens: 0 },
  }
  on('turn.step', async function* ($: any, e: any, next: any) {
    const usage = usages[e.turnId]
    yield { kind: 'text', index: 0, text: 'x' }
    await clock.advance(1000)
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: 0, answer: 'x', toolUses: [], stopReason: 'end_turn', usage }
  } as any)
  await start($, 'desktop')
  for (const turnId of Object.keys(usages)) {
    const stream: any = $.turn.step({ turnId, index: 0, model: usages[turnId].model, messageCount: 1 } as any)
    for await (const _ of stream) {
    }
    await stream.result
  }
  // 0.50 + (0.025 + 0.005 + 2.50) + 1.00
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    expect(await ui.find({ type: 'Text', text: /Session \$4\.03/ })).toBeDefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.press({ key: 'tab-models' })
    expect(await ui.find({ type: 'Text', text: /haiku-5-5@long/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no price/ })).toBeUndefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

// ---- reset times, subscription end, shared view ------------------------------------------
// NOW is 2026-10-02 11:00 in UTC+8, the time zone these are shown in.

test('quota rows show when each window resets (UTC+8) and the time left', async ($, on) => {
  world(on, { env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' }, store: { cfg: enCfg } })
  await start($, 'desktop')
  await measure($, [
    { kind: 'five_hour', percentUsed: 20, resetsAt: iso(NOW + 2 * H) },
    { kind: 'seven_day', percentUsed: 2, resetsAt: iso(NOW + 72 * H) },
  ])
  for (const surface of SURFACES) {
    // Wide enough, the status line carries the reset times too.
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band(200) })
    expect(await ui.find({ type: 'Text', text: /5h 20% → 13:00 \(UTC\+8\) · Week 2% → 10-05 11:00 \(UTC\+8\)$/ })).toBeDefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.press({ key: 'tab-quota' })
    // Today's reset as HH:mm, a later day's with its date.
    expect(await ui.find({ type: 'Text', text: '→ 13:00 · 2h 0m left' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '→ 10-05 11:00 · 3d 0h 0m left' })).toBeDefined()
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

test('subscription end: typed in the quota title, shown with the time left, cleared when emptied', async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, { env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' }, store: { cfg: enCfg } })
  await start($, 'desktop')
  await measure($, [{ kind: 'five_hour', percentUsed: 20, resetsAt: iso(NOW + 2 * H) }])
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  await $.command.run({ command: 'meter', args: '' } as any)
  await ui.press({ key: 'tab-quota' })
  expect(await ui.find({ type: 'Text', text: /Subscription ends/ })).toBeUndefined()
  // The date lasts to the end of that day in UTC+8: 2026-10-12 24:00 is 10 days 13 hours away.
  await ui.press({ key: 'exp-edit-' + id })
  await ui.input({ key: 'exp-' + id, text: '2026-10-12' })
  expect(await ui.find({ type: 'Text', text: /· Subscription ends 2026-10-12 10d 13h 0m left · UTC\+8$/ })).toBeDefined()
  // Something that is no date is not saved.
  await ui.press({ key: 'exp-edit-' + id })
  await ui.input({ key: 'exp-' + id, text: 'soon' })
  expect(await ui.find({ type: 'Text', text: /Subscription ends 2026-10-12/ })).toBeDefined()
  // An empty field clears it.
  await ui.press({ key: 'exp-edit-' + id })
  await ui.input({ key: 'exp-' + id, text: '' })
  expect(await ui.find({ type: 'Text', text: /Subscription ends/ })).toBeUndefined()
  await ui.unmount()
})

test('quota: from an empty window (0%) the bucket of the first reading counts too', async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      // The window was empty at the first reading; the $10 beside it came after (the reading
      // lags the response), so all of it is part of the rise.
      's:old': {
        upd: NOW,
        days: {},
        base: { [id]: { five_hour: { p: 0, r: NOW + 2 * H, at: NOW - 2 * H } } },
        b: { [bucket(NOW - 2 * H)]: { [id]: { u: 10 } } },
      },
    },
  })
  await start($, 'desktop')
  await measure($, [{ kind: 'five_hour', percentUsed: 20, resetsAt: iso(NOW + 2 * H) }])
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  await $.command.run({ command: 'meter', args: '' } as any)
  await ui.press({ key: 'tab-quota' })
  expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$50\.00$/ })).toBeDefined()
  await ui.unmount()
})

test('quota: from a window already in use, the bucket of the first reading is still left out', async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      's:old': {
        upd: NOW,
        days: {},
        base: { [id]: { five_hour: { p: 5, r: NOW + 2 * H, at: NOW - 2 * H } } },
        b: { [bucket(NOW - 2 * H)]: { [id]: { u: 10 } }, [bucket(NOW - H)]: { [id]: { u: 10 } } },
      },
    },
  })
  await start($, 'desktop')
  await measure($, [{ kind: 'five_hour', percentUsed: 25, resetsAt: iso(NOW + 2 * H) }])
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  await $.command.run({ command: 'meter', args: '' } as any)
  await ui.press({ key: 'tab-quota' })
  // $10 after the first reading over 20 points.
  expect(await ui.find({ type: 'Text', text: /^Predicted 5h quota \$50\.00$/ })).toBeDefined()
  await ui.unmount()
})

test('the view is shared: another session switching it shows here within seconds', async ($, on) => {
  const shared = new Map<string, unknown>([['cfg', enCfg]])
  const clock = world(on, { env: { HOME: '/Users/mac' }, liveStore: shared })
  await start($, 'desktop')
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  expect(await ui.find({ key: 'acct' })).toBeUndefined()
  // Another session opens the card: it writes the shared settings.
  shared.set('cfg', { ...enCfg, view: 'full' })
  await clock.advance(3000)
  expect(await ui.find({ key: 'acct' })).toBeDefined()
  await ui.unmount()
})

test('quota: each live window lists its use by model, earlier unsplit use on a line of its own', async ($, on) => {
  const id = await hash('uuid-desktop')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: enCfg,
      's:old': {
        upd: NOW,
        days: {},
        b: {
          // Inside the 5h window, split by model.
          [bucket(NOW - H)]: {
            [id]: {
              u: 7,
              m: {
                'claude-opus-5-5': { i: 1000, o: 200000, cr: 2000000, cw: 0, u: 5 },
                'claude-sonnet-5-5': { i: 0, o: 100000, cr: 0, cw: 30000, u: 2 },
              },
            },
          },
          // Inside the week only, recorded before buckets were split.
          [bucket(NOW - 24 * H)]: { [id]: { u: 30 } },
        },
      },
    },
  })
  await start($, 'desktop')
  await measure($, [
    { kind: 'five_hour', percentUsed: 20, resetsAt: iso(NOW + 2 * H) },
    { kind: 'seven_day', percentUsed: 10, resetsAt: iso(NOW + 72 * H) },
  ])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.press({ key: 'tab-quota' })
    // Folded at first: only the windows' rows, each with its toggle.
    expect(await ui.find({ type: 'Text', text: /^opus-5-5$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Total' })).toBeUndefined()
    await ui.press({ key: `q-open-${id}-five_hour` })
    await ui.press({ key: `q-open-${id}-seven_day` })
    // Both windows list the two models, the larger value first.
    const names = (await ui.findAll({ type: 'Text', text: /^opus-5-5$|^sonnet-5-5$/ })).map((x) => x.text)
    expect(names).toEqual(['opus-5-5', 'sonnet-5-5', 'opus-5-5', 'sonnet-5-5'])
    // opus: 1.0K uncached and 2.00M cache read, 2.00M input in all.
    expect(await ui.find({ type: 'Text', text: 'Uncached 1.0K' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Cache read 2.00M' })).toBeDefined()
    // sonnet: 30.0K written to the cache, its whole input.
    expect(await ui.find({ type: 'Text', text: 'Cache write 30.0K' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Input 30.0K' })).toBeDefined()
    // The total adds the three parts: 1.0K + 2.00M + 30.0K.
    expect(await ui.find({ type: 'Text', text: 'Input 2.03M' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Input 2.00M' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Output 200.0K' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$5.00' })).toBeDefined()
    // The unsplit $30 falls inside the week alone.
    expect(await ui.findAll({ type: 'Text', text: 'Earlier use (not split by model)' })).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: '$30.00' })).toBeDefined()
    // Each window ends with its total: the 5h $7, the week $7 and the earlier $30.
    expect((await ui.findAll({ type: 'Text', text: 'Total' })).length).toBe(2)
    expect(await ui.find({ type: 'Text', text: 'Output 300.0K' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$7.00' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$37.00' })).toBeDefined()
    // Folding one window again takes its rows away and leaves the other's.
    await ui.press({ key: `q-open-${id}-five_hour` })
    expect((await ui.findAll({ type: 'Text', text: 'Total' })).length).toBe(1)
    await ui.press({ key: `q-open-${id}-seven_day` })
    await $.command.run({ command: 'meter', args: '' } as any)
    await ui.unmount()
  }
})

test('a response is recorded in its bucket by model as well', async ($, on) => {
  const clock = world(on, { env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' }, store: { cfg: enCfg } })
  const usage = { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('turn.step', async function* ($: any, e: any, next: any) {
    yield { kind: 'text', index: 0, text: 'x' }
    await clock.advance(1000)
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: e.index, answer: 'x', toolUses: [], stopReason: 'end_turn', usage }
  } as any)
  await start($, 'desktop')
  await measure($, [{ kind: 'five_hour', percentUsed: 20, resetsAt: iso(NOW + 2 * H) }])
  const stream: any = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 } as any)
  for await (const _ of stream) {
  }
  await stream.result
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  await $.command.run({ command: 'meter', args: '' } as any)
  await ui.press({ key: 'tab-quota' })
  const id = await hash('uuid-desktop')
  await ui.press({ key: `q-open-${id}-five_hour` })
  expect(await ui.find({ type: 'Text', text: /^sonnet-5-5$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Earlier use/ })).toBeUndefined()
  await ui.unmount()
})

test('subscription end: the field opens under its own account, not at the foot of the card', async ($, on) => {
  const id = await hash('uuid-desktop')
  const other = await hash('uuid-other')
  world(on, {
    env: { HOME: '/Users/mac', CLAUDE_CODE_ACCOUNT_UUID: 'uuid-desktop' },
    store: {
      cfg: { ...enCfg, names: { [id]: 'home', [other]: 'work' } },
      's:old': { upd: NOW, days: {}, rl: { [other]: { five_hour: { p: 40, r: NOW + 3 * H, at: NOW - H } } } },
    },
  })
  await start($, 'desktop')
  await measure($, [{ kind: 'five_hour', percentUsed: 20, resetsAt: iso(NOW + 2 * H) }])
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  await $.command.run({ command: 'meter', args: '' } as any)
  await ui.press({ key: 'tab-quota' })
  // The first account listed is this session's; open the field of that one.
  await ui.press({ key: 'exp-edit-' + id })
  const drawn = JSON.stringify(await ui.drawn())
  const at = (needle: string) => drawn.indexOf(needle)
  expect(at('"exp-' + id + '"')).toBeGreaterThan(at('"qt-' + id + '"'))
  // Before this account's own rows, and so before the other account's title.
  expect(at('"exp-' + id + '"')).toBeLessThan(at('Predicted 5h quota'))
  expect(at('"exp-' + id + '"')).toBeLessThan(at('"qt-' + other + '"'))
  await ui.input({ key: 'exp-' + id, text: '2026-10-12' })
  expect(await ui.find({ type: 'Text', text: /· home · Subscription ends 2026-10-12/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· work · UTC\+8$/ })).toBeDefined()
  await ui.unmount()
})

const MB = 1048576

test('transcript size: after the session value, out of 50MB on the desktop, marked from 40MB', async ($, on) => {
  const path = '/Users/mac/.claude/projects/-work/session-1.jsonl'
  const logs = { [path]: 18 * MB }
  world(on, { env: { HOME: '/Users/mac' }, logs })
  await start($, 'desktop')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    const foot = await $.ui.mount({ plugin: 'muxue-meter', surface, ...footer() })
    // The 50MB limit is the desktop app's: the terminal shows the size alone.
    const shown = surface === 'desktop' ? 'Transcript 18.0/50MB' : 'Transcript 18.0MB'
    expect(await ui.find({ type: 'Text', text: new RegExp('Session \\$0\\.00 · ' + shown.replace('.', '\\.') + ' · Today') })).toBeDefined()
    expect(await foot.find({ type: 'Text', text: '18.0MB' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⚠/ })).toBeUndefined()
    await ui.unmount()
    await foot.unmount()
  }

  // Grown past 40MB: a yellow mark on the desktop, the plain size in the terminal; red past 50MB.
  for (const [mb, color] of [[45, 'yellow'], [52.3, 'red']] as const) {
    logs[path] = mb * MB
    await measure($, [])
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
      const foot = await $.ui.mount({ plugin: 'muxue-meter', surface, ...footer() })
      const size = mb.toFixed(1)
      if (surface === 'desktop') {
        expect((await ui.find({ type: 'Text', text: `⚠ Transcript ${size}/50MB` }))?.props.color).toBe(color)
        expect((await foot.find({ type: 'Text', text: `${size}MB` }))?.props.color).toBe(color)
      } else {
        expect(await ui.find({ type: 'Text', text: new RegExp(`Transcript ${size.replace('.', '\\.')}MB`) })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /⚠/ })).toBeUndefined()
        expect((await foot.find({ type: 'Text', text: `${size}MB` }))?.props.dimColor).toBe(true)
      }
      await ui.unmount()
      await foot.unmount()
    }
  }
})

test('transcript size: found in another project folder when the root does not name it', async ($, on) => {
  world(on, {
    env: { HOME: '/Users/mac' },
    projectDirs: ['-other', '-moved'],
    logs: { '/Users/mac/.claude/projects/-moved/session-1.jsonl': 3.25 * MB },
  })
  await start($, 'desktop')
  const ui = await $.ui.mount({ plugin: 'muxue-meter', surface: 'desktop', ...band() })
  expect(await ui.find({ type: 'Text', text: /Transcript 3\.3\/50MB/ })).toBeDefined()
  await ui.unmount()
})

test('transcript size: nothing shown before the transcript is written', async ($, on) => {
  world(on, { env: { HOME: '/Users/mac' } })
  await start($, 'desktop')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'muxue-meter', surface, ...band() })
    expect(await ui.find({ type: 'Text', text: /Transcript/ })).toBeUndefined()
    await ui.unmount()
  }
})
