// ไฟล์นี้คือตัว extension ทั้งหมด
// หน้าที่: ดึง Usage limit ของ Claude (รอบ 5 ชม. + รอบสัปดาห์) แล้วโชว์ที่แถบล่าง (status bar) ของ VS Code
// วิธีทำงาน: อ่าน "บัตรผ่าน" (token) ที่ Claude Code เก็บไว้ใน Keychain ของ Mac
//            → เอาไปถาม server ของ Anthropic ที่เดียวกับคำสั่ง /usage → โชว์ตัวเลข
// server นี้ให้ถามได้ไม่บ่อย → ผลลัพธ์จะถูกจดไว้ในไฟล์กลาง (cache) ให้ทุกหน้าต่าง VS Code ใช้ร่วมกัน
// ⚠️ endpoint นี้ไม่ใช่ API ทางการ — ถ้าวันหนึ่ง Anthropic เปลี่ยน อาจต้องแก้ไฟล์นี้

const vscode = require('vscode');
const { execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// ไฟล์กลางที่ทุกหน้าต่างอ่าน/เขียนร่วมกัน: { fetchedAt, data, backoffUntil }
// เก็บใน ~/.claude เพื่อให้ Mod "usage-pane" (แผงในหน้า Claude Code) อ่านไฟล์เดียวกันได้
const CACHE_FILE = path.join(os.homedir(), '.claude', 'usage-cache.json');

let statusItem;
let timer;
let log; // หน้าต่าง Output "Claude Usage" ไว้ดูสาเหตุเวลามีปัญหา
let fetching = false; // กันไม่ให้ถามซ้อนกันในหน้าต่างเดียว

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(patch) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...readCache(), ...patch }));
  } catch (err) {
    log.appendLine(`เขียน cache ไม่ได้: ${err.message}`);
  }
}

// อ่าน token จาก Keychain (ที่เดียวกับที่ Claude Code ใช้ login)
// ใช้ path เต็ม /usr/bin/security เพราะ VS Code ที่เปิดจาก Dock อาจหาคำสั่งไม่เจอ
function readToken() {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], (err, stdout, stderr) => {
      if (err) return reject(new Error(`อ่าน Keychain ไม่ได้ (${(stderr || err.message).trim()})`));
      try {
        resolve(JSON.parse(stdout).claudeAiOauth.accessToken);
      } catch {
        reject(new Error('อ่านข้อมูล login ไม่ออก'));
      }
    });
  });
}

// ส่งคำขอ GET แบบพื้นฐาน (ใช้ https ของ Node แทน fetch เพื่อให้ทำงานได้ทุกเวอร์ชันของ VS Code)
function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error('หมดเวลารอ server')));
    req.on('error', reject);
  });
}

// ถาม server ว่าตอนนี้ใช้ไปกี่ %
async function fetchUsage() {
  const token = await readToken();
  const res = await httpGet(USAGE_URL, {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'Content-Type': 'application/json',
  });
  // 401 = token หมดอายุ → ปกติ Claude Code จะต่ออายุให้เองเมื่อเปิดใช้งาน
  if (res.status === 401) throw new Error('Login หมดอายุ — เปิด Claude Code ใช้สักครั้งแล้วจะกลับมาเอง');
  // 429 = ถามถี่เกินไป → จดเวลาพักลง cache ให้ทุกหน้าต่างรู้ (ถ้า server ไม่บอก พัก 5 นาที)
  if (res.status === 429) {
    const wait = Number(res.headers['retry-after']) || 300;
    writeCache({ backoffUntil: Date.now() + wait * 1000 });
    throw new Error(`Server ขอให้รอ ${Math.ceil(wait / 60)} นาที (ถามถี่เกินไป)`);
  }
  if (res.status !== 200) throw new Error(`Server ตอบกลับ ${res.status}: ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body);
}

// แปลงเวลารีเซ็ตเป็นข้อความอ่านง่าย เช่น "อีก 2 ชม. 15 นาที"
function timeLeft(iso) {
  if (!iso) return '-';
  const mins = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `อีก ${d} วัน ${h} ชม.`;
  if (h > 0) return `อีก ${h} ชม. ${m} นาที`;
  return `อีก ${m} นาที`;
}

function pct(v) {
  return v == null ? '-' : `${Math.round(v)}%`;
}

// สีตามระดับการใช้: เขียว < 50%, เหลือง < 80%, แดง ≥ 80%
function levelColor(v) {
  return v >= 80 ? '#E63B2E' : v >= 50 ? '#FFDA00' : '#3FB950';
}

// วาดแถบ progress ด้วยตัวอักษรบล็อก เช่น ████████░░░░░░░░ (20 ช่อง)
function bar(v) {
  const filled = Math.round(Math.min(100, Math.max(0, v || 0)) / 5);
  return `<span style="color:${levelColor(v || 0)};">${'█'.repeat(filled)}</span>` +
    `<span style="color:#555555;">${'█'.repeat(20 - filled)}</span>`;
}

// หนึ่งบล็อกในกล่อง: หัวข้อ + แถบ + % + เวลารีเซ็ต
function section(label, w) {
  return `**${label}** &nbsp; ${pct(w.utilization)}\n\n` +
    `${bar(w.utilization)}\n\n` +
    `<span style="color:#888888;">รีเซ็ต${timeLeft(w.resets_at)}</span>\n\n`;
}

// วาดตัวเลขลงแถบล่าง จากข้อมูลล่าสุดที่มี (note = ข้อความเสริม เช่น "server ขอให้รอ")
function render(data, fetchedAt, note) {
  const five = data.five_hour || {};
  const week = data.seven_day || {};

  // ข้อความที่แถบล่าง เช่น "✨ 5h 6% · 7d 36%"
  statusItem.text = `$(sparkle) 5h ${pct(five.utilization)} · 7d ${pct(week.utilization)}`;

  // กล่องรายละเอียดตอนเอาเมาส์ชี้
  const md = new vscode.MarkdownString();
  md.supportHtml = true; // เปิดให้ใช้สีในกล่องได้
  md.appendMarkdown(`### Claude Usage Limit\n\n`);
  md.appendMarkdown(section('รอบ 5 ชั่วโมง', five));
  md.appendMarkdown(section('รอบ 7 วัน', week));
  if (data.seven_day_opus) md.appendMarkdown(section('รอบ 7 วัน (Opus)', data.seven_day_opus));
  md.appendMarkdown(`---\n\n<span style="color:#888888;">ข้อมูลเมื่อ ${new Date(fetchedAt).toLocaleTimeString('th-TH')} · คลิกเพื่อรีเฟรช</span>`);
  if (note) md.appendMarkdown(`\n\n⏳ ${note}`);
  statusItem.tooltip = md;

  // เปลี่ยนสีพื้นหลังเมื่อใกล้เต็ม: ≥80% เหลือง, ≥95% แดง
  const worst = Math.max(five.utilization || 0, week.utilization || 0);
  statusItem.backgroundColor =
    worst >= 95 ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : worst >= 80 ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
}

// โชว์ error — ถ้ามีตัวเลขเก่าอยู่ ให้โชว์ตัวเลขเก่าไปก่อน แทนที่จะขึ้น ⚠
function renderError(message) {
  const cache = readCache();
  if (cache.data) return render(cache.data, cache.fetchedAt, message);
  statusItem.text = '$(warning) Claude usage';
  statusItem.tooltip = `ดึงข้อมูลไม่ได้: ${message}\n\nคลิกเพื่อลองใหม่`;
  statusItem.backgroundColor = undefined;
}

async function refresh(manual) {
  const secs = vscode.workspace.getConfiguration('claudeUsage').get('refreshSeconds', 300);
  const cache = readCache();
  const now = Date.now();

  // server สั่งพักอยู่ → ใช้ตัวเลขเก่า ไม่ถามซ้ำ (แม้จะกดเองก็ไม่ถาม เพื่อไม่ให้โดนพักนานขึ้น)
  if (cache.backoffUntil && now < cache.backoffUntil) {
    const mins = Math.ceil((cache.backoffUntil - now) / 60000);
    return renderError(`Server ขอให้รออีก ~${mins} นาที แล้วจะอัปเดตเอง`);
  }
  // มีหน้าต่างอื่นเพิ่งถามไป → ใช้ผลนั้นเลย (กดเองจะยอมถามใหม่ถ้าเกิน 30 วินาที)
  const freshFor = manual ? 30 : secs - 5;
  if (cache.data && now - cache.fetchedAt < freshFor * 1000) {
    return render(cache.data, cache.fetchedAt);
  }

  if (fetching) return;
  fetching = true;
  try {
    const data = await fetchUsage();
    writeCache({ data, fetchedAt: Date.now(), backoffUntil: 0 });
    render(data, Date.now());
    log.appendLine(`[${new Date().toLocaleTimeString()}] OK 5h=${data.five_hour?.utilization} 7d=${data.seven_day?.utilization}`);
  } catch (err) {
    log.appendLine(`[${new Date().toLocaleTimeString()}] ERROR ${err.message}`);
    renderError(err.message);
  } finally {
    fetching = false;
  }
}

// ตั้งเวลาเช็กทุก 1 นาที — แต่จะถาม server จริงเฉพาะตอน cache เก่าเกินที่ตั้งไว้
function startTimer() {
  clearInterval(timer);
  timer = setInterval(() => refresh(false), 60 * 1000);
}

// VS Code เรียกฟังก์ชันนี้ตอนเปิดโปรแกรม
function activate(context) {
  log = vscode.window.createOutputChannel('Claude Usage');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'claudeUsage.refresh';
  statusItem.text = '$(sync~spin) Claude usage';
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    log,
    vscode.commands.registerCommand('claudeUsage.refresh', () => refresh(true)),
    { dispose: () => clearInterval(timer) }
  );

  refresh(false);
  startTimer();
}

function deactivate() {}

module.exports = { activate, deactivate };
