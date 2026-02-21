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
app.use(express.static(path.join(__dirname, 'public')));

// Store active sessions
const sessions = new Map();

// ── GENERATE SESSION ID ────────────────────────────────────────
function generateId() {
  return 'ALMEER_' + Math.random().toString(36).substring(2, 15).toUpperCase();
}

// ── CLEANUP SESSION ────────────────────────────────────────────
function cleanupSession(sessionId) {
  try {
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    if (fs.existsSync(sessionPath)) {
      fse.removeSync(sessionPath);
    }
    const session = sessions.get(sessionId);
    if (session?.sock) {
      session.sock.end();
    }
    sessions.delete(sessionId);
    console.log(`🗑️ Cleaned: ${sessionId}`);
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

// ── ENCODE SESSION TO ID STRING ────────────────────────────────
function encodeSession(sessionPath) {
  try {
    const credsPath = path.join(sessionPath, 'creds.json');
    if (!fs.existsSync(credsPath)) return null;

    const files = {};
    const allFiles = fs.readdirSync(sessionPath);

    for (const file of allFiles) {
      const filePath = path.join(sessionPath, file);
      const content = fs.readFileSync(filePath, 'utf8');
      files[file] = content;
    }

    const encoded = Buffer.from(JSON.stringify(files)).toString('base64');
    return encoded;
  } catch (e) {
    console.error('Encode error:', e.message);
    return null;
  }
}

// ── API: REQUEST PAIRING CODE ──────────────────────────────────
app.post('/api/pair', async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, message: 'Phone number required' });
  }

  const cleanPhone = phone.replace(/[^0-9]/g, '');

  if (cleanPhone.length < 10) {
    return res.status(400).json({ success: false, message: 'Invalid phone number' });
  }

  const sessionId = generateId();
  const sessionPath = path.join(__dirname, 'sessions', sessionId);

  try {
    fse.ensureDirSync(sessionPath);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          pino({ level: 'silent' })
        )
      },
      printQRInTerminal: false,
      browser: ['ALMEER XMD', 'Chrome', '120.0.0'],
      syncFullHistory: false
    });

    sessions.set(sessionId, {
      sock,
      phone: cleanPhone,
      status: 'pending',
      sessionString: null,
      createdAt: Date.now()
    });

    // Wait for socket to be ready
    await new Promise(r => setTimeout(r, 3000));

    // Request pairing code
    let code;
    try {
      code = await sock.requestPairingCode(cleanPhone);
    } catch (err) {
      cleanupSession(sessionId);
      return res.status(500).json({
        success: false,
        message: 'Failed to get pairing code. Check your number!'
      });
    }

    const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
    console.log(`📱 Code for ${cleanPhone}: ${formattedCode}`);

    // Handle connection
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log(`✅ Connected: ${sessionId}`);
        await saveCreds();

        // Wait for creds to fully save
        await new Promise(r => setTimeout(r, 2000));

        // Encode session to string
        const sessionString = encodeSession(sessionPath);

        const session = sessions.get(sessionId);
        if (session) {
          session.status = 'connected';
          session.sessionString = sessionString;
          sessions.set(sessionId, session);
        }

        console.log(`📦 Session encoded: ${sessionId}`);

        // Auto cleanup after 15 minutes
        setTimeout(() => cleanupSession(sessionId), 15 * 60 * 1000);
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode
          : 500;

        if (code === DisconnectReason.loggedOut) {
          cleanupSession(sessionId);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Auto cleanup if not connected in 5 min
    setTimeout(() => {
      const s = sessions.get(sessionId);
      if (s && s.status === 'pending') {
        cleanupSession(sessionId);
      }
    }, 5 * 60 * 1000);

    res.json({
      success: true,
      code: formattedCode,
      sessionId,
      message: 'Pairing code generated!'
    });

  } catch (err) {
    console.error('Pair error:', err.message);
    cleanupSession(sessionId);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── API: CHECK STATUS ──────────────────────────────────────────
app.get('/api/status/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.json({ status: 'not_found' });
  res.json({ status: session.status });
});

// ── API: GET SESSION ID STRING ─────────────────────────────────
app.get('/api/session/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ success: false, message: 'Session not found or expired' });
  }

  if (session.status !== 'connected') {
    return res.status(400).json({ success: false, message: 'Not connected yet' });
  }

  if (!session.sessionString) {
    return res.status(500).json({ success: false, message: 'Session string not ready yet' });
  }

  res.json({
    success: true,
    sessionId: req.params.sessionId,
    sessionString: session.sessionString
  });
});

// ── MAIN PAGE ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/ping', (req, res) => res.send('pong'));

// ── START ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  🤖 ALMEER XMD Pairing Site`);
  console.log(`  🌐 Port: ${PORT}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  fse.ensureDirSync(path.join(__dirname, 'sessions'));
});
