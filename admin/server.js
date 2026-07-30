/**
 * Yunsci Admin Dashboard — port 3458
 * Shows all registered users and their usage.
 * Protected by ADMIN_PASSWORD env var (default: admin123).
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const PORT = parseInt(process.env.ADMIN_PORT, 10) || 3458;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const DB_PATH = path.resolve(__dirname, '..', 'data', 'claude-webui.db');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple in-memory session store
const sessions = new Map();

app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Admin Login</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5}
.card{background:#fff;border-radius:8px;padding:32px;width:360px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.card h1{margin:0 0 4px;font-size:20px}.card p{color:#666;margin:0 0 20px;font-size:14px}
.card input{width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:14px;margin-bottom:10px;box-sizing:border-box}
.card button{width:100%;padding:10px;background:#0969da;color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer}
.card .err{color:#cf222e;font-size:13px;margin-top:8px;display:none}</style></head>
<body><div class="card">
<h1>Yunsci Admin</h1>
<p>Enter admin credentials</p>
<form method="POST" action="/login">
<input type="text" name="user" placeholder="Username" required>
<input type="password" name="pass" placeholder="Password" required>
<button type="submit">Log In</button>
</form></div></body></html>`);
});

app.post('/login', (req, res) => {
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const sid = crypto.randomBytes(16).toString('hex');
    sessions.set(sid, { user, expires: Date.now() + 86400000 });
    res.redirect('/?sid=' + sid);
  } else {
    res.send('Invalid credentials. <a href="/login">Try again</a>');
  }
});

async function loadDb() {
  const SQL = await initSqlJs();
  if (!fs.existsSync(DB_PATH)) return null;
  const buf = fs.readFileSync(DB_PATH);
  return new SQL.Database(buf);
}

app.get('/', async (req, res) => {
  const sid = req.query.sid;
  if (!sid || !sessions.has(sid) || sessions.get(sid).expires < Date.now()) {
    return res.redirect('/login');
  }

  const db = await loadDb();
  if (!db) return res.send('No database found');

  const users = db.exec('SELECT id, username, created_at, last_login, session_id FROM users ORDER BY id')?.[0]?.values || [];
  const tokens = db.exec('SELECT user_id, COUNT(*) as cnt FROM auth_tokens GROUP BY user_id')?.[0]?.values || [];
  const tokenMap = {};
  tokens.forEach(t => { tokenMap[t[0]] = t[1]; });

  let totalQueries = 0;
  const outputDir = '/root/output';
  const userData = users.map(u => {
    const [id, username, created, lastLogin, sessionId] = u;
    const userDir = path.join(outputDir, username);
    let fileCount = 0;
    if (fs.existsSync(userDir)) {
      try { fileCount = fs.readdirSync(userDir).filter(f => !f.startsWith('.')).length; } catch(e) {}
    }
    totalQueries += fileCount;
    return { id, username, created, lastLogin, sessionId, tokenCount: tokenMap[id] || 0, fileCount };
  });

  const rows = userData.map(u => `
    <tr>
      <td>${u.id}</td>
      <td><b>${u.username}</b></td>
      <td>${u.created || '-'}</td>
      <td>${u.lastLogin || '-'}</td>
      <td>${u.tokenCount}</td>
      <td>${u.fileCount}</td>
      <td>${u.sessionId ? '✅' : '❌'}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Yunsci Admin</title>
<style>
body{font-family:-apple-system,sans-serif;margin:0;background:#f6f8fa;color:#1f2328}
.hdr{background:#fff;border-bottom:1px solid #d0d7de;padding:12px 24px;display:flex;align-items:center;justify-content:space-between}
.hdr h1{margin:0;font-size:20px}.hdr span{font-size:13px;color:#656d76}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f6f8fa;border-bottom:2px solid #d0d7de;padding:8px 12px;text-align:left;font-weight:600;position:sticky;top:0}
td{border-bottom:1px solid #d0d7de;padding:8px 12px}
tr:hover{background:#f6f8fa}
.stats{display:flex;gap:24px;padding:16px 24px;background:#fff;border-bottom:1px solid #d0d7de}
.stat{font-size:14px}.stat b{font-size:24px;color:#0969da;display:block}
.content{padding:16px 24px;overflow-x:auto}
.footer{text-align:center;padding:16px;font-size:12px;color:#8b949e}
</style></head><body>
<div class="hdr"><h1>🔧 Yunsci Admin</h1><span>${new Date().toLocaleString()}</span></div>
<div class="stats">
<div class="stat"><b>${userData.length}</b>Total Users</div>
<div class="stat"><b>${userData.reduce((s,u) => s + u.tokenCount, 0)}</b>Active Tokens</div>
<div class="stat"><b>${totalQueries}</b>Output Files</div>
<div class="stat"><b>${userData.filter(u => u.sessionId).length}</b>Active Sessions</div>
</div>
<div class="content">
<table><thead><tr><th>ID</th><th>Username</th><th>Registered</th><th>Last Login</th><th>Tokens</th><th>Files</th><th>Session</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<div class="footer">Yunsci Admin · <a href="https://yunsci.dpdns.org" target="_blank">Main Site</a></div>
</body></html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`╔══════════════════════════════════════╗`);
  console.log(`║  Yunsci Admin Dashboard              ║`);
  console.log(`║  http://0.0.0.0:${PORT}                 `);
  console.log(`║  User: ${ADMIN_USER} / Pass: ${ADMIN_PASS}`);
  console.log(`╚══════════════════════════════════════╝`);
});
