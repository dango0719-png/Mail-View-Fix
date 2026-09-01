const express = require('express');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const port = Number(process.env.PORT || 3000);

// The IMAP server is configured on Railway, but customer credentials are
// entered in the browser and kept only in server memory for the session.
const IMAP_HOST = process.env.IMAP_HOST || 'm4.kcn.ne.jp';
const IMAP_PORT = Number(process.env.IMAP_PORT || 143);
const IMAP_SECURE = String(process.env.IMAP_SECURE || 'false').toLowerCase() === 'true';

app.use(express.json({ limit: '32kb' }));
app.use(express.static('public'));

// In-memory sessions: credentials are never written to disk/database.
// Restarting the Railway container logs everyone out.
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(token);
  }
}
setInterval(cleanupSessions, 5 * 60 * 1000).unref();

function getToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function getSession(req) {
  const token = getToken(req);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function makeClient(session) {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: IMAP_SECURE,
    auth: {
      user: session.user,
      pass: session.pass
    },
    logger: false
  });
}

async function withImap(session, work) {
  const client = makeClient(session);
  let lock;
  try {
    await client.connect();
    lock = await client.getMailboxLock('INBOX');
    return await work(client);
  } finally {
    if (lock) lock.release();
    try {
      await client.logout();
    } catch (_) {
      // Ignore logout errors.
    }
  }
}

function requireSession(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
  }
  req.mailSession = session;
  next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'mail-viewer', version: 'customer-login-2026-09-01' });
});

app.post('/api/login', async (req, res) => {
  const user = String(req.body?.user || '').trim();
  const pass = String(req.body?.pass || '');

  if (!user || !pass) {
    return res.status(400).json({ error: 'Vui lòng nhập email và mật khẩu.' });
  }

  const testSession = { user, pass };

  try {
    // Verify credentials before creating a session.
    await withImap(testSession, async () => true);

    const token = newToken();
    sessions.set(token, {
      user,
      pass,
      createdAt: Date.now()
    });

    res.json({
      ok: true,
      token,
      user
    });
  } catch (err) {
    console.error('IMAP login failed:', err.message);
    res.status(401).json({
      error: 'Đăng nhập email thất bại. Kiểm tra email/mật khẩu hoặc máy chủ IMAP.'
    });
  }
});

app.post('/api/logout', (req, res) => {
  const token = getToken(req);
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/me', requireSession, (req, res) => {
  res.json({ user: req.mailSession.user });
});

app.get('/api/mails', requireSession, async (req, res) => {
  try {
    const messages = await withImap(req.mailSession, async (client) => {
      const exists = client.mailbox.exists || 0;
      if (!exists) return [];

      const seq = exists > 50 ? `${exists - 49}:*` : '1:*';
      const rows = [];

      for await (const msg of client.fetch(seq, {
        envelope: true,
        uid: true
      })) {
        rows.push({
          id: msg.uid,
          from: (msg.envelope.from || []).map(f => f.address || f.name || '').join(', '),
          subject: msg.envelope.subject || '(Không có tiêu đề)',
          date: msg.envelope.date || null
        });
      }

      return rows.reverse();
    });

    res.json(messages);
  } catch (err) {
    console.error('IMAP list failed:', err.message);
    res.status(502).json({ error: 'Không thể đọc hộp thư. Phiên đăng nhập có thể đã hết hạn.' });
  }
});

app.get('/api/mails/:id', requireSession, async (req, res) => {
  const uid = Number(req.params.id);
  if (!Number.isInteger(uid) || uid <= 0) {
    return res.status(400).json({ error: 'UID email không hợp lệ.' });
  }

  try {
    const result = await withImap(req.mailSession, async (client) => {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg) return null;

      const parsed = await simpleParser(msg.source);
      return {
        subject: parsed.subject || '(Không có tiêu đề)',
        from: parsed.from?.text || '',
        date: parsed.date || null,
        body: parsed.html || `<pre>${escapeHtml(parsed.text || '')}</pre>`
      };
    });

    if (!result) return res.status(404).json({ error: 'Không tìm thấy email.' });
    res.json(result);
  } catch (err) {
    console.error('IMAP message failed:', err.message);
    res.status(502).json({ error: 'Không thể đọc email này.' });
  }
});

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${port}`);
});
