require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = (() => { try { return require('better-sqlite3'); } catch { return null; } })();
const initSqlJs = require('sql.js');
const { Auth } = require('@vonage/auth');
const { Vonage } = require('@vonage/server-sdk');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const DB_PATH = path.join(__dirname, 'data', 'catsnip.db');

let db;

function dbAll(sql, params) {
  return params ? db.prepare(sql).all(params) : db.prepare(sql).all();
}

function dbGet(sql, params) {
  return params ? db.prepare(sql).get(params) || null : db.prepare(sql).get() || null;
}

function dbRun(sql, params) {
  const stmt = db.prepare(sql);
  const info = params ? stmt.run(...params) : stmt.run();
  return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
}

async function initDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (Database) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.run = (...args) => Array.isArray(args[1]) ? db.prepare(args[0]).run(...args[1]) : db.prepare(args[0]).run(args[1] || undefined);
  } else {
    const SQL = await initSqlJs();
    if (fs.existsSync(DB_PATH)) {
      db = new SQL.Database(fs.readFileSync(DB_PATH));
    } else {
      db = new SQL.Database();
    }
    const _persist = () => fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
    const origRun = db.run.bind(db);
    db.run = (...args) => { origRun(...args); _persist(); };
    _persist();
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

  db.run(`CREATE TABLE IF NOT EXISTS admin_phones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    name TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS report_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS report_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    recipient_count INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    response_count INTEGER DEFAULT 0,
    error TEXT
  )`);

  persistDb();

  let neonPool = null;
  if (process.env.DATABASE_URL) {
    neonPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });
    console.log('Neon backup configured');
  }

  async function syncToNeon() {
    if (!neonPool) return;
    try {
      const client = await neonPool.connect();
      try {
        const tables = [
          { name: 'volunteers', pk: 'id', cols: ['id', 'name', 'phone', 'status', 'created_at'] },
          { name: 'messages', pk: 'id', cols: ['id', 'body', 'sent_at', 'recipient_count'] },
          { name: 'deliveries', pk: 'id', cols: ['id', 'message_id', 'volunteer_id', 'status', 'provider_id', 'error'] },
          { name: 'responses', pk: 'id', cols: ['id', 'message_id', 'volunteer_id', 'body', 'received_at'] },
          { name: 'admin_phones', pk: 'id', cols: ['id', 'phone', 'name', 'created_at'] },
          { name: 'report_recipients', pk: 'id', cols: ['id', 'email', 'name', 'created_at'] },
          { name: 'report_log', pk: 'id', cols: ['id', 'sent_at', 'recipient_count', 'message_count', 'response_count', 'error'] },
        ];
        for (const t of tables) {
          await client.query(`CREATE TABLE IF NOT EXISTS ${t.name} (${t.cols.map(c => `"${c}" TEXT`).join(', ')})`);
          const rows = dbAll(`SELECT ${t.cols.join(', ')} FROM ${t.name}`);
          if (rows.length) {
            await client.query(`DELETE FROM ${t.name}`);
            for (const row of rows) {
              const keys = Object.keys(row);
              const vals = keys.map(k => row[k]);
              await client.query(`INSERT INTO ${t.name} (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${vals.map((_, i) => '$' + (i + 1)).join(', ')})`, vals);
            }
          }
        }
        console.log('Neon sync ok');
      } finally { client.release(); }
    } catch (e) { console.log('Neon sync error:', e.message); }
  }

  setInterval(syncToNeon, 3600000);
  if (neonPool) syncToNeon().catch(() => {});

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));

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

  app.use('/api', (req, res, next) => {
    if (req.path === '/incoming-sms') console.log('=== WEBHOOK CALL ===', req.method, req.headers['user-agent'], req.headers['content-type'], req.body ? JSON.stringify(req.body) : 'NO BODY (raw body may be unparsed)');
    next();
  });

  app.use('/api', requireAuth);

  let vonageClient = null;
  const key = process.env.VONAGE_API_KEY || '';
  const secret = process.env.VONAGE_API_SECRET || '';
  if (key && secret && !key.includes('your_')) {
    vonageClient = new Vonage(new Auth({ apiKey: key, apiSecret: secret }));
    console.log('Vonage client created, phone:', process.env.VONAGE_PHONE_NUMBER);
  }

  function sendSms(to, body, messageId, volunteerId) {
    return Promise.resolve().then(() => {
      if (!vonageClient) throw new Error('Vonage not configured — set VONAGE_API_KEY and VONAGE_API_SECRET in .env');
      if (!process.env.VONAGE_PHONE_NUMBER) throw new Error('VONAGE_PHONE_NUMBER not set');
      return vonageClient.sms.send({ to, from: process.env.VONAGE_PHONE_NUMBER, text: body });
    }).then(msg => {
      db.run('UPDATE deliveries SET status = ?, provider_id = ? WHERE message_id = ? AND volunteer_id = ?',
        ['delivered', msg.messages?.[0]?.['message-id'] || 'ok', messageId, volunteerId]);
      return msg;
    }).catch(err => {
      db.run('UPDATE deliveries SET status = ?, error = ? WHERE message_id = ? AND volunteer_id = ?',
        ['failed', err.message, messageId, volunteerId]);

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

  app.get('/api/admin-phones', (req, res) => {
    res.json(dbAll('SELECT * FROM admin_phones ORDER BY created_at DESC'));
  });

  app.post('/api/admin-phones', (req, res) => {
    const { phone, name } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    const p = phone.startsWith('+') ? phone : '+' + phone.replace(/\D/g, '');
    try {
      const r = dbRun('INSERT INTO admin_phones (phone, name) VALUES (?, ?)', [p, name || '']);

      res.json({ id: r.lastInsertRowid, phone: p, name: name || '' });
    } catch (e) {
      res.status(409).json({ error: 'Already exists' });
    }
  });

  app.delete('/api/admin-phones/:id', (req, res) => {
    db.run('DELETE FROM admin_phones WHERE id = ?', [req.params.id]);
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
    console.log('sendSmsReply sending to', to);
    vonageClient.sms.send({ to, from: process.env.VONAGE_PHONE_NUMBER, text }).then(() => console.log('sendSmsReply success to', to)).catch(e => console.log('sendSmsReply error:', to, e.message));
  }

  function generateDailyReport() {
    const today = new Date().toISOString().slice(0, 10);
    const activeVols = dbAll('SELECT COUNT(*) as count FROM volunteers WHERE status = ?', ['active'])[0].count;
    const messages = dbAll(`SELECT m.*,
      (SELECT COUNT(*) FROM deliveries d WHERE d.message_id = m.id AND d.status = 'delivered') as delivered_count,
      (SELECT COUNT(*) FROM responses r WHERE r.message_id = m.id) as response_count
      FROM messages m WHERE date(m.sent_at) = ? ORDER BY m.sent_at`, [today]);
    const responses = dbAll(`SELECT r.*, v.name, v.phone, m.body as message_body
      FROM responses r JOIN volunteers v ON v.id = r.volunteer_id LEFT JOIN messages m ON m.id = r.message_id
      WHERE date(r.received_at) = ? ORDER BY r.received_at`, [today]);

    let text = `Catsnip Daily Report — ${today}\n${'='.repeat(50)}\n\nActive Volunteers: ${activeVols}\nMessages Sent: ${messages.length}\nResponses Received: ${responses.length}\n\n`;
    if (messages.length) {
      text += '--- Broadcasts ---\n';
      for (const m of messages) text += `[${m.sent_at}] "${m.body}" → ${m.delivered_count}/${m.recipient_count} delivered, ${m.response_count} replies\n`;
    }
    if (responses.length) {
      text += '\n--- Replies ---\n';
      for (const r of responses) text += `[${r.received_at}] ${r.name} (${r.phone}): "${r.body}"${r.message_body ? ` (re: "${r.message_body}")` : ''}\n`;
    }
    if (!messages.length && !responses.length) text += 'No activity today.\n';

    let html = `<h1 style="margin:0 0 4px;font-size:18px;">Catsnip Daily Report</h1><p style="margin:0 0 16px;color:#666;">${today}</p>`;
    html += `<table style="border-collapse:collapse;margin-bottom:16px;"><tr><td style="padding:6px 16px 6px 0;font-weight:600;">Active Volunteers</td><td>${activeVols}</td></tr>`;
    html += `<tr><td style="padding:6px 16px 6px 0;font-weight:600;">Messages Sent</td><td>${messages.length}</td></tr>`;
    html += `<tr><td style="padding:6px 16px 6px 0;font-weight:600;">Replies Received</td><td>${responses.length}</td></tr></table>`;
    if (messages.length) {
      html += '<h2 style="font-size:14px;margin:0 0 8px;">Broadcasts</h2>';
      for (const m of messages) html += `<p style="margin:0 0 6px;padding:8px;background:#f5f5f5;border-radius:4px;"><strong>${m.sent_at}</strong> ${m.body}<br><span style="color:#666;font-size:13px;">${m.delivered_count}/${m.recipient_count} delivered, ${m.response_count} replies</span></p>`;
    }
    if (responses.length) {
      html += '<h2 style="font-size:14px;margin:12px 0 8px;">Replies</h2>';
      for (const r of responses) html += `<p style="margin:0 0 6px;padding:8px;background:#f5f5f5;border-radius:4px;"><strong>${r.name}</strong> (${r.phone}): ${r.body}${r.message_body ? `<br><span style="color:#666;font-size:13px;">re: ${r.message_body}</span>` : ''}</p>`;
    }
    if (!messages.length && !responses.length) html += '<p style="color:#999;">No activity today.</p>';
    html += '<hr style="margin:16px 0;border:none;border-top:1px solid #eee;"><p style="color:#999;font-size:12px;">Sent by Catsnip volunteer broadcast system</p>';

    return { text, html };
  }

  function getMailTransport() {
    if (process.env.SMTP_HOST) {
      return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      });
    }
    return nodemailer.createTransport({ sendmail: true, newline: 'unix' });
  }

  async function sendDailyReport() {
    const recipients = dbAll('SELECT email, name FROM report_recipients');
    if (!recipients.length) return;
    const report = generateDailyReport();
    const from = process.env.SMTP_FROM || 'catsnip@localhost';
    const transporter = getMailTransport();
    let successCount = 0;
    for (const r of recipients) {
      try {
        await transporter.sendMail({
          from, to: r.email,
          subject: `Catsnip Daily Report — ${new Date().toISOString().slice(0, 10)}`,
          text: report.text,
          html: report.html,
        });
        successCount++;
      } catch (e) {
        console.error('Report email failed to', r.email, e.message);
      }
    }
    dbRun('INSERT INTO report_log (recipient_count, message_count, response_count, error) VALUES (?, ?, ?, ?)',
      [recipients.length, 0, 0, successCount < recipients.length ? 'partial failure' : null]);
    persistDb();
  }

  app.get('/api/report/recipients', (req, res) => {
    res.json(dbAll('SELECT * FROM report_recipients ORDER BY created_at DESC'));
  });

  app.post('/api/report/recipients', (req, res) => {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    try {
      const r = dbRun('INSERT INTO report_recipients (email, name) VALUES (?, ?)', [email, name || '']);

      res.json({ id: r.lastInsertRowid, email, name: name || '' });
    } catch (e) {
      res.status(409).json({ error: 'Already exists' });
    }
  });

  app.delete('/api/report/recipients/:id', (req, res) => {
    db.run('DELETE FROM report_recipients WHERE id = ?', [req.params.id]);
    persistDb();
    res.json({ ok: true });
  });

  app.get('/api/report/preview', (req, res) => {
    res.json(generateDailyReport());
  });

  app.post('/api/report/send', async (req, res) => {
    try {
      await sendDailyReport();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/incoming-sms', (req, res) => { res.sendStatus(200); });

  app.post('/api/incoming-sms', (req, res) => {
    const text = req.body.text || req.body.Body;
    const from = req.body.from || req.body.msisdn || req.body.From;
    if (!text || !from) {
      console.log('Incoming SMS rejected - missing text or from:', { text, from });
      return res.sendStatus(400);
    }

    const fromClean = (from || '').trim().startsWith('+') ? (from || '').trim() : '+' + (from || '').trim();
    let volunteer = dbGet('SELECT * FROM volunteers WHERE phone = ?', [fromClean]);

    if (!volunteer) {
      dbRun('INSERT INTO volunteers (name, phone) VALUES (?, ?)', ['New Volunteer', fromClean]);

      volunteer = dbGet('SELECT * FROM volunteers WHERE phone = ?', [fromClean]);
      sendSmsReply(fromClean, 'Thanks for joining Catsnip volunteer alerts! Reply with your name to personalize your contact info.');
    }

    const bodyTrim = text.trim();

    if (dbGet('SELECT id FROM admin_phones WHERE phone = ?', [fromClean])) {
      const ids = dbAll('SELECT id, phone FROM volunteers WHERE status = ?', ['active']).map(v => v.id);
      if (ids.length > 0) {
        const msgResult = dbRun('INSERT INTO messages (body, recipient_count) VALUES (?, ?)', [bodyTrim, ids.length]);
        const messageId = msgResult.lastInsertRowid;
        for (const vid of ids) {
          db.run('INSERT INTO deliveries (message_id, volunteer_id) VALUES (?, ?)', [messageId, vid]);
        }
  
        const volRows = ids.map(id => dbGet('SELECT id, phone FROM volunteers WHERE id = ?', [id])).filter(Boolean);
        for (const v of volRows) {
          sendSms(v.phone, bodyTrim, messageId, v.id).catch(() => {});
        }
      }
      db.run('INSERT INTO responses (message_id, volunteer_id, body) VALUES (?, ?, ?)', [null, volunteer.id, bodyTrim]);

      sendSmsReply(fromClean, 'Broadcast sent to ' + ids.length + ' volunteers.');
      return res.sendStatus(200);
    }

    if (volunteer.name === 'New Volunteer' && bodyTrim.toUpperCase() !== 'STOP' && bodyTrim.toUpperCase() !== 'UNSUBSCRIBE') {
      const nameMatch = bodyTrim.match(/^NAME:\s*(.+)/i);
      const newName = nameMatch ? nameMatch[1].trim() : bodyTrim;
      if (newName.length <= 50) {
        db.run('UPDATE volunteers SET name = ? WHERE id = ?', [newName, volunteer.id]);
  
        sendSmsReply(fromClean, 'Thanks ' + newName + '! Your name has been saved. You will get texts about upcoming opportunities. Reply STOP to opt out.');
      }
    } else if (bodyTrim.toUpperCase().startsWith('NAME:')) {
      const name = bodyTrim.slice(5).trim();
      if (name && name.length <= 50) {
        db.run('UPDATE volunteers SET name = ? WHERE id = ?', [name, volunteer.id]);
  
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

  if (process.env.REPORT_SCHEDULE_ENABLED === 'true') {
    const sendTime = process.env.REPORT_SEND_TIME || '17:00';
    console.log('Daily report scheduling enabled, send time:', sendTime);
    setInterval(() => {
      const now = new Date();
      const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      const lastSent = dbGet('SELECT MAX(sent_at) as last FROM report_log');
      const todayStr = now.toISOString().slice(0, 10);
      if (timeStr === sendTime && (!lastSent?.last || !lastSent.last.startsWith(todayStr))) {
        sendDailyReport().catch(e => console.error('Scheduled report failed:', e.message));
      }
    }, 60000);
  } else {
    console.log('Daily report scheduling disabled (set REPORT_SCHEDULE_ENABLED=true to enable)');
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Catsnip running on http://0.0.0.0:${PORT}`);
  });
}

initDb().catch(err => { console.error(err); process.exit(1); });
