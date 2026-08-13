/**
 * Yunsci — Multi-user server
 *
 * Features:
 *   - User registration & login (password hashed with PBKDF2)
 *   - Auth tokens for WebSocket / REST access
 *   - Per-user independent Claude Code sessions (--resume)
 *   - File upload / listing
 *   - SQLite persistence (sql.js)
 *   - Works behind Nginx reverse proxy
 *
 * Usage:
 *   SECRET=change-me PORT=3456 node server.js
 *   (default SECRET=dev-only-change-in-production)
 */

const express = require('express');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const initSqlJs = require('sql.js');

// ─── Configuration ───────────────────────────────────────────────────────────
const PORT      = parseInt(process.env.PORT, 10) || 3456;
const SECRET    = process.env.SECRET || 'dev-only-change-in-production';
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';

// ─── Skill → Progress mapping (for single-cell & general bioinfo pipelines) ──
// 进度单调递增；多个 Skill 触发时取较大值，避免重复触发达不到下一步
const SKILL_PROGRESS = [
  // 数据输入
  { match: /bio-single-cell-data-io|sa\.scanpy|sa\.anndata/, percent: 10, step: '加载数据 / 格式转换' },
  // 预处理
  { match: /bio-single-cell-preprocessing|sa\.bulk-rnaseq/,      percent: 20, step: 'QC + 过滤 / 归一化' },
  // 去双胞
  { match: /bio-single-cell-doublet-detection/,                  percent: 30, step: '去双胞检测' },
  // 整合 / 降维
  { match: /bio-single-cell-batch-integration|sa\.scvi-tools|cs\.scvi-tools/, percent: 45, step: '样本整合 / 批次校正' },
  // 聚类
  { match: /bio-single-cell-clustering/,                          percent: 55, step: '聚类 / UMAP 可视化' },
  // Marker
  { match: /bio-single-cell-markers-annotation/,                  percent: 65, step: 'Marker 基因识别' },
  // 细胞类型注释
  { match: /bio-single-cell-cell-annotation|scrna-cell-type-annotator/, percent: 75, step: '细胞类型注释' },
  // 轨迹 / 拟时序
  { match: /bio-single-cell-trajectory-injection|bio-single-cell-trajectory-inference/, percent: 85, step: '轨迹 / 拟时序分析' },
  // 通讯
  { match: /bio-single-cell-cell-communication|bio-single-cell-metabolite-communication/, percent: 95, step: '细胞通讯 / 代谢通讯' },
  // 出图与完成
  { match: /sa\.scientific-visualization|sa\.matplotlib|sa\.seaborn|sa\.scientific-slides/, percent: 98, step: '结果可视化' },
  // 多组学 / scATAC
  { match: /bio-single-cell-scatac-analysis|bio-single-cell-multimodal-integration/, percent: 70, step: '多组学分析' },
  { match: /bio-single-cell-lineage-tracing|bio-single-cell-perturb-seq/, percent: 80, step: '谱系 / 扰动分析' },
  // 差异表达 / 富集（bulk RNA-seq 主力）
  { match: /sa\.pydeseq2|sa\.pathway-enrichment/,                 percent: 60, step: '差异表达 / 通路富集' },
  // 文献调研
  { match: /sa\.literature-review|sa\.paper-lookup|sa\.citation-management|research-lookup|database-lookup/, percent: 35, step: '文献检索 / 综述' },
  // 写作
  { match: /scientific-writing|scientific-brainstorming|hypothesis-generation|ns\.nature-writing|ns\.nature-polishing|ns\.nature-response/, percent: 90, step: '论文撰写 / 润色' },
  // 基金
  { match: /research-grants|ns\.nature-proposal-writer/,          percent: 90, step: '基金 / 标书撰写' },
];

function getProgressForTool(toolName, input, progress) {
  const name = (toolName || '').toLowerCase();
  const text = (name + ' ' + JSON.stringify(input || {})).toLowerCase();
  // 1) 先匹配精确的 Skill 关键词
  for (const m of SKILL_PROGRESS) {
    if (m.match.test(text)) return { percent: m.percent, step: m.step };
  }
  // 2) Bash 工具：识别 R/Python/分析脚本（含内联 -c、heredoc）
  if (name === 'bash' || name === 'command') {
    if (/python[23]?\s|rscript\s|^r\s|conda\s|seurat|monocle[23]?|scanpy|clusterp|deseq2|edgeR|limma|fgsea|gsea|h5py|numpy|scipy|pandas|matplotlib/.test(text)) {
      return { percent: 50, step: '运行分析脚本' };
    }
    if (/install|download|fetch|curl|wget|tar\s|unzip|git\s|pip\s|apt\s/.test(text)) {
      return { percent: 35, step: '安装/下载依赖' };
    }
    if (/cp\s|mv\s|chmod|chown|mkdir|sed\s|rm\s/.test(text)) {
      return { percent: 80, step: '整理输出文件' };
    }
    // 任何其他 Bash 命令（ls/cat/find/grep/echo 等）→ 25%
    return { percent: Math.max(25, progress.percent + 5), step: '执行命令' };
  }
  // 3) Write/Edit：写文件 → 70%
  if (name === 'write' || name === 'edit' || name === 'multiedit' || name === 'notebookedit') {
    return { percent: 70, step: '生成结果文件' };
  }
  // 4) Read 数据文件 → 15%
  if (name === 'read' || name === 'glob' || name === 'grep') {
    if (/upload|\.h5$|\.csv$|\.tsv$|\.txt$|\.json$|\.fasta|\.fastq|\.bam|\.vcf|\.r$|\.py$|\.R$|\.pdf|\.docx|\.xlsx/.test(text)) {
      return { percent: 15, step: '读取数据' };
    }
    // 读其他文件 → 20%
    return { percent: Math.max(20, progress.percent + 3), step: '读取信息' };
  }
  // 5) 兜底：任何工具调用 → progress+3
  return { percent: Math.min(45, progress.percent + 3), step: '准备中' };
}

// 从 R/Python 子进程输出解析 [N/M] 格式进度
function parseSubProgress(text) {
  const m = text.match(/\[(\d+)\s*\/\s*(\d+)\]/);
  if (!m) return null;
  const cur = parseInt(m[1]), total = parseInt(m[2]);
  if (total <= 0 || cur <= 0) return null;
  // 映射到 50-95% 区间（脚本执行阶段）
  const pct = 50 + Math.min(45, Math.round((cur / total) * 45));
  return { percent: pct, step: `执行分析 ${cur}/${total}` };
}

// 进度条用的辅助符号
function progressBar(p, w = 12) {
  const filled = Math.round((p / 100) * w);
  return '█'.repeat(filled) + '░'.repeat(w - filled);
}
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_PATH   = path.join(__dirname, 'data', 'claude-webui.db');
const TOKEN_TTL_DAYS = 30;

// ─── Ensure directories ──────────────────────────────────────────────────────
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ─── Database (sql.js) ───────────────────────────────────────────────────────
let db;

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS auth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT 'New Chat',
    session_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  saveDb();
}

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// ─── Password helpers ────────────────────────────────────────────────────────
const HASH_ITERATIONS = 100000;
const HASH_KEYLEN = 64;

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_KEYLEN, 'sha512').toString('hex');
}

function createUser(username, password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = hashPassword(password, salt);

  try {
    db.run('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)',
           [username, hash, salt]);
    saveDb();

    // Create user's output directory
    const userDir = path.join(USERS_OUTPUT_DIR, username);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    return { success: true };
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return { success: false, error: 'Username already exists' };
    }
    return { success: false, error: e.message };
  }
}

function verifyUser(username, password) {
  const rows = db.exec('SELECT id, password_hash, salt FROM users WHERE username = ?', [username]);
  if (!rows.length || !rows[0].values.length) return null;

  const [id, storedHash, salt] = rows[0].values[0];
  const hash = hashPassword(password, salt);
  if (hash !== storedHash) return null;

  // Update last_login
  db.run('UPDATE users SET last_login = datetime(?) WHERE id = ?', [new Date().toISOString(), id]);
  saveDb();

  return { id, username };
}

function createAuthToken(userId) {
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.run('INSERT INTO auth_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
         [userId, token, expiresAt]);
  saveDb();
  return token;
}

function validateAuthToken(token) {
  const rows = db.exec(
    'SELECT u.id, u.username, u.session_id, a.expires_at FROM auth_tokens a JOIN users u ON a.user_id = u.id WHERE a.token = ?',
    [token]
  );
  if (!rows.length || !rows[0].values.length) return null;
  const [userId, username, sessionId, expiresAt] = rows[0].values[0];
  if (new Date(expiresAt) < new Date()) return null; // expired
  return { userId, username, sessionId: sessionId || null };
}

function updateUserSessionId(userId, sessionId) {
  db.run('UPDATE users SET session_id = ? WHERE id = ?', [sessionId, userId]);
  saveDb();
}

function revokeAuthToken(token) {
  db.run('DELETE FROM auth_tokens WHERE token = ?', [token]);
  saveDb();
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '110mb' }));
app.use(express.urlencoded({ extended: true, limit: '110mb' }));

// ─── Auth middleware ─────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const user = validateAuthToken(auth.slice(7));
  if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = user;
  next();
}

// ─── API: Auth ───────────────────────────────────────────────────────────────

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (username.length < 2 || username.length > 32) {
    return res.status(400).json({ error: 'Username must be 2-32 characters' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores' });
  }

  const result = createUser(username, password);
  if (!result.success) {
    return res.status(409).json({ error: result.error });
  }

  // Auto-login after register
  const user = verifyUser(username, password);
  if (!user) return res.status(500).json({ error: 'Registration succeeded but login failed' });

  const token = createAuthToken(user.id);
  res.json({ success: true, token, username: user.username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = verifyUser(username, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = createAuthToken(user.id);
  res.json({ success: true, token, username: user.username });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const auth = req.headers['authorization'] || '';
  revokeAuthToken(auth.slice(7));
  res.json({ success: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── API: Files (authenticated) ──────────────────────────────────────────────

app.post('/api/upload', authMiddleware, (req, res) => {
  const { filename, content } = req.body;
  if (!filename || !content) return res.status(400).json({ error: 'filename and content required' });
  const safe = path.basename(filename);
  const uploadDir = path.join(USERS_OUTPUT_DIR, req.user.username, 'uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(uploadDir, safe), Buffer.from(content, 'base64'));
    const stat = fs.statSync(path.join(uploadDir, safe));
    res.json({ success: true, path: path.join(uploadDir, safe), size: stat.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── VPN / Mihomo Control API ──────────────────────────────────────────────────
const MIHOMO_API = 'http://127.0.0.1:9090';
let activeVpnNode = null;
let vpnEnabled = false; // 真正控制 Claude 是否走代理

async function ensureMihomoRunning() {
  try { require('child_process').execSync('systemctl is-active mihomo', { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}

async function getMihomoGroups() {
  try {
    const r = await fetch(MIHOMO_API + '/proxies');
    if (!r.ok) return [];
    const d = await r.json();
    return Object.entries(d.proxies || {})
      .filter(([n, p]) => p.type === 'Selector' || p.type === 'url-test')
      .map(([n]) => n);
  } catch (e) { return []; }
}

async function getMihomoCurrent(group) {
  try {
    const r = await fetch(`${MIHOMO_API}/proxies/${encodeURIComponent(group)}`);
    if (!r.ok) return null;
    const d = await r.json();
    return d.now || null;
  } catch (e) { return null; }
}

async function selectMihomoNode(group, name) {
  const r = await fetch(`${MIHOMO_API}/proxies/${encodeURIComponent(group)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return r.ok;
}

app.get('/api/vpn/nodes', authMiddleware, async (req, res) => {
  const groups = await getMihomoGroups();
  const result = { active: null, nodes: [] };
  if (!groups.length) return res.json(result);
  result.active = await getMihomoCurrent(groups[0]) || activeVpnNode;
  // List proxy servers
  try {
    const r = await fetch(MIHOMO_API + '/proxies');
    const d = await r.json();
    for (const [name, info] of Object.entries(d.proxies || {})) {
      if (info.type === 'Selector' || info.type === 'url-test') {
        const all = info.all || [];
        for (const node of all) result.nodes.push({ name: node, group: name });
      }
    }
    if (!result.active && result.nodes.length) result.active = result.nodes[0].name;
  } catch (e) {}
  res.json(result);
});

app.post('/api/vpn/node', authMiddleware, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const groups = await getMihomoGroups();
  let success = false;
  for (const g of groups) {
    if (await selectMihomoNode(g, name)) { success = true; break; }
  }
  if (success) {
    activeVpnNode = name;
    return res.json({ success: true, node: name });
  }
  res.status(500).json({ error: 'Failed to switch node' });
});

app.post('/api/vpn/on', authMiddleware, (req, res) => {
  vpnEnabled = true;
  res.json({ success: true, enabled: true });
});

app.post('/api/vpn/off', authMiddleware, (req, res) => {
  vpnEnabled = false;
  activeVpnNode = null;
  res.json({ success: true, enabled: false });
});

app.get('/api/vpn/status', authMiddleware, (req, res) => {
  res.json({ enabled: vpnEnabled, active: activeVpnNode });
});

// ─── Create folder API ──────────────────────────────────────────────────────────
app.post('/api/folder', authMiddleware, (req, res) => {
  const { path: folderPath } = req.body || {};
  if (!folderPath) return res.status(400).json({ error: 'path required' });
  const userDir = path.resolve(path.join(USERS_OUTPUT_DIR, req.user.username));
  const target = path.resolve(path.join(userDir, folderPath));
  if (!target.startsWith(userDir)) return res.status(403).json({ error: 'Access denied' });
  try {
    fs.mkdirSync(target, { recursive: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Move file/folder API ───────────────────────────────────────────────────────
app.post('/api/move', authMiddleware, (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const userDir = path.resolve(path.join(USERS_OUTPUT_DIR, req.user.username));
  const src = path.resolve(path.join(userDir, from));
  const dst = path.resolve(path.join(userDir, to));
  if (!src.startsWith(userDir) || !dst.startsWith(userDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'Source not found' });
  try {
    // If dst is a directory, move inside it
    let finalDst = dst;
    if (fs.existsSync(dst) && fs.statSync(dst).isDirectory()) {
      finalDst = path.join(dst, path.basename(src));
    }
    if (finalDst === src) return res.status(400).json({ error: 'Cannot move to itself' });
    fs.renameSync(src, finalDst);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Rename file/folder API ────────────────────────────────────────────────────
app.post('/api/rename', authMiddleware, (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const userDir = path.resolve(path.join(USERS_OUTPUT_DIR, req.user.username));
  const src = path.resolve(path.join(userDir, from));
  const dst = path.resolve(path.join(userDir, to));
  if (!src.startsWith(userDir) || !dst.startsWith(userDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (from === to) return res.status(400).json({ error: 'Same name' });
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'Source not found' });
  if (fs.existsSync(dst)) return res.status(400).json({ error: 'Target already exists' });
  try {
    fs.renameSync(src, dst);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Delete file API ────────────────────────────────────────────────────────────
app.delete('/api/file', authMiddleware, (req, res) => {
  const filePath = req.query.path || '';
  const userDir = path.resolve(path.join(USERS_OUTPUT_DIR, req.user.username));
  const full = path.resolve(path.join(userDir, filePath));
  if (!full.startsWith(userDir)) return res.status(403).json({ error: 'Access denied' });
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  try {
    if (fs.statSync(full).isDirectory()) {
      fs.rmSync(full, { recursive: true, force: true });
    } else {
      fs.unlinkSync(full);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/files', authMiddleware, (req, res) => {
  try {
    const files = fs.readdirSync(UPLOAD_DIR).map(f => {
      const s = fs.statSync(path.join(UPLOAD_DIR, f));
      return { name: f, size: s.size, mtime: s.mtime };
    });
    res.json({ files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/skills', authMiddleware, (req, res) => {
  const skillsDir = path.join(process.env.HOME || '/root', '.claude', 'skills');
  try {
    const items = fs.readdirSync(skillsDir).filter(f => !f.startsWith('.') && f !== '.skills_store_lock.json' && f !== 'AI-research-SKILLs' && f !== 'nature-skills' && f !== 'paper-polish-workflow-skill');
    const skills = items.map(f => {
      const meta = { name: f };
      const skillFile = path.join(skillsDir, f, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const content = fs.readFileSync(skillFile, 'utf-8');
        const desc = content.match(/description:\s*(.+)/);
        if (desc) meta.description = desc[1].trim();
      }
      return meta;
    });
    res.json({ skills });
  } catch (e) {
    // Fallback to known skills list
    res.json({ skills: [
      { name: 'code-review', description: 'Review code changes' },
      { name: 'diagnosing-bugs', description: 'Debug and fix issues' },
      { name: 'prototype', description: 'Quick prototyping' },
      { name: 'design-an-interface', description: 'Design UI components' },
      { name: 'research', description: 'Research a topic' },
      { name: 'domain-modeling', description: 'Model business domains' },
      { name: 'bioinfo', description: 'Bioinformatics analysis' },
      { name: 'single-cell', description: 'Single-cell data analysis' },
    ]});
  }
});

// ─── Conversations API ─────────────────────────────────────────────────────────
app.post('/api/conversations', authMiddleware, (req, res) => {
  const id = uuidv4();
  const { title } = req.body || {};
  db.run('INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)',
    [id, req.user.userId, title || 'New Chat']);
  saveDb();
  res.json({ success: true, id, title: title || 'New Chat' });
});

app.get('/api/conversations', authMiddleware, (req, res) => {
  const uid = parseInt(req.user.userId, 10);
  // sql.js db.exec doesn't support parameters, concat safely
  const rows = db.exec("SELECT id, title, session_id, created_at, updated_at FROM conversations WHERE user_id = " + uid + " ORDER BY updated_at DESC");
  const convs = rows.length && rows[0].values
    ? rows[0].values.map(v => ({ id: v[0], title: v[1], session_id: v[2], created_at: v[3], updated_at: v[4] }))
    : [];
  res.json({ conversations: convs });
});

app.put('/api/conversations/:id', authMiddleware, (req, res) => {
  const { title } = req.body || {};
  db.run('UPDATE conversations SET title = ?, updated_at = datetime(?) WHERE id = ? AND user_id = ?',
    [title, new Date().toISOString(), req.params.id, req.user.userId]);
  saveDb();
  res.json({ success: true });
});

app.delete('/api/conversations/:id', authMiddleware, (req, res) => {
  db.run('DELETE FROM conversations WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.userId]);
  saveDb();
  res.json({ success: true });
});

// ─── Messages API ───────────────────────────────────────────────────────────────
app.get('/api/messages/:conversationId', authMiddleware, (req, res) => {
  const uid = parseInt(req.user.userId, 10);
  const convId = req.params.conversationId.replace(/'/g, "''");
  const rows = db.exec("SELECT role, content, created_at FROM messages WHERE conversation_id = '" + convId + "' AND user_id = " + uid + " ORDER BY id ASC");
  const msgs = rows.length && rows[0].values
    ? rows[0].values.map(v => ({ role: v[0], content: v[1], created_at: v[2] }))
    : [];
  res.json({ messages: msgs });
});

app.post('/api/messages/:conversationId', authMiddleware, (req, res) => {
  const { role, content } = req.body || {};
  if (!role || !content) return res.status(400).json({ error: 'role and content required' });
  const convId = req.params.conversationId.replace(/'/g, "''");
  db.run("INSERT INTO messages (conversation_id, user_id, role, content) VALUES ('" + convId + "', " + parseInt(req.user.userId, 10) + ", '" + role + "', '" + content.replace(/'/g, "''") + "')");
  saveDb();
  res.json({ success: true });
});

// ─── Image serving ──────────────────────────────────────────────────────────────
app.get('/api/image', authMiddleware, (req, res) => {
  const filePath = req.query.path || '';
  const userDir = path.join(USERS_OUTPUT_DIR, req.user.username);
  const full = path.resolve(path.join(userDir, filePath));
  if (!full.startsWith(userDir)) return res.status(403).end();
  if (!fs.existsSync(full)) return res.status(404).end();
  const ext = path.extname(full).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.webp': 'image/webp' };
  res.type(mime[ext] || 'application/octet-stream').sendFile(full);
});

// ─── File browsing & download ──────────────────────────────────────────────────
const USERS_OUTPUT_DIR = path.resolve(process.env.USERS_OUTPUT_DIR || '/root/output');

app.get('/api/browse', authMiddleware, (req, res) => {
  const sub = req.query.path || '';
  const userDir = path.resolve(path.join(USERS_OUTPUT_DIR, req.user.username));
  // Disallow paths that try to escape the user directory
  if (sub.includes('..') || sub.startsWith('/')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const target = path.resolve(path.join(userDir, sub));
  if (!target.startsWith(userDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    if (!fs.existsSync(target)) return res.json({ files: [], currentPath: sub || '/' });
    const items = fs.readdirSync(target).filter(f => !f.startsWith('.'));
    const files = items.map(f => {
      const full = path.join(target, f);
      const stat = fs.statSync(full);
      return { name: f, size: stat.size, mtime: stat.mtime, isDir: stat.isDirectory(), isFile: stat.isFile() };
    });
    files.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ files, currentPath: sub || '/' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/download', (req, res) => {
  const filePath = req.query.path || '';
  const token = req.query.token || req.headers['authorization']?.slice(7);
  if (!token) return res.status(401).json({ error: 'Auth required' });
  const user = validateAuthToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  const userDir = path.join(USERS_OUTPUT_DIR, user.username);
  const full = path.resolve(path.join(userDir, filePath));
  if (!full.startsWith(userDir)) return res.status(403).json({ error: 'Access denied' });
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return res.status(404).json({ error: 'Not found' });
  res.download(full, path.basename(full));
});

// Serve frontend (static)
// 防缓存：HTML 页面始终取最新版，避免浏览器缓存旧代码
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── WebSocket ───────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Per-user 队列：不同用户互不阻塞；同一用户消息顺序执行
const userQueues = new Map();       // userId -> [{user,message,conversationId,ws,send}]
const userProcessing = new Set();   // 正在处理的 userId
const runningProcs = new Map();     // userId -> proc

function processUserQueue(userId) {
  const q = userQueues.get(userId);
  if (!q || q.length === 0 || userProcessing.has(userId)) return;
  userProcessing.add(userId);

  const { user, message, conversationId, ws, send } = q.shift();
  runClaudeForUser(user, message, conversationId, ws, send).finally(() => {
    userProcessing.delete(userId);
    processUserQueue(userId);
  });
}

function queueClaudeRun(user, message, conversationId, ws, send) {
  if (!userQueues.has(user.userId)) userQueues.set(user.userId, []);
  const q = userQueues.get(user.userId);
  const waitCount = q.length;
  if (waitCount > 0) {
    send({ type: 'status', content: `排队中（你还有 ${waitCount} 条消息在等待）...` });
  }
  q.push({ user, message, conversationId, ws, send });
  processUserQueue(user.userId);
}

// ─── Helper: save message to database ───────────────────────────────────────────
function saveMessage(conversationId, userId, role, content) {
  try {
    const cid = (conversationId || '').replace(/'/g, "''");
    const uid = parseInt(userId, 10);
    const safeContent = (content || '').replace(/'/g, "''");
    db.run("INSERT INTO messages (conversation_id, user_id, role, content) VALUES ('" + cid + "', " + uid + ", '" + role + "', '" + safeContent + "')");
    saveDb();
  } catch(e) { /* silent */ }
}

async function runClaudeForUser(user, message, conversationId, ws, send) {
  const s = conversationId ? (data) => send({ ...data, conversation_id: conversationId }) : send;
  s({ type: 'user_message', content: message });

  // Save user message server-side
  if (conversationId) {
    saveMessage(conversationId, user.userId, 'user', message);
  }

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'auto',
    '--append-system-prompt', '你是小云，一位专业的人工智能科研助手。重要规则：1.用相对路径保存文件到当前目录 2.输出的图片、表格、报告都保存在当前目录 3.不要使用/root/开头的绝对路径',
  ];

  // Resume from user's last session if they have one
  if (user.sessionId) {
    args.push('--resume', user.sessionId);
  }

  s({ type: 'status', content: 'Claude is thinking...' });

  return new Promise((resolve) => {
    let proc;
    try {
      const userOutputDir = path.join(USERS_OUTPUT_DIR, user.username, 'output');
      const userUploadDir = path.join(USERS_OUTPUT_DIR, user.username, 'uploads');
      if (!fs.existsSync(userOutputDir)) fs.mkdirSync(userOutputDir, { recursive: true });
      if (!fs.existsSync(userUploadDir)) fs.mkdirSync(userUploadDir, { recursive: true });

      // 仅在 VPN 开启时注入代理，让 R/Python 的 GO/KEGG 等外部请求走代理
      const claudeEnv = { ...process.env };
      if (vpnEnabled) {
        Object.assign(claudeEnv, {
          HTTP_PROXY: 'http://127.0.0.1:7890',
          HTTPS_PROXY: 'http://127.0.0.1:7890',
          http_proxy: 'http://127.0.0.1:7890',
          https_proxy: 'http://127.0.0.1:7890',
        });
      }
      proc = spawn(CLAUDE_CMD, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: userOutputDir,
        env: claudeEnv,
        timeout: 300000,   // 5 分钟硬超时，超时 SIGTERM → close → resolve
      });
      runningProcs.set(user.userId, proc);
      // 看门狗：8 分钟仍不退出则 SIGKILL 强制中断（防止孙进程卡住拖死队列）
      proc._watchdog = setTimeout(() => {
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          s({ type: 'error', content: '分析超时（8分钟），已强制中断' });
          s({ type: 'status', content: '已超时中断' });
          try { proc.kill('SIGKILL'); } catch(e) {}
        }
      }, 8 * 60 * 1000);
    } catch (err) {
  s({ type: 'error', content: `Failed to start Claude: ${err.message}` });
      return resolve();
    }

    let buf = '';
    let beforeFiles;
    let assistantText = '';
    let progress = { percent: 0, step: '初始化' };  // 进度状态（单调递增）
    try { beforeFiles = new Set(fs.readdirSync('/root').filter(f => !f.startsWith('.'))); } catch(e) {}

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          // Track assistant text for persistence
          if (ev.type === 'assistant' && ev.message && ev.message.content) {
            for (const c of ev.message.content) {
              if (c.type === 'text') {
                assistantText += c.text || '';
                // 解析 Claude 转述的 Python/R 脚本 [N/M] 进度
                const sp = parseSubProgress(c.text || '');
                if (sp && sp.percent > progress.percent) {
                  progress.percent = sp.percent;
                  progress.step = sp.step;
                  s({ type: 'progress', percent: sp.percent, step: sp.step, bar: progressBar(sp.percent) });
                }
              }
            }
          }
          handleStreamEvent(ev, s, user, progress);
        } catch { /* skip non-JSON lines */ }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const t = chunk.toString().trim();
      if (t && !t.includes('Ignoring')) {
        s({ type: 'status', content: t });
        // 解析 R/Python 子进程 [N/M] 格式进度
        const sp = parseSubProgress(t);
        if (sp && sp.percent > progress.percent) {
          progress.percent = sp.percent;
          progress.step = sp.step;
          s({ type: 'progress', percent: sp.percent, step: sp.step, bar: progressBar(sp.percent) });
        }
      }
    });

    proc.on('close', (code) => {
  if (proc._watchdog) clearTimeout(proc._watchdog);
  // 进程结束：进度强制设为 100%
  progress.percent = 100;
  progress.step = '完成';
  s({ type: 'progress', percent: 100, step: '完成', bar: progressBar(100) });
  s({ type: 'status', content: `Done (exit: ${code})` });
      runningProcs.delete(user.userId);
      // Save assistant response to database
      if (conversationId && assistantText) {
        saveMessage(conversationId, user.userId, 'assistant', assistantText);
      }
      // If Claude failed, clear stale session_id so next attempt starts fresh
      if (code !== 0 && user.sessionId) {
        user.sessionId = null;
        updateUserSessionId(user.userId, null);
      }
      // Copy files Claude saved to /root/ (with absolute paths) into user's directory
      try {
        if (beforeFiles) {
          const userDir = path.join(USERS_OUTPUT_DIR, user.username);
          const imageExts = new Set(['png','jpg','jpeg','gif','svg','webp','pdf','csv','tsv','xlsx','html','json','txt','md','py','r','sh','yaml','yml','xml','fasta','fa','fastq','vcf','bam','sam']);
          for (const f of fs.readdirSync('/root').filter(f => !f.startsWith('.'))) {
            if (beforeFiles.has(f)) continue;
            const ext = path.extname(f).toLowerCase().replace('.','');
            if (!imageExts.has(ext)) continue;
            const src = path.join('/root', f);
            const dst = path.join(userDir, f);
            if (fs.existsSync(src) && fs.statSync(src).isFile()) {
              fs.copyFileSync(src, dst);
            }
          }
        }
      } catch(e) { /* silent */ }
      resolve();
    });

    proc.on('error', (err) => {
  if (proc._watchdog) clearTimeout(proc._watchdog);
  s({ type: 'error', content: `Process error: ${err.message}` });
      runningProcs.delete(user.userId);
      resolve();
    });

    // Send user message
    proc.stdin.write(message + '\n');
    proc.stdin.end();
  });
}

function handleStreamEvent(ev, send, user, progress) {
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        send({ type: 'system', content: 'Claude Code ready' });
      } else if (ev.subtype === 'thinking_tokens') {
        send({ type: 'thinking_progress', tokens: ev.estimated_tokens || 0 });
      }
      break;

    case 'assistant': {
      const m = ev.message;
      if (!m || !m.content) break;
      for (const c of m.content) {
        switch (c.type) {
          case 'thinking':
            send({ type: 'thinking', content: c.thinking || '' });
            break;
          case 'text':
            send({ type: 'text', content: c.text || '' });
            break;
          case 'tool_use': {
            send({ type: 'tool_use', name: c.name || 'unknown', input: c.input || {} });
            // ─── 进度条：根据工具名映射到分析步骤 ───
            const p = getProgressForTool(c.name, c.input, progress);
            if (p && progress && p.percent > progress.percent) {
              progress.percent = p.percent;
              progress.step = p.step;
              send({ type: 'progress', percent: p.percent, step: p.step, bar: progressBar(p.percent) });
            }
            break;
          }
        }
      }
      break;
    }

    case 'result':
      // Save session_id for resume — this is how we isolate per-user sessions
      if (ev.session_id && user.userId) {
        user.sessionId = ev.session_id;
        updateUserSessionId(user.userId, ev.session_id);
      }
      // ─── result 事件：进度收尾（不必到 100%，留给 close 处理）───
      if (progress && progress.percent < 100) {
        // 如果到 result 还没满，说明不是典型 pipeline；推到 99 留给 close
        const final = progress.percent < 99 ? 99 : progress.percent;
        if (final !== progress.percent) {
          progress.percent = final;
          progress.step = '收尾中';
          send({ type: 'progress', percent: final, step: '收尾中', bar: progressBar(final) });
        }
      }
      send({
        type: 'turn_complete',
        usage: ev.usage || {},
        cost_usd: ev.total_cost_usd || 0,
        duration_ms: ev.duration_ms || 0,
        stop_reason: ev.stop_reason,
        result: ev.result || null,
      });
      break;
  }
}

// ─── WebSocket connections ───────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let authenticatedUser = null;

  // WebSocket keepalive — ping every 25s to prevent Cloudflare 60s timeout
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
    else clearInterval(pingInterval);
  }, 25000);

  const send = (data) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(data));
      } catch (e) {
        console.error('[WS] send error:', e.message, 'type:', data.type);
      }
    }
    // 静默忽略 CLOSED 状态（不再污染日志）
  };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send({ type: 'error', content: 'Invalid JSON' }); }

    // Auth via token
    if (msg.type === 'auth') {
      const user = validateAuthToken(msg.token);
      if (user) {
        authenticatedUser = user;
        send({ type: 'auth_ok', username: user.username });
      } else {
        send({ type: 'auth_error', message: 'Invalid or expired token' });
      }
      return;
    }

    if (!authenticatedUser) return send({ type: 'auth_required' });

    // Message from user
    if (msg.type === 'message') {
      queueClaudeRun(authenticatedUser, msg.content || '', msg.conversation_id || null, ws, send);
      return;
    }

    // Cancel
    if (msg.type === 'cancel') {
      const proc = runningProcs.get(authenticatedUser.userId);
      if (proc) {
        proc.kill('SIGTERM');
        runningProcs.delete(authenticatedUser.userId);
        send({ type: 'status', content: 'Cancelled' });
      } else {
        send({ type: 'status', content: 'No running process' });
      }
      return;
    }

    // Clear session (start fresh conversation)
    if (msg.type === 'clear') {
      authenticatedUser.sessionId = null;
      if (authenticatedUser.userId) {
        updateUserSessionId(authenticatedUser.userId, null);
      }
      send({ type: 'status', content: 'Conversation cleared' });
    }
  });

  ws.on('close', () => { clearInterval(pingInterval); });

  send({ type: 'hello', version: '2.0.0' });
});

// ─── Start ───────────────────────────────────────────────────────────────────
initDb().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`╔══════════════════════════════════════════════════════╗`);
    console.log(`║        Yunsci  v2                                     ║`);
    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  URL:      http://yunsci.dpdns.org:${PORT}            `);
    console.log(`║  Storage:  ${DB_PATH}`);
    console.log(`║  Uploads:  ${UPLOAD_DIR}`);
    console.log(`║  Users:    ${db.exec('SELECT COUNT(*) FROM users')[0]?.values[0]?.[0] || 0} registered`);
    console.log(`║  Secret:   ${SECRET === 'dev-only-change-in-production' ? '⚠️  DEFAULT (set SECRET env)' : '✅ Custom'}`);
    console.log(`╚══════════════════════════════════════════════════════╝`);
  });
});
