require('dotenv').config();
const path = require('path');
const express = require('express');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

app.disable('x-powered-by');
app.use(express.json());

function getImapClient() {
  const missing = ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASS'].filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Thiếu biến môi trường: ${missing.join(', ')}`);

  return new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT) || 143,
    secure: String(process.env.IMAP_SECURE || 'false').toLowerCase() === 'true',
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false
  });
}

// API health/version: dùng để xác nhận Railway đang chạy đúng source.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', app: 'mail-viewer', version: 'railway-2026-09-01' });
});

app.get('/api/mails', async (req, res) => {
  let client;
  try {
    client = getImapClient();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const exists = Number(client.mailbox?.exists || 0);
      if (exists === 0) return res.json([]);
      const seq = exists > 50 ? `${exists - 49}:*` : `1:${exists}`;
      const messages = [];
      for await (const msg of client.fetch(seq, { envelope: true, uid: true })) {
        messages.push({
          id: msg.uid,
          from: (msg.envelope?.from || []).map(f => f.address || f.name || '').filter(Boolean).join(', '),
          subject: msg.envelope?.subject || '(Không có tiêu đề)',
          date: msg.envelope?.date || null
        });
      }
      return res.json(messages.reverse());
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error('GET /api/mails:', err);
    return res.status(500).type('application/json').json({ error: String(err.message || err) });
  } finally {
    if (client) {
      try { if (client.usable) await client.logout(); } catch (_) {}
    }
  }
});

app.get('/api/mails/:id', async (req, res) => {
  let client;
  try {
    const uid = Number(req.params.id);
    if (!Number.isInteger(uid) || uid <= 0) return res.status(400).json({ error: 'UID không hợp lệ' });

    client = getImapClient();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!msg) return res.status(404).json({ error: 'Không tìm thấy mail' });
      const parsed = await simpleParser(msg.source);
      return res.json({
        subject: parsed.subject || '(Không có tiêu đề)',
        body: parsed.html || `<pre>${parsed.textAsHtml || parsed.text || ''}</pre>`
      });
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error(`GET /api/mails/${req.params.id}:`, err);
    return res.status(500).type('application/json').json({ error: String(err.message || err) });
  } finally {
    if (client) {
      try { if (client.usable) await client.logout(); } catch (_) {}
    }
  }
});

// API 404 cũng luôn trả JSON, không bao giờ trả HTML.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `API không tồn tại: ${req.method} ${req.originalUrl}` });
});

// Frontend.
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Các route không tồn tại.
app.use((req, res) => {
  if (req.accepts('html')) return res.status(404).send('Không tìm thấy trang.');
  return res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, HOST, () => {
  console.log(`Mail Viewer railway-2026-09-01 listening on ${HOST}:${PORT}`);
});
