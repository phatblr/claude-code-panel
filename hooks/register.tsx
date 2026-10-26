// Mod นี้: เปิดแผง "Claude Usage" ในหน้า Claude Code โชว์ quota รอบ 5 ชั่วโมง และรอบสัปดาห์
// ตัวเลขอ่านจากไฟล์ ~/.claude/usage-cache.json ที่ VS Code extension "Claude Usage Limit" จดไว้
// (mod ไม่แตะรหัส login และไม่เรียก server เอง) — พิมพ์ /usage-pane เพื่อเปิดแผงอีกครั้ง
// ด้านบนโชว์โฟลเดอร์ที่เปิดอยู่ + สถานะ git (branch, ไฟล์ที่ยังไม่ commit 3 ไฟล์ล่าสุด + ปุ่มดูทั้งหมด, ที่ยังไม่ push)
// มี mascot ลูกเจี๊ยบเปลี่ยนอารมณ์ตามสถานะอยู่ล่างสุด
// โชว์ context ของแชต (เต็มกี่ %) และเวลาที่ใช้ในเทิร์นนี้ด้วย
// แผงเดียวกันนี้โชว์ Task Progress ด้วย: จับตอน Claude อัปเดตเช็กลิสต์ (เครื่องมือ TodoWrite) แบบเรียลไทม์
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChangedFile, Context, Todo, Turn, Usage, Workspace } from '../types'

const PANE = 'usage-pane'
const REFRESH_MS = 30_000
// เปลี่ยน tag เมื่อรูปแบบข้อมูลเปลี่ยน
const usage = atom({ plugin: 'usage-pane', key: 'usage' } as const, null, {
  shape: 'usage-1',
})

const todos = atom({ plugin: 'usage-pane', key: 'todos' } as const, [], {
  shape: 'todos-1',
})

const workspace = atom({ plugin: 'usage-pane', key: 'workspace' } as const, null, {
  shape: 'workspace-1',
})

const context = atom({ plugin: 'usage-pane', key: 'context' } as const, null, {
  shape: 'context-1',
})
// รายการไฟล์ที่เปลี่ยนใน git: false = โชว์ 3 ไฟล์ล่าสุด, true = โชว์ทั้งหมด
const gitExpanded = atom({ plugin: 'usage-pane', key: 'gitExpanded' } as const, false, {
  shape: 'gitExpanded-1',
})
const PREVIEW_FILES = 3
const MAX_FILES = 100 // เก็บรายการสูงสุดกี่ไฟล์
const MAX_STAT = 40 // หาเวลาแก้ล่าสุดของกี่ไฟล์แรก (กันช้าเมื่อมีไฟล์เปลี่ยนเยอะ)
const turn = atom(
  { plugin: 'usage-pane', key: 'turn' } as const,
  { startedAt: null, now: 0, lastSeconds: null },
  { shape: 'turn-1' },
)

// อ่านว่าแชตนี้เต็มแค่ไหน (ตัวเลขเดียวกับ status line ของ Claude Code)
async function loadContext($: EngineInterface): Promise<Context> {
  try {
    const { context: c } = await $.session.usage()
    if (c.percent === undefined || c.tokens === undefined) return null
    return { percent: c.percent, tokens: c.tokens, window: c.window }
  } catch {
    return null
  }
}

// อ่านโฟลเดอร์ที่เปิดอยู่ + สถานะ git (อ่านอย่างเดียว ไม่แก้อะไรใน repo)
async function loadWorkspace($: EngineInterface): Promise<Workspace> {
  try {
    const cwd = await $.session.cwd()
    const folder = cwd.split('/').filter(Boolean).pop() ?? cwd
    // -z = คั่นด้วยอักขระ NUL แทนขึ้นบรรทัดใหม่ ชื่อไฟล์ที่มีเว้นวรรค/ภาษาไทยจึงไม่เพี้ยน
    const run = await $.process.run(['git', 'status', '--porcelain=v1', '-b', '-z'], { cwd })
    if (run.exitCode !== 0) return { folder, isRepo: false, branch: '', changed: 0, ahead: 0, behind: 0, files: [] }
    const [head = '', ...parts] = run.stdout.split('\0')
    // บรรทัดแรกหน้าตา: "## main...origin/main [ahead 2, behind 1]"
    const branch = head.replace(/^## /, '').split('...')[0]?.replace(/^No commits yet on /, '') ?? ''

    // แต่ละรายการ: "XY path" (XY = สถานะ เช่น " M", "??", "A ") — ถ้าเป็น rename/copy ตามด้วยชื่อเดิมอีกช่อง ให้ข้าม
    const entries: { xy: string; path: string }[] = []
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i] ?? ''
      if (entry === '') continue
      const xy = entry.slice(0, 2)
      entries.push({ xy, path: entry.slice(3) })
      if (xy.includes('R') || xy.includes('C')) i++
    }

    // path ของ git สัมพันธ์กับรากของ repo (ไม่ใช่โฟลเดอร์ที่เปิดอยู่เสมอไป)
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
    const root = top.exitCode === 0 && top.stdout.trim() !== '' ? top.stdout.trim() : cwd

    // เวลาแก้ไฟล์ล่าสุด (ไฟล์ที่ถูกลบไม่มีไฟล์ให้ดู → ไว้ท้าย)
    const withTime = await Promise.all(
      entries.map(async (e, i) => ({
        ...e,
        mtime: i < MAX_STAT && !e.xy.includes('D')
          ? await $.fs.stat(`${root}/${e.path}`).then(s => s.mtimeMs, () => 0)
          : 0,
      })),
    )
    withTime.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))

    // ตัวอักษรสถานะตัวเดียว: ?=ใหม่ยังไม่ติดตาม, A=เพิ่ม, M=แก้, D=ลบ, R=เปลี่ยนชื่อ
    const code = (xy: string) => (xy === '??' ? '?' : xy[0] !== ' ' ? xy[0] : xy[1]) ?? 'M'
    const files: ChangedFile[] = withTime.slice(0, MAX_FILES).map(e => ({ path: e.path, code: code(e.xy) }))

    return {
      folder,
      isRepo: true,
      branch,
      changed: entries.length,
      ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0),
      files,
    }
  } catch {
    return null
  }
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const FETCH_EVERY_MS = 5 * 60_000 // ถาม server จริงไม่เกินทุก 5 นาที (ถี่กว่านี้โดนสั่งพัก)

// ดึงตัวเลข Usage เองด้วยการล็อกอินของ Claude Code (แผงไม่เห็นรหัสเลย ระบบใส่ให้ตอนส่ง)
// ใช้ไฟล์ cache เดียวกับ VS Code extension: ทุกแชต/ทุกหน้าต่างแชร์ผลกัน ไม่ถามซ้ำ
async function refreshUsage($: EngineInterface): Promise<void> {
  const home = await $.env.get('HOME')
  const file = `${home}/.claude/usage-cache.json`
  let raw: { data?: unknown; fetchedAt?: number; backoffUntil?: number } = {}
  try {
    raw = JSON.parse(await $.fs.read(file))
  } catch {
    // ยังไม่มีไฟล์ → ดึงครั้งแรก
  }
  const now = Date.now()
  if ((raw.backoffUntil ?? 0) > now) return
  if (raw.data && now - (raw.fetchedAt ?? 0) < FETCH_EVERY_MS - 5_000) return
  try {
    const auth = (await $.session.authorize())?.handle
    if (!auth) return // ไม่ได้ล็อกอินแบบบัญชี Claude (เช่นใช้ API key) → endpoint นี้ใช้ไม่ได้
    const res = await $.http.fetch(USAGE_URL, { auth, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
    if (res.ok) {
      await $.fs.write(file, JSON.stringify({ data: JSON.parse(res.text), fetchedAt: Date.now(), backoffUntil: 0 }))
      return
    }
    // 429 = ถามถี่ไป ทำตามเวลาที่ server บอก · error อื่นพัก 5 นาที (ไม่ยิงซ้ำทุก 30 วินาที)
    const wait = res.status === 429 ? Number(res.headers['retry-after']) || 300 : 300
    await $.fs.write(file, JSON.stringify({ ...raw, backoffUntil: Date.now() + wait * 1000 }))
  } catch {
    // เน็ตหลุด/อื่น ๆ → ใช้ตัวเลขเดิมไปก่อน รอบหน้าค่อยลองใหม่
  }
}

// อ่านไฟล์ cache แล้วแปลงเป็นข้อมูลที่แผงใช้
async function load($: EngineInterface): Promise<Usage> {
  try {
    const home = await $.env.get('HOME')
    const raw = JSON.parse(await $.fs.read(`${home}/.claude/usage-cache.json`))
    if (!raw.data) return null
    return {
      fetchedAt: raw.fetchedAt ?? 0,
      five: {
        utilization: raw.data.five_hour?.utilization ?? null,
        resets_at: raw.data.five_hour?.resets_at ?? null,
      },
      week: {
        utilization: raw.data.seven_day?.utilization ?? null,
        resets_at: raw.data.seven_day?.resets_at ?? null,
      },
      backoffUntil: raw.backoffUntil ?? 0,
    }
  } catch {
    return null
  }
}

// สี: เขียว < 50%, เหลือง < 80%, แดง ≥ 80% 
const colorOf = (v: number) => (v >= 80 ? '#EF4444' : v >= 50 ? '#FFDA00' : '#22C55E')

// วินาที → "2m 10s"
function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  return m > 0 ? `${m}m ${sec % 60}s` : `${sec}s`
}

function timeLeft(iso: string | null, now: number): string {
  if (!iso) return '-'
  const mins = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// ---- Mascot ลูกเจี๊ยบอ้วน pixel art 8-bit หันหน้าตรง ตาเป็นจุด: วาดเป็น SVG จากตารางตัวอักษร (1 ตัวอักษร = 1 พิกเซล) ----
// ตัวละครวาดเองทั้งตัว (ไม่ได้คัดลอกจากรูปสต็อก): ตัวทรงถั่วสีเหลืองสด ปีกสองข้าง ขายาว
// สี: Y ตัว, H ไฮไลต์, S เงา, A ปีก, K ตา, P ปาก, L ขา/เท้า (ส่วนที่ไม่ส่าย), C แก้ม, Z ประกาย, W เหงื่อ
const PALETTE: Record<string, string> = {
  Y: '#FFC800', H: '#FFE066', S: '#F2A900', A: '#F59E0B', K: '#111111',
  P: '#FF6A00', L: '#FF6A00', C: '#FF6B6B', Z: '#FFFFFF', W: '#3B9EFF',
}
const BASE = [
  '........................',
  '........................',
  '........HHHYYYYY........',
  '......HHHYYYYYYYYS......',
  '.....HHYYYYYYYYYYYS.....',
  '....HYYYYYYYYYYYYYYS....',
  '....HYYYKYYYYYYKYYYS....',
  '....YYYYKYYYYYYKYYYS....',
  '....YYYYYPPPPPPYYYYS....',
  '...AYYYYYYPPPPYYYYYSA...',
  '..AAYYYYYYYPPYYYYYYSAA..',
  '..AAYYYYYYYYYYYYYYYSAA..',
  '..AAYYYYYYYYYYYYYYYSAA..',
  '..AAYYYYYYYYYYYYYYYSAA..',
  '..AAYYYYYYYYYYYYYYYSAA..',
  '..AAYYYYYYYYYYYYYYYSAA..',
  '.....YYYYYYYYYYYYYS.....',
  '......SSSSSSSSSSSS......',
  '.........LL..LL.........',
  '........LLL..LLL........',
  '.......LLLL..LLLL.......',
  '........................',
  '........................',
  '........................',
]
type Pixel = [row: number, col: number, ch: string]
type Kind = 'idle' | 'working' | 'done' | 'warn' | 'tired' | 'dead'

// ตาซ้ายอยู่คอลัมน์ 8, ตาขวาคอลัมน์ 15 (แถว 6-7 สูง 2 พิกเซล), ปากอยู่แถว 8-10 กลางตัว
const EYES_CLEAR: Pixel[] = [
  [6, 8, 'Y'], [7, 8, 'Y'], [6, 15, 'Y'], [7, 15, 'Y'],
]
const OVERRIDES: Record<Kind, (frame: number) => Pixel[]> = {
  idle: () => [],
  // กำลังทำงาน: ประกายสลับมุม + ปากอ้า/หุบสลับทุกวินาที
  working: f => (f === 0 ? [[2, 1, 'Z']] : [[3, 21, 'Z'], [11, 11, 'K'], [11, 12, 'K']]),
  // งานเสร็จ: ตายิ้ม ^ ^ + ปากอ้า + ประกาย
  done: () => [
    ...EYES_CLEAR,
    [7, 7, 'K'], [6, 8, 'K'], [7, 9, 'K'],
    [7, 14, 'K'], [6, 15, 'K'], [7, 16, 'K'],
    [11, 11, 'K'], [11, 12, 'K'], [2, 1, 'Z'], [3, 21, 'Z'], [7, 22, 'Z'],
  ],
  // ตกใจ: ตาสูง 3 พิกเซล + เหงื่อ
  warn: () => [[8, 8, 'K'], [8, 15, 'K'], [3, 20, 'W'], [4, 20, 'W']],
  // ง่วง/หัวเต็ม: ตาหรี่เป็นเส้นนอน
  tired: () => [
    ...EYES_CLEAR,
    [7, 7, 'K'], [7, 8, 'K'], [7, 15, 'K'], [7, 16, 'K'],
  ],
  // หมดแรง: ตากากบาท
  dead: () => [
    ...EYES_CLEAR,
    [6, 7, 'K'], [6, 9, 'K'], [7, 8, 'K'], [8, 7, 'K'], [8, 9, 'K'],
    [6, 14, 'K'], [6, 16, 'K'], [7, 15, 'K'], [8, 14, 'K'], [8, 16, 'K'],
  ],
}

// การส่ายตัว (translate หน่วยเป็นพิกเซล, calcMode discrete ให้เป็นก้าวเหมือนเกม 8-bit)
const WIGGLE: Record<Kind, { values: string; dur: string } | null> = {
  idle: { values: '-1 0;0 0;1 0;0 0', dur: '1.4s' },
  working: { values: '-1 0;0 0;1 0;0 0', dur: '0.6s' },
  done: { values: '0 0;0 -1;0 0', dur: '0.5s' },
  warn: { values: '-1 0;1 0', dur: '0.2s' },
  tired: null,
  dead: null,
}

function spriteSvg(kind: Kind, frame: number): string {
  const grid = BASE.map(row => row.split(''))
  for (const [r, c, ch] of OVERRIDES[kind](frame)) {
    const line = grid[r]
    if (line) line[c] = ch
  }
  // แยกเป็น 2 ส่วน: ตัว (ส่าย) กับเท้า L (อยู่กับที่)
  const draw = (isFeet: boolean) =>
    grid
      .flatMap((line, r) =>
        line.map((ch, c) =>
          PALETTE[ch] && (ch === 'L') === isFeet
            ? `<rect x="${c}" y="${r}" width="1" height="1" fill="${PALETTE[ch]}"/>`
            : '',
        ),
      )
      .join('')
  const w = WIGGLE[kind]
  const anim = w
    ? `<animateTransform attributeName="transform" type="translate" values="${w.values}" dur="${w.dur}" repeatCount="indefinite" calcMode="discrete"/>`
    : ''
  // viewBox เผื่อขอบ 1 พิกเซลรอบตัว กันตัวโดนตัดตอนส่าย (สูง 23 เพราะเท้าจบที่แถว 20)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 26 23" shape-rendering="crispEdges"><g>${anim}${draw(false)}</g>${draw(true)}</svg>`
}

export const register: Register = on => {
  // แถบ progress ขอบมน: วาดเป็น SVG กว้าง 600 หน่วย แผงจะย่อลงพอดีความกว้าง (ความสูงย่อตามสัดส่วน)
  // terminal ไม่มี Svg → ใช้แถบกล่องสีแบบเดิม
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bar = (Box: any, pct: number, color: string, Svg?: any) => {
    const p = Math.min(100, Math.max(0, pct))
    if (Svg) {
      const w = p === 0 ? 0 : Math.max(16, p * 6) // ส่วนที่เติมต้องกว้างกว่าความโค้ง ไม่งั้นเป็นจุดเบี้ยว
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="16" viewBox="0 0 600 16"><rect width="600" height="16" rx="8" fill="#334155"/><rect width="${w}" height="16" rx="8" fill="${color}"/></svg>`
      return <Svg source={svg} alt={`${Math.round(p)}%`} />
    }
    return (
      <Box width="100%" height={1} backgroundColor="#334155">
        <Box width={`${p}%`} height={1} backgroundColor={color} />
      </Box>
    )
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-pane',
      description: 'Open the Claude Code Panel (usage limits, git, task progress)',
    })
    void $.ui.open({ id: PANE, title: 'Claude Code Panel' })

    // อ่านไฟล์ใหม่ทุก 30 วินาที (อ่านจากไฟล์ในเครื่อง ไม่เรียก server)
    $.clock.every(REFRESH_MS, async () => {
      await refreshUsage($)
      const fresh = await load($)
      await update($, usage, () => fresh)
      const ws = await loadWorkspace($)
      await update($, workspace, () => ws)
      const ctx = await loadContext($)
      await update($, context, () => ctx)
    })

    // ระหว่างที่ Claude กำลังทำงาน ขยับนาฬิกาทุกวินาที (ไม่ทำงานตอนว่าง จึงไม่วาดแผงซ้ำเปล่า ๆ)
    $.clock.every(1000, async () => {
      const t = await read($, turn)
      if (t.startedAt !== null) await update($, turn, old => ({ ...old, now: Date.now() }))
    })
    await refreshUsage($)
    const first = await load($)
    await update($, usage, () => first)
    const firstWs = await loadWorkspace($)
    await update($, workspace, () => firstWs)
    const firstCtx = await loadContext($)
    await update($, context, () => firstCtx)

    return next(e)
  })

  // ผู้ใช้ส่งข้อความ → เริ่มจับเวลาเทิร์นนี้
  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, turn, old => ({ ...old, startedAt: now, now }))
    return next(e)
  })

  // จบทุกเทิร์น (Claude อาจเพิ่งแก้ไฟล์) → หยุดจับเวลา + อ่าน git กับ context ใหม่ทันที
  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, turn, old => ({
      startedAt: null,
      now,
      lastSeconds: old.startedAt === null ? old.lastSeconds : Math.round((now - old.startedAt) / 1000),
    }))
    const ws = await loadWorkspace($)
    await update($, workspace, () => ws)
    const ctx = await loadContext($)
    await update($, context, () => ctx)
    return next(e)
  })

  // Claude อัปเดตเช็กลิสต์ทีไร เก็บรายการล่าสุดไว้ให้แผงวาด
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const list: Todo[] = e.todos
    await update($, todos, () => list)
    return next(e)
  })

  on('command.run', { command: 'usage-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Claude Code Panel' })
    return { text: 'Claude Code Panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // Svg มีบน VS Code/Desktop/มือถือ แต่ไม่มีบน terminal → ที่นั่นใช้หน้าตัวอักษรแทน
    const Svg = 'Svg' in ui ? ui.Svg : null
    const data = await read($, usage)
    const list = await read($, todos)
    const ws = await read($, workspace)
    const ctx = await read($, context)
    const showAllFiles = await read($, gitExpanded)
    const t = await read($, turn)
    const now = await $.clock.now()
    const done = list.filter(t => t.status === 'completed').length

    // ---- ระบบดีไซน์ของแผง: ทุกกลุ่มเป็นการ์ดกรอบมนแบบเดียวกัน (หัวการ์ดตัวพิมพ์ใหญ่จาง + ค่าชิดขวา) ----
    // สีจากชุดสีที่ UI UX Pro Max แนะนำ (โทนมืดเทาน้ำเงิน) · สีสดอยู่ที่แถบและสถานะเท่านั้น
    const TEXT = '#FFFFFF' // ตัวหลักสีขาว
    const MUTED = '#9CA3AF' // ตัวรองสีเทา
    const BORDER = '#FFFFFF59' // ขาวโปร่ง 35%: แผงตั้งความหนาเส้นไม่ได้ ใช้ความจางทำให้ดูบางแทน
    const WARN = '#FFDA00'
    const OK = '#22C55E'
    const clamp = (v: number | null) => Math.min(100, Math.max(0, v ?? 0))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const label = (text: string, right?: any) => (
      <Box width="100%" justifyContent="space-between">
        <Text color={TEXT} bold>{text.toUpperCase()}</Text>
        {right ?? null}
      </Box>
    )
    // การ์ด: ไม่กำหนดความกว้างเอง ให้ยืดตามแผง (ใส่ width 100% + กรอบแล้วล้นขอบขวา)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const card = (title: string, right: any, body: any) => (
      <Box flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={2} paddingY={1} marginBottom={1}>
        {label(title, right)}
        {body}
      </Box>
    )
    // มิเตอร์: ชื่อ + ข้อความรองจาง / % ชิดขวา / แถบสี
    const meter = (name: string, sub: string, v: number, color: string) => (
      <Box flexDirection="column" width="100%" marginTop={1}>
        <Box width="100%" justifyContent="space-between">
          <Text>
            <Text bold color={TEXT}>{name}</Text>
            <Text color={MUTED}> · {sub}</Text>
          </Text>
          <Text bold color={TEXT}>{Math.round(v)}%</Text>
        </Box>
        {bar(Box, v, color, Svg)}
      </Box>
    )

    // Context ของแชต: แถบสีฟ้า (เตือนข้อความเมื่อ ≥ 80%)
    const contextMeter = ctx
      ? meter(
          'Context',
          `${Math.round(ctx.tokens / 1000)}k / ${Math.round(ctx.window / 1000)}k${ctx.percent >= 80 ? ' · new chat?' : ''}`,
          ctx.percent,
          '#3B9EFF',
        )
      : null

    // ---- การ์ด USAGE (บนสุดเสมอ): หัวการ์ดบอกว่าตัวเลขอัปเดตเมื่อไหร่ ----
    const ageMin = data ? Math.round((now - data.fetchedAt) / 60000) : 0
    const isStale = data !== null && (ageMin >= 10 || data.backoffUntil > now)
    const usageBlock = card(
      'Usage',
      data ? <Text color={isStale ? WARN : MUTED}>{ageMin < 1 ? 'just now' : `${ageMin}m ago`}</Text> : null,
      data ? (
        <Box flexDirection="column" width="100%">
          {meter('5-hour', timeLeft(data.five.resets_at, now), clamp(data.five.utilization), colorOf(clamp(data.five.utilization)))}
          {meter('Weekly', timeLeft(data.week.resets_at, now), clamp(data.week.utilization), colorOf(clamp(data.week.utilization)))}
          {contextMeter}
          {data.backoffUntil > now ? <Text color={WARN}>Server asked to wait</Text> : null}
        </Box>
      ) : (
        <Box flexDirection="column" width="100%">
          <Text color={MUTED}>No usage data yet. It needs a Claude account login (not an API key); numbers refresh every 5 min.</Text>
          {contextMeter}
        </Box>
      ),
    )

    // ---- การ์ด WORKSPACE: ชื่อโฟลเดอร์ + สาขา · จำนวนไฟล์เปลี่ยนอยู่หัวการ์ด ----
    const working = t.startedAt !== null
    const sync = ws && ws.isRepo ? [ws.ahead > 0 ? `↑${ws.ahead}` : '', ws.behind > 0 ? `↓${ws.behind}` : ''].filter(Boolean).join(' ') : ''
    const statusBlock = card(
      'Workspace',
      ws && ws.isRepo ? <Text bold color={ws.changed > 0 ? WARN : OK}>{ws.changed > 0 ? `${ws.changed} changed` : 'Clean ✓'}</Text> : null,
      <Box flexDirection="column" width="100%" marginTop={1}>
        <Text bold color={TEXT}>{ws ? ws.folder : '…'}</Text>
        {ws && !ws.isRepo ? <Text color={MUTED}>Not a git repo</Text> : null}
        {ws && ws.isRepo ? <Text color={MUTED}>on {ws.branch}{sync !== '' ? `  ${sync}` : ''}</Text> : null}
      </Box>,
    )

    // ---- การ์ด TASK PROGRESS (✓ เสร็จจาง / ▶ กำลังทำ / ○ รอ) ----
    const isAllDone = list.length > 0 && done === list.length
    const tasksBlock = card(
      'Task Progress',
      list.length > 0 ? <Text bold color={TEXT}>{done}/{list.length}</Text> : null,
      list.length === 0 ? (
        <Text color={MUTED}>No to-do list</Text>
      ) : (
        <Box flexDirection="column" width="100%">
          <Box marginY={1}>{bar(Box, (done / list.length) * 100, OK, Svg)}</Box>
          {list.map(item => (
            <Text
              color={item.status === 'completed' ? MUTED : TEXT}
              bold={item.status === 'in_progress'}
            >
              {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▶' : '○'}{' '}
              {item.status === 'in_progress' ? item.activeForm : item.content}
            </Text>
          ))}
        </Box>
      ),
    )

    // ---- Mascot (ล่างสุด กึ่งกลาง): ข้อความใต้ตัวรวมเวลาเทิร์นไว้ที่เดียว ----
    // อารมณ์เรียงตามความสำคัญ: โควต้าใกล้หมด > context เต็ม > กำลังทำงาน > งานครบ > ว่าง
    const worst = data ? Math.max(data.five.utilization ?? 0, data.week.utilization ?? 0) : 0
    const frame = Math.floor(t.now / 1000) % 2 // สลับท่าทุกวินาทีตอนทำงาน
    const elapsed = fmtDuration(Math.max(0, Math.round((t.now - (t.startedAt ?? t.now)) / 1000)))
    const mood: { kind: Kind; face: string; note: string; color: string } =
      worst >= 90 ? { kind: 'dead', face: '(×_×)', note: 'running on fumes', color: '#E63B2E' }
      : worst >= 80 ? { kind: 'warn', face: '(°□°)', note: 'limit is close!', color: WARN }
      : ctx && ctx.percent >= 80 ? { kind: 'tired', face: '(@_@)', note: 'head is getting full', color: WARN }
      : working ? { kind: 'working', face: frame === 0 ? '(ง •̀_•́)ง' : '(ง •̀o•́)ง', note: `on it... ${elapsed}`, color: WARN }
      : isAllDone ? { kind: 'done', face: '\\(^o^)/', note: 'all tasks done!', color: OK }
      : { kind: 'idle', face: '(•‿•)', note: 'ready', color: '#3B9EFF' }

    const fun = (
      <Box flexDirection="column" width="100%" alignItems="center" marginBottom={1}>
        {Svg === null ? (
          <Text bold color={mood.color}>{mood.face}</Text>
        ) : (
          <Svg source={spriteSvg(mood.kind, frame)} alt={`Mascot: ${mood.note}`} width={96} isInteractive />
        )}
        <Text color={MUTED}>{mood.note}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
        {usageBlock}
        {statusBlock}
        {/* ดันลูกเจี๊ยบ + การ์ดงานลงไปชิดล่าง ใช้ที่ว่างตรงกลางให้ไม่โล่ง */}
        <Box flexGrow={1} />
        {fun}
        {tasksBlock}
      </Box>
    )
  })
}
