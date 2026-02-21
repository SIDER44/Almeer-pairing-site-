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

// Store active sessions
const sessions = new Map();

// ── GENERATE ID ────────────────────────────────────────────────
function generateId() {
  return 'ALMEER_' + Math.random().toString(36).substring(2, 15).toUpperCase();
}

// ── CLEANUP ────────────────────────────────────────────────────
function cleanupSession(sessionId) {
  try {
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    if (fs.existsSync(sessionPath)) {
      fse.removeSync(sessionPath);
    }
    const session = sessions.get(sessionId);
    if (session?.sock) {
      try { session.sock.end(); } catch (e) {}
    }
    sessions.delete(sessionId);
    console.log(`🗑️ Cleaned: ${sessionId}`);
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

// ── ENCODE SESSION ─────────────────────────────────────────────
function encodeSession(sessionPath) {
  try {
    const credsPath = path.join(sessionPath, 'creds.json');
    if (!fs.existsSync(credsPath)) {
      console.log('❌ creds.json not found at:', credsPath);
      return null;
    }

    const files = {};
    const allFiles = fs.readdirSync(sessionPath);
    console.log(`📁 Session files found: ${allFiles.join(', ')}`);

    for (const file of allFiles) {
      const filePath = path.join(sessionPath, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        files[file] = fs.readFileSync(filePath, 'utf8');
      }
    }

    const encoded = Buffer.from(JSON.stringify(files)).toString('base64');
    console.log(`✅ Session encoded — ${Object.keys(files).length} files, ${encoded.length} chars`);
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
    console.log('❌ No phone provided');
    return res.status(400).json({
      success: false,
      message: 'Phone number is required'
    });
  }

  const cleanPhone = phone.replace(/[^0-9]/g, '');
  console.log(`📞 Clean phone: ${cleanPhone}`);

  if (cleanPhone.length < 7) {
    return res.status(400).json({
      success: false,
      message: 'Invalid phone number — must include country code'
    });
  }

  const sessionId = generateId();
  const sessionPath = path.join(__dirname, 'sessions', sessionId);

  console.log(`🆔 Session ID: ${sessionId}`);

  try {
    fse.ensureDirSync(sessionPath);
    console.log(`📁 Session folder created: ${sessionPath}`);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    console.log('✅ Auth state loaded');

    const { version } = await fetchLatestBaileysVersion();
    console.log(`📦 WA Version: ${version.join('.')}`);

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

    console.log('⏳ Waiting 3s before requesting pairing code...');
    await new Promise(r => setTimeout(r, 3000));

    console.log(`📱 Requesting pairing code for: ${cleanPhone}`);

    let code;
    try {
      code = await sock.requestPairingCode(cleanPhone);
      console.log(`✅ Pairing code received: ${code}`);
    } catch (err) {
      console.error('❌ Pairing code error:', err.message);
      cleanupSession(sessionId);
      return res.status(500).json({
        success: false,
        message: 'Failed to get pairing code: ' + err.message
      });
    }

    const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
    console.log(`🔑 Formatted code: ${formattedCode}`);

    // Handle connection events
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      console.log(`🔄 Connection update: ${connection}`);

      if (connection === 'open') {
        console.log(`✅ WhatsApp connected: ${sessionId}`);
        await saveCreds();

        console.log('⏳ Waiting 3s for creds to fully save...');
        await new Promise(r => setTimeout(r, 3000));

        const sessionString = encodeSession(sessionPath);

        const session = sessions.get(sessionId);
        if (session) {
          session.status = 'connected';
          session.sessionString = sessionString;
          sessions.set(sessionId, session);
          console.log(`📦 Session ready: ${sessionId}`);
        }

        // Auto cleanup after 15 min
        setTimeout(() => cleanupSession(sessionId), 15 * 60 * 1000);
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode
          : 500;

        console.log(`⚠️ Connection closed — code: ${code}`);

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
        console.log(`⏰ Timeout cleanup: ${sessionId}`);
        cleanupSession(sessionId);
      }
    }, 5 * 60 * 1000);

    console.log(`✅ Sending code to client: ${formattedCode}`);
    res.json({
      success: true,
      code: formattedCode,
      sessionId,
      message: 'Pairing code generated!'
    });

  } catch (err) {
    console.error('❌ Pair error:', err.message);
    console.error(err.stack);
    cleanupSession(sessionId);
    res.status(500).json({
      success: false,
      message: 'Server error: ' + err.message
    });
  }
});

// ── API: STATUS ────────────────────────────────────────────────
app.get('/api/status/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  console.log(`📊 Status check: ${req.params.sessionId} = ${session?.status || 'not_found'}`);

  if (!session) return res.json({ status: 'not_found' });
  res.json({ status: session.status });
});

// ── API: GET SESSION STRING ────────────────────────────────────
app.get('/api/session/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      message: 'Session not found or expired'
    });
  }

  if (session.status !== 'connected') {
    return res.status(400).json({
      success: false,
      message: 'Not connected yet — status: ' + session.status
    });
  }

  if (!session.sessionString) {
    return res.status(500).json({
      success: false,
      message: 'Session string not ready yet — try again in a few seconds'
    });
  }

  console.log(`📤 Sending session string for: ${req.params.sessionId}`);
  res.json({
    success: true,
    sessionId: req.params.sessionId,
    sessionString: session.sessionString
  });
});

// ── PING ───────────────────────────────────────────────────────
app.get('/ping', (req, res) => {
  console.log('🏓 Ping received');
  res.send('pong');
});

// ── MAIN PAGE ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  🤖 ALMEER XMD Pairing Site`);
  console.log(`  🌐 Port: ${PORT}`);
  console.log(`  ✅ Ready to pair WhatsApp sessions`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  fse.ensureDirSync(path.join(__dirname, 'sessions'));
});
