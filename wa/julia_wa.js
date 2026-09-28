/**
 * julia_wa.js — Bridge WhatsApp de Julia
 * ============================================================
 * Rôle :
 *   1. Se connecte à WhatsApp Web via Baileys (pairing code)
 *   2. Transfère chaque message entrant au cerveau (julia_brain.js)
 *   3. Expose une API HTTP locale pour que le cerveau puisse
 *      CONTRÔLER WhatsApp (envoyer, réagir, lire, lister les chats...)
 *
 * Connexion stabilisée avec fetchLatestBaileysVersion + délai 8s
 * (méthode validée dans le guide KAREN 2.2, réutilisée ici).
 */

require('dotenv').config({ path: '../.env' });
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const PORT = process.env.WA_BRIDGE_PORT || 4000;
const BRAIN_URL = `http://127.0.0.1:${process.env.BRAIN_PORT || 4001}`;
const OWNER_NUMBER = process.env.JULIA_OWNER_NUMBER; // ton numéro, sans +

// Dossier où Julia stocke tous les fichiers reçus (créé automatiquement)
const DOSSIER_FICHIERS = path.join(__dirname, 'fichiers_recus');
if (!fs.existsSync(DOSSIER_FICHIERS)) fs.mkdirSync(DOSSIER_FICHIERS);

// Extrait le numéro pur d'un JID et compare une égalité EXACTE (voir julia_brain.js)
function estLeOwner(jid) {
  if (!jid || !OWNER_NUMBER) return false;
  const numero = jid.split('@')[0].split(':')[0];
  return numero === OWNER_NUMBER;
}

let sock = null;
let codeDejaDemande = false;
const chatsConnus = {}; // { jid: { id, name, isGroup } } — Baileys n'a plus de store intégré

const app = express();
app.use(express.json());

// ── Connexion WhatsApp ─────────────────────────────────────────────
async function connecterWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_julia');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    markOnlineOnConnect: false, // évite de couper les notifs sur ton tel
  });

  sock.ev.on('creds.update', saveCreds);

  // Alimente notre propre liste de chats connus (contacts synchronisés)
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      chatsConnus[c.id] = { id: c.id, name: c.name || c.notify || c.id, isGroup: c.id.endsWith('@g.us') };
    }
  });
  sock.ev.on('contacts.update', (contacts) => {
    for (const c of contacts) {
      if (chatsConnus[c.id]) chatsConnus[c.id].name = c.name || c.notify || chatsConnus[c.id].name;
    }
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (
      connection === 'connecting' &&
      !sock.authState.creds.registered &&
      !codeDejaDemande
    ) {
      codeDejaDemande = true;
      setTimeout(async () => {
        if (!OWNER_NUMBER) {
          console.log('⚠️  JULIA_OWNER_NUMBER manquant dans .env');
          return;
        }
        const code = await sock.requestPairingCode(OWNER_NUMBER);
        console.log(`\n🔑 TON CODE JULIA : ${code}\n`);
      }, 8000);
    }

    if (connection === 'close') {
      codeDejaDemande = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('❌ Connexion fermée, code:', code);
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(connecterWhatsApp, 5000);
      } else {
        console.log('🔒 Déconnecté définitivement (logout). Supprime ./auth_julia pour reconnecter.');
      }
    }

    if (connection === 'open') {
      console.log('✅ Julia connectée à WhatsApp !');
    }
  });

  // ── Messages entrants → transférés au cerveau ──────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const chatId = msg.key.remoteJid;
      const isGroup = chatId.endsWith('@g.us');
      const senderId = isGroup ? msg.key.participant : chatId;
      const isOwner = estLeOwner(senderId);

      if (!chatsConnus[chatId]) {
        chatsConnus[chatId] = { id: chatId, name: msg.pushName || chatId, isGroup };
      }

      // ── Détection et stockage automatique des fichiers (owner uniquement) ──
      const typeMedia = Object.keys(msg.message).find((k) =>
        ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage'].includes(k)
      );

      if (typeMedia && isOwner) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const mediaInfo = msg.message[typeMedia];
          const nomOriginal = mediaInfo.fileName || `${typeMedia}_${Date.now()}`;
          const nomFichier = `${Date.now()}_${nomOriginal}`.replace(/[/\\?%*:|"<>]/g, '_');
          const cheminComplet = path.join(DOSSIER_FICHIERS, nomFichier);

          fs.writeFileSync(cheminComplet, buffer);
          console.log(`📁 Fichier stocké : ${nomFichier}`);

          await sock.sendMessage(chatId, {
            text: `📁 Fichier reçu et stocké sur le PC : ${nomFichier}`,
          });
        } catch (err) {
          console.log('⚠️  Erreur téléchargement fichier:', err.message);
        }
        continue; // pas besoin d'envoyer un fichier au cerveau pour texte
      }

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      if (!text) continue; // pour l'instant : texte uniquement pour la conversation

      try {
        await axios.post(`${BRAIN_URL}/incoming`, {
          chatId,
          senderId,
          isGroup,
          text,
          pushName: msg.pushName || '',
          messageId: msg.key.id,
        });
      } catch (err) {
        console.log('⚠️  Erreur transfert vers le cerveau:', err.message);
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════════
// API DE CONTRÔLE — le cerveau appelle ces routes pour agir sur WhatsApp
// ══════════════════════════════════════════════════════════════════

// Envoyer un message texte à un contact ou groupe
app.post('/send', async (req, res) => {
  try {
    const { to, text } = req.body; // to = "224xxxxxxxxx@s.whatsapp.net" ou "xxxx@g.us"
    await sock.sendMessage(to, { text });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Réagir à un message (emoji)
app.post('/react', async (req, res) => {
  try {
    const { chatId, messageId, emoji, participant } = req.body;
    await sock.sendMessage(chatId, {
      react: {
        text: emoji,
        key: { remoteJid: chatId, id: messageId, participant },
      },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Marquer un chat comme lu
app.post('/mark-read', async (req, res) => {
  try {
    const { chatId, messageId, participant } = req.body;
    await sock.readMessages([{ remoteJid: chatId, id: messageId, participant }]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lister tous les chats (contacts + groupes) connus
app.get('/chats', async (req, res) => {
  try {
    res.json({ chats: Object.values(chatsConnus) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Récupérer les infos d'un groupe (participants, nom, etc.)
app.get('/group/:groupId', async (req, res) => {
  try {
    const metadata = await sock.groupMetadata(req.params.groupId);
    res.json({ metadata });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Statut de la connexion
app.get('/status', (req, res) => {
  res.json({
    connected: !!sock?.user,
    user: sock?.user || null,
  });
});

app.listen(PORT, () => {
  console.log(`📡 Julia WA Bridge démarré sur http://127.0.0.1:${PORT}`);
  connecterWhatsApp();
});
