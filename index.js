const express = require('express');
const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const cors = require('cors');
const pino = require('pino');
const { Boom } = require('@hapi/boom');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

function generateId() {
  return 'ALMEER_' + Math.random().toString(36).substring(2, 15).toUpperCase();
}

function cleanupSession(sessionId) {
  try {
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    if (fs.existsSync(sessionPath)) fse.removeSync(sessionPath);
    const session = sessions.get(sessionId);
    if (session?.sock) { try { session.sock.end(); } catch (e) {} }
    sessions.delete(sessionId);
    console.log(`🗑️ Cleaned: ${sessionId}`);
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

function encodeSession(sessionPath) {
  try {
    const credsPath = path.join(sessionPath, 'creds.json');
    if (!fs.existsSync(credsPath)) {
      console.log('❌ creds.json not found');
      return null;
    }
    const files = {};
    const allFiles = fs.readdirSync(sessionPath);
    for (const file of allFiles) {
      const filePath = path.join(sessionPath, file);
      if (fs.statSync(filePath).isFile()) {
        files[file] = fs.readFileSync(filePath, 'utf8');
      }
    }
    const encoded = Buffer.from(JSON.stringify(files)).toString('base64');
    console.log(`✅ Encoded ${Object.keys(files).length} session files`);
    return encoded;
  } catch (e) {
    console.error('Encode error:', e.message);
    return null;
  }
}

// ── API: PAIR ──────────────────────────────────────────────────
app.post('/api/pair', async (req, res) => {
  console.log('\n📱 Pair request received');
  console.log('Body:', req.body);

  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, message: 'Phone number is required' });
  }

  const cleanPhone = phone.replace(/[^0-9]/g, '');
  console.log(`📞 Clean phone: ${cleanPhone} (length: ${cleanPhone.length})`);

  if (cleanPhone.length < 7) {
    return res.status(400).json({ success: false, message: 'Invalid phone number — include country code' });
  }

  const sessionId = generateId();
  const sessionPath = path.join(__dirname, 'sessions', sessionId);

  try {
    fse.ensureDirSync(sessionPath);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📦 WA Version: ${version.join('.')}`);

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      printQRInTerminal: false,
      browser: ['ALMEER XMD', 'Chrome', '120.0.0'],
      syncFullHistory: false
    });

    sessions.set(sessionId, { sock, phone: cleanPhone, status: 'pending', sessionString: null, createdAt: Date.now() });

    console.log('⏳ Waiting 3s before requesting pairing code...');
    await new Promise(r => setTimeout(r, 3000));

    let code;
    try {
      code = await sock.requestPairingCode(cleanPhone);
      console.log(`✅ Code: ${code}`);
    } catch (err) {
      console.error('❌ Pairing code error:', err.message);
      cleanupSession(sessionId);
      return res.status(500).json({ success: false, message: 'Failed to get pairing code: ' + err.message });
    }

    const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      console.log(`🔄 Connection: ${connection}`);

      if (connection === 'open') {
        console.log(`✅ Connected: ${sessionId}`);
        await saveCreds();
        await new Promise(r => setTimeout(r, 3000));

        const sessionString = encodeSession(sessionPath);
        const session = sessions.get(sessionId);
        if (session) {
          session.status = 'connected';
          session.sessionString = sessionString;
          sessions.set(sessionId, session);
        }
        setTimeout(() => cleanupSession(sessionId), 15 * 60 * 1000);
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 500;
        if (code === DisconnectReason.loggedOut) cleanupSession(sessionId);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    setTimeout(() => {
      const s = sessions.get(sessionId);
      if (s && s.status === 'pending') cleanupSession(sessionId);
    }, 5 * 60 * 1000);

    res.json({ success: true, code: formattedCode, sessionId, message: 'Pairing code generated!' });

  } catch (err) {
    console.error('❌ Pair error:', err.message);
    cleanupSession(sessionId);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ── API: STATUS ────────────────────────────────────────────────
app.get('/api/status/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.json({ status: 'not_found' });
  res.json({ status: session.status });
});

// ── API: SESSION STRING ────────────────────────────────────────
app.get('/api/session/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ success: false, message: 'Session not found or expired' });
  if (session.status !== 'connected') return res.status(400).json({ success: false, message: 'Not connected yet' });
  if (!session.sessionString) return res.status(500).json({ success: false, message: 'Session string not ready yet' });
  res.json({ success: true, sessionId: req.params.sessionId, sessionString: session.sessionString });
});

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  🤖 ALMEER XMD Pairing Site`);
  console.log(`  🌐 Port: ${PORT}`);
  console.log(`  ✅ Ready to pair WhatsApp sessions`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  fse.ensureDirSync(path.join(__dirname, 'sessions'));
});
  
