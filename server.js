require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const { Auth } = require('@vonage/auth');
const { Vonage } = require('@vonage/server-sdk');

const DB_PATH = path.join(__dirname, 'data', 'catsnip.db');

let db;

function dbAll(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbGet(sql, params) {
  const rows = dbAll(sql, params);
  return rows[0] || null;
}

function dbRun(sql, params) {
  db.run(sql, params || []);
  const result = db.exec('SELECT last_insert_rowid() as id; SELECT changes() as changes');
  return {
    lastInsertRowid: result[0]?.values?.[0]?.[0] || null,
    changes: result[1]?.values?.[0]?.[0] || 0,
  };
}

function dbChanges() {
  const r = db.exec('SELECT changes() as c');
  return r[0]?.values?.[0]?.[0] || 0;
}

async function initDb() {
  const SQL = await initSqlJs();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS volunteers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    recipient_count INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    volunteer_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    provider_id TEXT,
    error TEXT,
    FOREIGN KEY (message_id) REFERENCES messages(id),
    FOREIGN KEY (volunteer_id) REFERENCES volunteers(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER,
    volunteer_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id),
    FOREIGN KEY (volunteer_id) REFERENCES volunteers(id)
  )`);

  persistDb();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));

  function persistDb() {
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  }

  const sessions = new Map();
  const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
  const ADMIN_PASS = (process.env.ADMIN_PASSWORD || '').trim();

  function requireAuth(req, res, next) {
    if (req.path === '/login' || req.path === '/incoming-sms') return next();
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = auth.slice(7);
    if (!sessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const u = String(username || '').trim();
    const p = String(password || '').trim();
    if (u && p && u === ADMIN_USER && p === ADMIN_PASS) {
      const token = crypto.randomUUID();
      sessions.set(token, { username: u, createdAt: Date.now() });
      res.json({ token, username: u });
    } else {
      console.log('Login failed:', u, ADMIN_USER, p?.length, ADMIN_PASS?.length);
      res.status(401).json({ error: 'Invalid credentials' });
    }
  });

  app.use('/api', requireAuth);

  let vonageClient = null;
  const key = process.env.VONAGE_API_KEY || '';
  const secret = process.env.VONAGE_API_SECRET || '';
  if (key && secret && !key.includes('your_')) {
    vonageClient = new Vonage(new Auth({ apiKey: key, apiSecret: secret }));
  }

  function sendSms(to, body, messageId, volunteerId) {
    return Promise.resolve().then(() => {
      if (!vonageClient) throw new Error('Vonage not configured — set VONAGE_API_KEY and VONAGE_API_SECRET in .env');
      if (!process.env.VONAGE_PHONE_NUMBER) throw new Error('VONAGE_PHONE_NUMBER not set');
      return vonageClient.sms.send({ to, from: process.env.VONAGE_PHONE_NUMBER, text: body });
    }).then(msg => {
      db.run('UPDATE deliveries SET status = ?, provider_id = ? WHERE message_id = ? AND volunteer_id = ?',
        ['delivered', msg.messages?.[0]?.['message-id'] || 'ok', messageId, volunteerId]);
      persistDb();
      return msg;
    }).catch(err => {
      db.run('UPDATE deliveries SET status = ?, error = ? WHERE message_id = ? AND volunteer_id = ?',
        ['failed', err.message, messageId, volunteerId]);
      persistDb();
      throw err;
    });
  }

  app.get('/api/status', (req, res) => {
    res.json({
      sms: !!vonageClient && !!process.env.VONAGE_PHONE_NUMBER,
      volunteers: dbAll('SELECT COUNT(*) as count FROM volunteers WHERE status = ?', ['active'])[0].count,
    });
  });

  app.get('/api/volunteers', (req, res) => {
    res.json(dbAll('SELECT * FROM volunteers WHERE status = ?', ['active']));
  });

  app.post('/api/volunteers', (req, res) => {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
    try {
      const result = dbRun('INSERT INTO volunteers (name, phone) VALUES (?, ?)', [name, phone]);
      persistDb();
      res.json({ id: result.lastInsertRowid, name, phone });
    } catch (e) {
      res.status(409).json({ error: 'Volunteer with this phone already exists' });
    }
  });

  app.delete('/api/volunteers/:id', (req, res) => {
    db.run('UPDATE volunteers SET status = ? WHERE id = ?', ['removed', req.params.id]);
    persistDb();
    res.json({ ok: true });
  });

  app.post('/api/messages', async (req, res) => {
    const { body, volunteerIds } = req.body;
    if (!body) return res.status(400).json({ error: 'Message body required' });

    let ids = volunteerIds;
    if (!ids || ids.length === 0) {
      ids = dbAll('SELECT id FROM volunteers WHERE status = ?', ['active']).map(v => v.id);
    }
    if (ids.length === 0) return res.status(400).json({ error: 'No volunteers to message' });

    const msgResult = dbRun('INSERT INTO messages (body, recipient_count) VALUES (?, ?)', [body, ids.length]);
    const messageId = msgResult.lastInsertRowid;

    for (const vid of ids) {
      db.run('INSERT INTO deliveries (message_id, volunteer_id) VALUES (?, ?)', [messageId, vid]);
    }
    persistDb();

    const volRows = ids.map(id => dbGet('SELECT id, phone FROM volunteers WHERE id = ?', [id])).filter(Boolean);

    const results = { sent: 0, failed: 0 };
    const settled = await Promise.allSettled(
      volRows.map(v => sendSms(v.phone, body, messageId, v.id))
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') results.sent++;
      else results.failed++;
    }
    persistDb();
    res.json({ messageId, ...results });
  });

  app.get('/api/messages', (req, res) => {
    const messages = dbAll(`
      SELECT m.*,
        (SELECT COUNT(*) FROM deliveries d WHERE d.message_id = m.id AND d.status = 'delivered') as delivered_count,
        (SELECT COUNT(*) FROM responses r WHERE r.message_id = m.id) as response_count
      FROM messages m ORDER BY m.sent_at DESC LIMIT 50
    `);
    res.json(messages);
  });

  app.get('/api/messages/:id', (req, res) => {
    const message = dbGet('SELECT * FROM messages WHERE id = ?', [req.params.id]);
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const deliveries = dbAll(`
      SELECT d.*, v.name, v.phone FROM deliveries d
      JOIN volunteers v ON v.id = d.volunteer_id
      WHERE d.message_id = ? ORDER BY v.name
    `, [req.params.id]);

    const responses = dbAll(`
      SELECT r.*, v.name, v.phone FROM responses r
      JOIN volunteers v ON v.id = r.volunteer_id
      WHERE r.message_id = ? ORDER BY r.received_at DESC
    `, [req.params.id]);

    res.json({ ...message, deliveries, responses });
  });

  app.get('/api/responses', (req, res) => {
    const since = req.query.since;
    let rows;
    if (since) {
      rows = dbAll(`
        SELECT r.*, v.name, v.phone, m.body as message_body
        FROM responses r
        JOIN volunteers v ON v.id = r.volunteer_id
        LEFT JOIN messages m ON m.id = r.message_id
        WHERE r.received_at > ?
        ORDER BY r.received_at DESC LIMIT 50
      `, [since]);
    } else {
      rows = dbAll(`
        SELECT r.*, v.name, v.phone, m.body as message_body
        FROM responses r
        JOIN volunteers v ON v.id = r.volunteer_id
        LEFT JOIN messages m ON m.id = r.message_id
        ORDER BY r.received_at DESC LIMIT 50
      `);
    }
    res.json(rows);
  });

  function sendSmsReply(to, text) {
    if (!vonageClient || !process.env.VONAGE_PHONE_NUMBER) return;
    vonageClient.sms.send({ to, from: process.env.VONAGE_PHONE_NUMBER, text }).catch(() => {});
  }

  app.post('/api/incoming-sms', (req, res) => {
    const text = req.body.text || req.body.Body;
    const from = req.body.msisdn || req.body.From;
    if (!text || !from) return res.sendStatus(400);

    const fromClean = from.startsWith('+') ? from : '+' + from;
    let volunteer = dbGet('SELECT id FROM volunteers WHERE phone = ?', [fromClean]);

    if (!volunteer) {
      dbRun('INSERT INTO volunteers (name, phone) VALUES (?, ?)', ['New Volunteer', fromClean]);
      persistDb();
      volunteer = dbGet('SELECT id FROM volunteers WHERE phone = ?', [fromClean]);
      sendSmsReply(fromClean, 'Thanks for joining CatSnip volunteer alerts! Reply with your name to personalize your contact info.');
    }

    const bodyTrim = text.trim();

    if (volunteer.name === 'New Volunteer' && bodyTrim.toUpperCase() !== 'STOP' && bodyTrim.toUpperCase() !== 'UNSUBSCRIBE') {
      const nameMatch = bodyTrim.match(/^NAME:\s*(.+)/i);
      const newName = nameMatch ? nameMatch[1].trim() : bodyTrim;
      if (newName.length <= 50) {
        db.run('UPDATE volunteers SET name = ? WHERE id = ?', [newName, volunteer.id]);
        persistDb();
        sendSmsReply(fromClean, 'Thanks ' + newName + '! Your name has been saved. You will get texts about upcoming opportunities. Reply STOP to opt out.');
      }
    } else if (bodyTrim.toUpperCase().startsWith('NAME:')) {
      const name = bodyTrim.slice(5).trim();
      if (name && name.length <= 50) {
        db.run('UPDATE volunteers SET name = ? WHERE id = ?', [name, volunteer.id]);
        persistDb();
        sendSmsReply(fromClean, 'Name updated to ' + name + '.');
      }
    }

    const latestDelivery = dbGet(`
      SELECT message_id FROM deliveries WHERE volunteer_id = ? AND status = 'delivered'
      ORDER BY message_id DESC LIMIT 1
    `, [volunteer.id]);

    db.run(
      'INSERT INTO responses (message_id, volunteer_id, body) VALUES (?, ?, ?)',
      [latestDelivery ? latestDelivery.message_id : null, volunteer.id, bodyTrim]
    );
    persistDb();

    res.sendStatus(200);
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CatSnip running on http://0.0.0.0:${PORT}`);
  });
}

initDb().catch(err => { console.error(err); process.exit(1); });
