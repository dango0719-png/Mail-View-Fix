const express = require('express');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '64kb' }));
app.use(express.static('public'));

const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;

function token() {
  return crypto.randomBytes(32).toString('hex');
}

function cleanup() {
  const now = Date.now();
  for (const [t, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL) sessions.delete(t);
  }
}
setInterval(cleanup, 5 * 60 * 1000).unref();

function getToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function getSession(req) {
  const t = getToken(req);
  if (!t) return null;
  const s = sessions.get(t);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) {
    sessions.delete(t);
    return null;
  }
  return s;
}

function requireSession(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn.' });
  req.mailSession = s;
  next();
}

function normalizeLogin(body) {
  const protocol = String(body.protocol || 'imap').toLowerCase() === 'pop3' ? 'pop3' : 'imap';
  const host = String(body.host || '').trim();
  const user = String(body.user || '').trim();
  const pass = String(body.pass || '');
  const port = Number(body.port || (protocol === 'imap' ? 993 : 995));
  const secure = Boolean(body.secure);

  if (!host || !user || !pass) throw new Error('Vui lòng nhập đầy đủ máy chủ, email và mật khẩu.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port không hợp lệ.');

  return { protocol, host, port, secure, user, pass };
}

async function imapWith(session, work) {
  const client = new ImapFlow({
    host: session.host,
    port: session.port,
    secure: session.secure,
    // If using port 143 and secure=false, allow STARTTLS when the server supports it.
    doSTARTTLS: !session.secure,
    auth: { user: session.user, pass: session.pass },
    logger: false
  });

  let lock;
  try {
    await client.connect();
    lock = await client.getMailboxLock('INBOX');
    return await work(client);
  } finally {
    if (lock) lock.release();
    try { await client.logout(); } catch (_) {}
  }
}

class Pop3Client {
  constructor({ host, port, secure }) {
    this.host = host;
    this.port = port;
    this.secure = secure;
    this.socket = null;
    this.buffer = '';
    this.pending = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const onConnect = () => this._readResponse().then(resolve).catch(reject);
      this.socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host }, onConnect)
        : net.createConnection({ host: this.host, port: this.port }, onConnect);

      this.socket.setEncoding('utf8');
      this.socket.on('data', d => {
        this.buffer += d;
        this._drain();
      });
      this.socket.on('error', err => {
        while (this.pending.length) this.pending.shift().reject(err);
      });
      this.socket.setTimeout(30000, () => this.socket.destroy(new Error('POP3 timeout')));
    });
  }

  _drain() {
    while (this.pending.length) {
      const p = this.pending[0];
      const idx = this.buffer.indexOf('\r\n');
      if (idx < 0) return;

      const line = this.buffer.slice(0, idx);
      if (p.multiline) {
        const end = this.buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        const first = line;
        const body = this.buffer.slice(idx + 2, end);
        this.buffer = this.buffer.slice(end + 5);
        this.pending.shift().resolve({ first, body });
      } else {
        this.buffer = this.buffer.slice(idx + 2);
        this.pending.shift().resolve({ first: line, body: '' });
      }
    }
  }

  _readResponse(multiline = false) {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject, multiline });
      this._drain();
    });
  }

  command(cmd, multiline = false) {
    this.socket.write(cmd + '\r\n');
    return this._readResponse(multiline);
  }

  async login(user, pass) {
    let r = await this.command('USER ' + user);
    if (!r.first.startsWith('+OK')) throw new Error(r.first);
    r = await this.command('PASS ' + pass);
    if (!r.first.startsWith('+OK')) throw new Error('Authentication failed: ' + r.first);
  }

  async stat() {
    const r = await this.command('STAT');
    if (!r.first.startsWith('+OK')) throw new Error(r.first);
    const parts = r.first.split(/\s+/);
    return Number(parts[1]) || 0;
  }

  async list() {
    const r = await this.command('LIST', true);
    if (!r.first.startsWith('+OK')) throw new Error(r.first);
    return r.body.split('\r\n').filter(Boolean).map(line => {
      const [num, size] = line.trim().split(/\s+/);
      return { num: Number(num), size: Number(size) };
    }).filter(x => x.num);
  }

  async uidl() {
    const r = await this.command('UIDL', true);
    if (!r.first.startsWith('+OK')) return [];
    return r.body.split('\r\n').filter(Boolean).map(line => {
      const [num, uid] = line.trim().split(/\s+/);
      return { num: Number(num), uid };
    }).filter(x => x.num);
  }

  async retr(num) {
    const r = await this.command('RETR ' + num, true);
    if (!r.first.startsWith('+OK')) throw new Error(r.first);
    // POP3 dot-stuffing
    return r.body.split('\r\n').map(line => line.startsWith('..') ? line.slice(1) : line).join('\r\n');
  }

  async quit() {
    try { await this.command('QUIT'); } catch (_) {}
    try { this.socket.destroy(); } catch (_) {}
  }
}

async function pop3With(session, work) {
  const client = new Pop3Client(session);
  try {
    await client.connect();
    await client.login(session.user, session.pass);
    return await work(client);
  } finally {
    await client.quit();
  }
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'mail-viewer', version: 'flex-login-2026-09-01' });
});

app.post('/api/login', async (req, res) => {
  try {
    const session = normalizeLogin(req.body);

    // Verify credentials immediately.
    if (session.protocol === 'imap') {
      await imapWith(session, async () => true);
    } else {
      await pop3With(session, async () => true);
    }

    const t = token();
    sessions.set(t, { ...session, createdAt: Date.now() });

    res.json({
      ok: true,
      token: t,
      user: session.user,
      protocol: session.protocol,
      host: session.host,
      port: session.port
    });
  } catch (err) {
    console.error('Login failed:', err.message);
    res.status(401).json({
      error: err.message || 'Đăng nhập thất bại.'
    });
  }
});

app.post('/api/logout', (req, res) => {
  const t = getToken(req);
  if (t) sessions.delete(t);
  res.json({ ok: true });
});

app.get('/api/me', requireSession, (req, res) => {
  const s = req.mailSession;
  res.json({
    user: s.user,
    protocol: s.protocol,
    host: s.host,
    port: s.port
  });
});

app.get('/api/mails', requireSession, async (req, res) => {
  try {
    const s = req.mailSession;

    if (s.protocol === 'imap') {
      const messages = await imapWith(s, async client => {
        const exists = client.mailbox.exists || 0;
        if (!exists) return [];

        const start = exists > 50 ? `${exists - 49}:*` : '1:*';
        const rows = [];
        for await (const msg of client.fetch(start, { envelope: true, uid: true })) {
          rows.push({
            id: msg.uid,
            from: (msg.envelope.from || []).map(x => x.address || x.name || '').join(', '),
            subject: msg.envelope.subject || '(Không có tiêu đề)',
            date: msg.envelope.date || null
          });
        }
        return rows.reverse();
      });
      return res.json(messages);
    }

    const messages = await pop3With(s, async client => {
      const list = await client.list();
      const uidls = await client.uidl();
      const latest = list.slice(-50).reverse();
      const uidMap = new Map(uidls.map(x => [x.num, x.uid]));
      const rows = [];

      // POP3 has no universal lightweight header API, so retrieve the latest messages.
      for (const item of latest) {
        try {
          const source = await client.retr(item.num);
          const parsed = await simpleParser(source);
          rows.push({
            id: item.num,
            uid: uidMap.get(item.num) || String(item.num),
            from: parsed.from?.text || '',
            subject: parsed.subject || '(Không có tiêu đề)',
            date: parsed.date || null
          });
        } catch (e) {
          console.error('POP3 RETR failed:', item.num, e.message);
        }
      }
      return rows;
    });

    res.json(messages);
  } catch (err) {
    console.error('Mail list failed:', err.message);
    res.status(502).json({ error: err.message || 'Không thể đọc hộp thư.' });
  }
});

app.get('/api/mails/:id', requireSession, async (req, res) => {
  try {
    const s = req.mailSession;
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID email không hợp lệ.' });
    }

    if (s.protocol === 'imap') {
      const result = await imapWith(s, async client => {
        const msg = await client.fetchOne(String(id), { source: true }, { uid: true });
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
      return res.json(result);
    }

    const result = await pop3With(s, async client => {
      const source = await client.retr(id);
      const parsed = await simpleParser(source);
      return {
        subject: parsed.subject || '(Không có tiêu đề)',
        from: parsed.from?.text || '',
        date: parsed.date || null,
        body: parsed.html || `<pre>${escapeHtml(parsed.text || '')}</pre>`
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Mail detail failed:', err.message);
    res.status(502).json({ error: err.message || 'Không thể đọc email.' });
  }
});

function escapeHtml(v) {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mail Viewer listening on 0.0.0.0:${PORT}`);
});
