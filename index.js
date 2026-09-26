const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { Boom } = require('@hapi/boom');

const CONFIG = {
  ONLY_GROUPS: [],
  SEND_WARNING_MESSAGE: true,
  WARNING_TEXT: function (senderName) {
    return 'Deleted a contact message and removed ' + senderName + ' automatically for violating group rules.';
  },
};

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const versionResult = await fetchLatestBaileysVersion();
  console.log('Using Baileys version: ' + JSON.stringify(versionResult.version));

  const sock = makeWASocket({
    version: versionResult.version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['ContactGuardBot', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  if (!sock.authState.creds.registered) {
    setTimeout(async function () {
      try {
        const phoneNumber = '201097991349';
        const code = await sock.requestPairingCode(phoneNumber);
        console.log('=================================');
        console.log('Your pairing code is: ' + code);
        console.log('=================================');
      } catch (err) {
        console.log('Pairing code request failed: ' + (err && err.message ? err.message : err));
        console.log('Full error: ' + JSON.stringify(err));
      }
    }, 5000);
  }

  sock.ev.on('connection.update', function (update) {
    const connection = update.connection;
    const lastDisconnect = update.lastDisconnect;
    const qr = update.qr;
    if (qr) {
      console.log('Scan this QR from WhatsApp (Linked devices):');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const boomError = new Boom(lastDisconnect && lastDisconnect.error);
      const statusCode = boomError.output ? boomError.output.statusCode : null;
      console.log('Connection closed. Status code: ' + statusCode);
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Reconnecting? ' + shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('Bot connected successfully and is now monitoring groups.');
    }
  });

  sock.ev.on('messages.upsert', async function (data) {
    const messages = data.messages;
    const type = data.type;
    if (type !== 'notify') return;
    for (let i = 0; i < messages.length; i++) {
      try {
        await handleMessage(sock, messages[i]);
      } catch (err) {
        console.error('Error handling message: ' + (err && err.message ? err.message : err));
      }
    }
  });
}

function messageHasContact(message) {
  if (!message) return false;
  if (message.contactMessage) return true;
  if (message.contactsArrayMessage) return true;
  return false;
}

async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid;
  if (!jid || jid.indexOf('@g.us') === -1) return;
  if (CONFIG.ONLY_GROUPS.length > 0 && CONFIG.ONLY_GROUPS.indexOf(jid) === -1) return;
  if (msg.key.fromMe) return;

  const content = msg.message;
  if (!messageHasContact(content)) return;

  const senderId = msg.key.participant || msg.participant;
  if (!senderId) return;

  await sock.sendMessage(jid, {
    delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: senderId },
  });

  await sock.groupParticipantsUpdate(jid, [senderId], 'remove');

  console.log('Deleted a contact message from ' + senderId + ' in ' + jid + ' and removed them.');

  if (CONFIG.SEND_WARNING_MESSAGE) {
    const senderName = senderId.split('@')[0];
    await sock.sendMessage(jid, { text: CONFIG.WARNING_TEXT(senderName) });
  }
}

startBot().catch(function (err) {
  console.error('Failed to start bot: ' + (err && err.message ? err.message : err));
});
