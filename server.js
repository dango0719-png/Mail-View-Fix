require('dotenv').config();
const express = require('express');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const port = Number(process.env.PORT) || 3000;
const host = '0.0.0.0';

app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(require('path').join(process.cwd(), 'public', 'index.html'));
});

function getImapClient() {
  if (!process.env.IMAP_HOST || !process.env.IMAP_USER || !process.env.IMAP_PASS) {
    throw new Error('Thiếu biến môi trường IMAP_HOST, IMAP_USER hoặc IMAP_PASS');
  }

  return new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT) || 143,
    secure: String(process.env.IMAP_SECURE).toLowerCase() === 'true',
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASS
    },
    logger: false
  });
}

// Railway health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// API: Lấy danh sách 50 mail mới nhất
app.get('/api/mails', async (req, res) => {
  const client = getImapClient();

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const messages = [];
      const exists = client.mailbox.exists || 0;
      const seq = exists > 50 ? `${exists - 49}:*` : exists > 0 ? '1:*' : null;

      if (!seq) {
        return res.json([]);
      }

      for await (const msg of client.fetch(seq, { envelope: true, uid: true })) {
        messages.push({
          id: msg.uid,
          from: (msg.envelope?.from || [])
            .map(f => f.address || f.name || '')
            .filter(Boolean)
            .join(', '),
          subject: msg.envelope?.subject || '(Không có tiêu đề)',
          date: msg.envelope?.date || null
        });
      }

      res.json(messages.reverse());
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error('GET /api/mails:', err);
    res.status(500).json({ error: err.message });
  } finally {
    try {
      if (client.usable) await client.logout();
    } catch (_) {}
  }
});

// API: Lấy nội dung chi tiết của 1 mail theo UID
app.get('/api/mails/:id', async (req, res) => {
  const client = getImapClient();

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const uid = Number(req.params.id);
      if (!Number.isInteger(uid) || uid <= 0) {
        return res.status(400).json({ error: 'UID không hợp lệ' });
      }

      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!msg) {
        return res.status(404).json({ error: 'Không tìm thấy mail' });
      }

      const parsed = await simpleParser(msg.source);
      res.json({
        subject: parsed.subject || '(Không có tiêu đề)',
        body: parsed.html || `<pre>${parsed.textAsHtml || parsed.text || ''}</pre>`
      });
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error(`GET /api/mails/${req.params.id}:`, err);
    res.status(500).json({ error: err.message });
  } finally {
    try {
      if (client.usable) await client.logout();
    } catch (_) {}
  }
});

// Railway cung cấp PORT; không hard-code localhost/3000.
app.listen(port, host, () => {
  console.log(`Server listening on ${host}:${port}`);
});
