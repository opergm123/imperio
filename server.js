const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ── Config ────────────────────────────────────────────────────
const PORT     = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

// ── Ensure data directory ─────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Persistent storage helpers ────────────────────────────────
function loadJSON(file, def) {
  try {
    const p = path.join(DATA_DIR, file);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return def;
}
function saveJSON(file, data) {
  try { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2)); } catch {}
}

// ── State ─────────────────────────────────────────────────────
let visitors    = loadJSON('visitors.json',    []);
let bans        = loadJSON('bans.json',        []);
let countryBans = loadJSON('country_bans.json', []);
let logs        = loadJSON('logs.json',        []);
let cards       = loadJSON('cards.json',       { cards: [], nextId: 1 });

let idCounter = visitors.length
  ? Math.max(...visitors.map(v => v.id || 0)) + 1
  : 1;

// ── Token helpers ─────────────────────────────────────────────
const usedTokens = new Set();
function genToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let t;
  do { t = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (usedTokens.has(t));
  return t;
}

// Mark existing tokens as used
visitors.forEach(v => { if (v.token) usedTokens.add(v.token); });

// ── Log helper ────────────────────────────────────────────────
function addLog(type, msg) {
  const entry = { ts: new Date().toLocaleString('ru-RU'), type, msg };
  logs.unshift(entry);
  if (logs.length > 2000) logs.pop();
  saveJSON('logs.json', logs);
  broadcast({ type: 'log', entry });
  return entry;
}

// ── Stats helper ──────────────────────────────────────────────
function calcStats() {
  const now = Date.now();
  return {
    total:    visitors.length,
    pending:  visitors.filter(v => v.status === 'pending').length,
    approved: visitors.filter(v => v.status === 'approved').length,
    banned:   bans.length,
    lastHour: visitors.filter(v => now - new Date(v.time).getTime() < 3600000).length,
    lastDay:  visitors.filter(v => now - new Date(v.time).getTime() < 86400000).length,
  };
}

// ── CORS & JSON helpers ───────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); return resolve({}); }
      body += chunk;
    });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// ── Static file server ────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};
function serveStatic(res, filePath) {
  try {
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const data = fs.readFileSync(filePath);
    cors(res);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch {
    json(res, { error: 'Not found' }, 404);
  }
}

// ── HTTP server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  const url    = req.url.split('?')[0];
  const method = req.method;

  // ── Serve index.html ──────────────────────────────────────
  if (method === 'GET' && (url === '/' || url === '/index.html')) {
    const f = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(f)) return serveStatic(res, f);
    return json(res, { error: 'index.html not found in /public' }, 404);
  }

  // ── Static files under /public ───────────────────────────
  if (method === 'GET' && !url.startsWith('/api/')) {
    const f = path.join(__dirname, 'public', url);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return serveStatic(res, f);
  }

  // ══════════════════════════════════════════════════════════
  //  API ROUTES
  // ══════════════════════════════════════════════════════════

  // GET /api/visitors
  if (method === 'GET' && url === '/api/visitors') {
    return json(res, visitors);
  }

  // GET /api/bans
  if (method === 'GET' && url === '/api/bans') {
    return json(res, bans);
  }

  // GET /api/country-bans
  if (method === 'GET' && url === '/api/country-bans') {
    return json(res, countryBans);
  }

  // GET /api/logs
  if (method === 'GET' && url === '/api/logs') {
    return json(res, logs);
  }

  // GET /api/stats
  if (method === 'GET' && url === '/api/stats') {
    return json(res, calcStats());
  }

  // GET /api/cards
  if (method === 'GET' && url === '/api/cards') {
    return json(res, cards);
  }

  // POST /api/cards
  if (method === 'POST' && url === '/api/cards') {
    const body = await readBody(req);
    cards = body;
    saveJSON('cards.json', cards);
    return json(res, { ok: true });
  }

  // POST /api/visit  — visitor registers (uploads "file")
  if (method === 'POST' && url === '/api/visit') {
    const body = await readBody(req);
    const ip   = body.ip || req.socket.remoteAddress || 'unknown';

    // Check bans
    if (bans.some(b => b.ip === ip)) {
      addLog('blocked', `Заблокированный IP попытался зайти: ${ip}`);
      return json(res, { blocked: true }, 403);
    }
    if (countryBans.some(b => b.code === body.ipData?.countryCode)) {
      addLog('blocked', `Страна заблокирована: ${ip} · ${body.ipData?.country}`);
      return json(res, { blocked: true }, 403);
    }

    const token   = genToken();
    usedTokens.add(token);
    const visitor = {
      id:       idCounter++,
      ip,
      file:     body.file     || 'unknown',
      fileSize: body.fileSize || '0',
      ua:       body.ua       || '',
      uaShort:  body.uaShort  || '',
      ipData:   body.ipData   || null,
      status:   'pending',
      token,
      note:     '',
      time:     new Date().toISOString(),
    };

    visitors.unshift(visitor);
    saveJSON('visitors.json', visitors);

    const geo = visitor.ipData
      ? `${visitor.ipData.country||'?'}, ${visitor.ipData.city||'?'}`
      : 'Геоданные недоступны';
    addLog('visit', `Новый визит: ${ip} · ${visitor.file} · ${geo}`);

    broadcast({ type: 'new_visitor', visitor });
    broadcast({ type: 'stats', stats: calcStats() });

    return json(res, { ok: true, id: visitor.id });
  }

  // POST /api/approve/:id
  const approveMatch = url.match(/^\/api\/approve\/(\d+)$/);
  if (method === 'POST' && approveMatch) {
    const id = parseInt(approveMatch[1]);
    const v  = visitors.find(x => x.id === id);
    if (!v) return json(res, { error: 'Not found' }, 404);
    v.status = 'approved';
    saveJSON('visitors.json', visitors);
    addLog('pass', `Пропущен: ${v.ip} · токен ${v.token}`);
    broadcast({ type: 'visitor_update', visitor: v });
    broadcast({ type: 'stats', stats: calcStats() });
    // Auto-unlock: отправляем клиенту с этим IP команду открыть реальный сайт
    broadcast({ type: 'auto_unlock', ip: v.ip, visitorId: v.id });
    return json(res, { ok: true, token: v.token });
  }

  // POST /api/ban/:id  — ban visitor by queue id
  const banIdMatch = url.match(/^\/api\/ban\/(\d+)$/);
  if (method === 'POST' && banIdMatch) {
    const id   = parseInt(banIdMatch[1]);
    const body = await readBody(req);
    const v    = visitors.find(x => x.id === id);
    if (!v) return json(res, { error: 'Not found' }, 404);
    v.status = 'banned';
    saveJSON('visitors.json', visitors);

    const entry = {
      ip:      v.ip,
      country: v.ipData?.country || '—',
      countryCode: v.ipData?.countryCode || '',
      isp:     v.ipData?.isp || '—',
      reason:  body.reason || 'Бан из панели',
      date:    new Date().toLocaleString('ru-RU'),
    };
    if (!bans.find(b => b.ip === v.ip)) bans.push(entry);
    saveJSON('bans.json', bans);

    addLog('ban', `Забанен: ${v.ip} · ${entry.reason}`);
    broadcast({ type: 'visitor_update', visitor: v });
    broadcast({ type: 'bans', bans });
    broadcast({ type: 'stats', stats: calcStats() });
    return json(res, { ok: true });
  }

  // POST /api/ban-ip  — manual IP ban
  if (method === 'POST' && url === '/api/ban-ip') {
    const body = await readBody(req);
    if (!body.ip) return json(res, { error: 'ip required' }, 400);
    if (!bans.find(b => b.ip === body.ip)) {
      bans.push({
        ip:      body.ip,
        country: body.country || '—',
        countryCode: body.countryCode || '',
        isp:     body.isp    || '—',
        reason:  body.reason || 'Ручной бан',
        date:    new Date().toLocaleString('ru-RU'),
      });
      saveJSON('bans.json', bans);
      addLog('ban', `Ручной бан IP: ${body.ip}`);
      broadcast({ type: 'bans', bans });
    }
    return json(res, { ok: true });
  }

  // DELETE /api/ban-ip/:ip
  const unbanMatch = url.match(/^\/api\/ban-ip\/(.+)$/);
  if (method === 'DELETE' && unbanMatch) {
    const ip = decodeURIComponent(unbanMatch[1]);
    bans = bans.filter(b => b.ip !== ip);
    saveJSON('bans.json', bans);
    addLog('unban', `Разбанен IP: ${ip}`);
    broadcast({ type: 'bans', bans });
    return json(res, { ok: true });
  }

  // POST /api/country-ban
  if (method === 'POST' && url === '/api/country-ban') {
    const body = await readBody(req);
    if (!body.code) return json(res, { error: 'code required' }, 400);
    if (!countryBans.find(b => b.code === body.code)) {
      countryBans.push({
        code: body.code,
        name: body.name || body.code,
        date: new Date().toLocaleString('ru-RU'),
      });
      saveJSON('country_bans.json', countryBans);
      addLog('ban', `Заблокирована страна: ${body.name || body.code} (${body.code})`);
      broadcast({ type: 'country_bans', countryBans });
    }
    return json(res, { ok: true });
  }

  // DELETE /api/country-ban/:code
  const unbanCMatch = url.match(/^\/api\/country-ban\/(.+)$/);
  if (method === 'DELETE' && unbanCMatch) {
    const code = decodeURIComponent(unbanCMatch[1]);
    countryBans = countryBans.filter(b => b.code !== code);
    saveJSON('country_bans.json', countryBans);
    addLog('unban', `Разблокирована страна: ${code}`);
    broadcast({ type: 'country_bans', countryBans });
    return json(res, { ok: true });
  }

  // POST /api/note/:id
  const noteMatch = url.match(/^\/api\/note\/(\d+)$/);
  if (method === 'POST' && noteMatch) {
    const id   = parseInt(noteMatch[1]);
    const body = await readBody(req);
    const v    = visitors.find(x => x.id === id);
    if (!v) return json(res, { error: 'Not found' }, 404);
    v.note = body.note || '';
    saveJSON('visitors.json', visitors);
    broadcast({ type: 'visitor_update', visitor: v });
    return json(res, { ok: true });
  }

  // POST /api/clear-queue
  if (method === 'POST' && url === '/api/clear-queue') {
    visitors = visitors.filter(v => v.status !== 'pending');
    saveJSON('visitors.json', visitors);
    addLog('admin', 'Очередь ожидающих очищена');
    broadcast({ type: 'visitors_cleared' });
    broadcast({ type: 'stats', stats: calcStats() });
    return json(res, { ok: true });
  }

  // POST /api/clear-logs
  if (method === 'POST' && url === '/api/clear-logs') {
    logs = [];
    saveJSON('logs.json', logs);
    broadcast({ type: 'logs_cleared' });
    return json(res, { ok: true });
  }

  // POST /api/check-token
  if (method === 'POST' && url === '/api/check-token') {
    const body  = await readBody(req);
    const token = (body.token || '').toUpperCase();
    const v     = visitors.find(x => x.token === token && x.status === 'approved');
    if (v) {
      addLog('token', `Токен использован: ${token} · IP ${v.ip}`);
      v.status = 'used';
      saveJSON('visitors.json', visitors);
      broadcast({ type: 'visitor_update', visitor: v });
      broadcast({ type: 'stats', stats: calcStats() });
      return json(res, { valid: true, token });
    }
    return json(res, { valid: false });
  }

  // 404
  json(res, { error: 'Not found' }, 404);
});

// ── WebSocket ─────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach(ws => { if (ws.readyState === 1) ws.send(data); });
}

wss.on('connection', (ws) => {
  clients.add(ws);
  // Send full initial state
  ws.send(JSON.stringify({
    type:        'init',
    visitors,
    bans,
    countryBans,
    logs:        logs.slice(0, 500),
    stats:       calcStats(),
  }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ── Start ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🚀 IMPERIO backend running on port ${PORT}`);
  console.log(`   Static files: /public/index.html`);
  console.log(`   Data stored:  /data/`);
});
