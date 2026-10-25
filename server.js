const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const useragent = require('useragent');
const initSqlJs = require('sql.js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Database ──
let db;
const dbPath = path.join(__dirname, 'data', 'voom.db');

function q(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    if (sql.trim().toUpperCase().startsWith('SELECT') || sql.trim().toUpperCase().startsWith('WITH')) {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    } else {
      stmt.run(params);
      stmt.free();
      saveDb();
      return { changes: db.getRowsModified() };
    }
  } catch (e) {
    console.error('DB Error:', e.message);
    return [];
  }
}

function get(sql, params = []) {
  const rows = q(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function saveDb() {
  try {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  } catch (e) { console.error('Save error:', e.message); }
}

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  
  db.run(`CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY, title TEXT, filename TEXT, original_name TEXT,
    thumbnail TEXT, duration INTEGER, status TEXT DEFAULT 'ready',
    created_at TEXT DEFAULT (datetime('now')), total_views INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS views (
    id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT,
    viewed_at TEXT DEFAULT (datetime('now')), ip TEXT, browser TEXT, os TEXT,
    device TEXT, country TEXT, referrer TEXT, duration_watched REAL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT,
    author TEXT, body TEXT, timestamp REAL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT,
    emoji TEXT, timestamp REAL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS cta_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT,
    cta_type TEXT, clicked_at TEXT DEFAULT (datetime('now')), ip TEXT
  )`);
  saveDb();
  console.log('📦 Database ready');
}

// ── Storage ──
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 1000 * 1024 * 1024 }, // 1GB
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.gif'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// ── Middleware ──
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Email via Porteden ──
async function sendEmailNotification(videoTitle, viewInfo) {
  const https = require('https');
  const peKey = process.env.PE_API_KEY;
  if (!peKey) return;

  const subject = `👀 Voom: ${viewInfo.isReplay ? 'Re-watch' : 'Watched'} — "${videoTitle}"`;
  const body = [
    `Hi Jeff,`,
    ``,
    viewInfo.isReplay
      ? `Someone watched "${videoTitle}" again!`
      : `Someone watched your Voom video for the first time!`,
    ``,
    `📹 Video: ${videoTitle}`,
    `👁️ View #${viewInfo.viewNumber}`,
    `🕐 When: ${viewInfo.viewedAt}`,
    `🌐 IP: ${viewInfo.ip}`,
    `💻 Browser: ${viewInfo.browser}`,
    `📱 Device: ${viewInfo.device}`,
    `📄 Referrer: ${viewInfo.referrer || 'Direct link'}`,
    `⏱️ Watched for: ${viewInfo.durationWatched || 'N/A'}`,
    ``,
    `🔗 Link: ${BASE_URL}/watch/${viewInfo.videoId}`,
    `👁️ Total views on this video: ${viewInfo.totalViews}`,
    ``,
    `— Voom`,
  ].join('\n');

  const data = JSON.stringify({
    from: 'marketbossai@gmail.com',
    to: 'jeff@vbspotlight.com',
    subject,
    body,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.porteden.com',
      path: '/v1/email/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${peKey}`,
        'Content-Length': data.length,
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        console.log(`📧 ${viewInfo.isReplay ? 'Re-watch' : 'View'} email sent: ${res.statusCode}`);
        resolve(true);
      });
    });
    req.on('error', (e) => {
      console.error(`📧 Email error: ${e.message}`);
      resolve(false);
    });
    req.write(data);
    req.end();
  });
}

// ── Routes ──

// Upload page
app.get('/', (req, res) => {
  const videos = q('SELECT * FROM videos ORDER BY created_at DESC LIMIT 12');
  res.render('upload', { title: 'Voom — Record, Share, Track', videos, baseUrl: BASE_URL });
});

// Handle upload
app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).send('No file');
  const id = uuidv4().slice(0, 8);
  const title = req.body.title || req.file.originalname.replace(/\.[^.]+$/, '');
  q('INSERT INTO videos (id, title, filename, original_name) VALUES (?, ?, ?, ?)',
    [id, title, req.file.filename, req.file.originalname]);
  const link = `${BASE_URL}/watch/${id}`;
  res.json({ ok: true, id, link, title });
});

// Watch page (no login required — like Loom)
app.get('/watch/:id', (req, res) => {
  const video = get('SELECT * FROM videos WHERE id = ?', [req.params.id]);
  if (!video) return res.status(404).send('Video not found');

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const agent = useragent.parse(req.headers['user-agent']);
  const referrer = req.headers['referer'] || '';

  q('INSERT INTO views (video_id, ip, browser, os, device, referrer) VALUES (?, ?, ?, ?, ?, ?)',
    [video.id, ip, agent.toAgent(), agent.os.toString(), agent.device.toString() || 'Desktop', referrer]);

  q('UPDATE videos SET total_views = total_views + 1 WHERE id = ?', [video.id]);
  const updated = get('SELECT * FROM videos WHERE id = ?', [req.params.id]);
  const viewCount = q('SELECT COUNT(*) as c FROM views WHERE video_id = ?', [video.id]);
  const viewNumber = viewCount[0]?.c || 1;

  sendEmailNotification(video.title, {
    videoId: video.id,
    isReplay: viewNumber > 1,
    viewNumber,
    viewedAt: new Date().toISOString(),
    ip, browser: agent.toAgent(), device: agent.device.toString() || 'Desktop',
    referrer, totalViews: updated?.total_views || 0,
  });

  const comments = q('SELECT * FROM comments WHERE video_id = ? ORDER BY created_at ASC', [video.id]);
  const reactions = q('SELECT emoji, COUNT(*) as count FROM reactions WHERE video_id = ? GROUP BY emoji', [video.id]);
  const ctaClicks = q('SELECT cta_type, COUNT(*) as count FROM cta_clicks WHERE video_id = ? GROUP BY cta_type', [video.id]);

  res.render('watch', {
    title: `Voom — ${video.title}`, video: updated, baseUrl: BASE_URL,
    comments, reactions, ctaClicks,
  });
});

// Dashboard
app.get('/dashboard', (req, res) => {
  const videos = q('SELECT * FROM videos ORDER BY created_at DESC');
  const views = q(`SELECT v.*, vi.title as video_title FROM views v
    JOIN videos vi ON v.video_id = vi.id ORDER BY v.viewed_at DESC LIMIT 100`);
  res.render('dashboard', { title: 'Voom — Dashboard', videos, views, baseUrl: BASE_URL });
});

// Video file serving
app.use('/video', express.static(path.join(__dirname, 'uploads')));

// API endpoints
app.get('/api/videos', (req, res) => {
  res.json(q('SELECT id, title, original_name, total_views, created_at FROM videos ORDER BY created_at DESC'));
});

app.get('/api/views/:id', (req, res) => {
  const video = get('SELECT * FROM videos WHERE id = ?', [req.params.id]);
  if (!video) return res.status(404).json({ error: 'Not found' });
  res.json({ video, views: q('SELECT * FROM views WHERE video_id = ? ORDER BY viewed_at DESC', [req.params.id]) });
});

app.post('/api/comment', express.json(), (req, res) => {
  const { video_id, author, body, timestamp } = req.body;
  q('INSERT INTO comments (video_id, author, body, timestamp) VALUES (?, ?, ?, ?)',
    [video_id, author || 'Anonymous', body, timestamp || 0]);
  res.json({ ok: true });
});

app.post('/api/reaction', express.json(), (req, res) => {
  const { video_id, emoji, timestamp } = req.body;
  q('INSERT INTO reactions (video_id, emoji, timestamp) VALUES (?, ?, ?)', [video_id, emoji, timestamp || 0]);
  res.json({ ok: true });
});

app.post('/api/cta-click', express.json(), (req, res) => {
  const { video_id, cta_type } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  q('INSERT INTO cta_clicks (video_id, cta_type, ip) VALUES (?, ?, ?)', [video_id, cta_type, ip]);
  res.json({ ok: true });
});

app.delete('/api/video/:id', (req, res) => {
  const video = get('SELECT * FROM videos WHERE id = ?', [req.params.id]);
  if (!video) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(path.join(__dirname, 'uploads', video.filename)); } catch(e) {}
  q('DELETE FROM views WHERE video_id = ?', [req.params.id]);
  q('DELETE FROM comments WHERE video_id = ?', [req.params.id]);
  q('DELETE FROM reactions WHERE video_id = ?', [req.params.id]);
  q('DELETE FROM cta_clicks WHERE video_id = ?', [req.params.id]);
  q('DELETE FROM videos WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ── Start ──
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`
  ╔═══════════════════════════════════════╗
  ║           Voom v1.0                   ║
  ║  Video messaging + per-view emails    ║
  ╚═══════════════════════════════════════╝
  ${BASE_URL}
  ${BASE_URL}/upload
  ${BASE_URL}/dashboard
    `);
  });
});