/**
 * julia_brain.js — Cerveau de Julia
 * ============================================================
 * Rôle :
 *   1. Reçoit les messages entrants depuis julia_wa.js (/incoming)
 *   2. Fait raisonner Mistral (cerveau principal) pour décider de la
 *      réponse et des actions
 *   3. Exécute les actions WhatsApp en appelant l'API du bridge
 *      (julia_wa.js) — envoyer message, réagir, lister chats, etc.
 *
 * SÉCURITÉ IMPORTANTE :
 *   Seul JULIA_OWNER_NUMBER (toi) peut déclencher des ACTIONS
 *   (envoyer un message à quelqu'un, réagir, etc.).
 *   Les autres personnes qui écrivent à Julia reçoivent une réponse
 *   conversationnelle simple, mais ne peuvent PAS lui faire exécuter
 *   des commandes — sinon n'importe qui pourrait détourner Julia
 *   en lui écrivant "envoie ce message à X".
 */

require('dotenv').config({ path: '../.env' });
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const PORT = process.env.BRAIN_PORT || 4001;
const WA_BRIDGE_URL = `http://127.0.0.1:${process.env.WA_BRIDGE_PORT || 4000}`;
const OWNER_NUMBER = process.env.JULIA_OWNER_NUMBER;

// Extrait le numéro pur d'un JID WhatsApp (enlève @s.whatsapp.net, :device, etc.)
// et compare une égalité EXACTE — évite qu'un numéro qui commence par les
// mêmes chiffres que le tien soit pris pour toi (faille de sécurité sinon).
function estLeOwner(jid) {
  if (!jid || !OWNER_NUMBER) return false;
  const numero = jid.split('@')[0].split(':')[0];
  return numero === OWNER_NUMBER;
}

const pcControl = require('./julia_pc_control');
const { checkRoomPresence } = require('./julia_presence');
const WEB_TOKEN = process.env.JULIA_WEB_TOKEN;

// ── Météo (Open-Meteo, gratuit, sans clé API) ──────────────────────
const WEATHER_CODES = {
  0: 'Ciel dégagé', 1: 'Plutôt dégagé', 2: 'Partiellement nuageux', 3: 'Couvert',
  45: 'Brouillard', 48: 'Brouillard givrant',
  51: 'Bruine légère', 53: 'Bruine modérée', 55: 'Bruine dense',
  61: 'Pluie légère', 63: 'Pluie modérée', 65: 'Pluie forte',
  71: 'Neige légère', 73: 'Neige modérée', 75: 'Neige forte',
  80: 'Averses légères', 81: 'Averses modérées', 82: 'Averses violentes',
  95: 'Orage', 96: 'Orage avec grêle légère', 99: 'Orage avec grêle forte',
};

// ── Gemini — analyse d'image (vision) ──────────────────────────────
async function analyzeImageWithGemini(imagePath, question) {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const { data } = await axios.post(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
    {
      contents: [
        {
          parts: [
            { text: question || 'Décris cette image en détail, en français.' },
            { inline_data: { mime_type: mimeType, data: base64Image } },
          ],
        },
      ],
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': process.env.GEMINI_API_KEY,
      },
      timeout: 20000,
    }
  );

  const texte = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Aucune réponse de Gemini.';
  return { description: texte };
}

// ── Shodan — recherche OSINT ────────────────────────────────────────
async function shodanSearch(query) {
  const { data } = await axios.get('https://api.shodan.io/shodan/host/search', {
    params: { key: process.env.SHODAN_API_KEY, query },
    timeout: 15000,
  });

  const resultats = (data.matches || []).slice(0, 8).map((m) => ({
    ip: m.ip_str,
    port: m.port,
    organisation: m.org || 'inconnue',
    pays: m.location?.country_name || 'inconnu',
    produit: m.product || 'inconnu',
  }));

  return { total: data.total, resultats };
}

async function shodanHostInfo(ip) {
  const { data } = await axios.get(`https://api.shodan.io/shodan/host/${ip}`, {
    params: { key: process.env.SHODAN_API_KEY },
    timeout: 15000,
  });

  return {
    ip: data.ip_str,
    organisation: data.org || 'inconnue',
    pays: data.country_name || 'inconnu',
    ports_ouverts: data.ports || [],
    os: data.os || 'inconnu',
  };
}
async function getWeather(city) {
  const geo = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
    params: { name: city, count: 1, language: 'fr' },
  });
  if (!geo.data.results?.length) return { error: `Ville introuvable : ${city}` };

  const place = geo.data.results[0];
  const forecast = await axios.get('https://api.open-meteo.com/v1/forecast', {
    params: {
      latitude: place.latitude,
      longitude: place.longitude,
      current: 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m',
      daily: 'temperature_2m_max,temperature_2m_min,weather_code',
      timezone: 'auto',
      forecast_days: 1,
    },
  });
  const c = forecast.data.current;
  const d = forecast.data.daily;

  return {
    ville: place.name,
    pays: place.country || '',
    temperature: c.temperature_2m,
    conditions: WEATHER_CODES[c.weather_code] || 'Inconnu',
    humidite: c.relative_humidity_2m,
    vent_kmh: c.wind_speed_10m,
    min_jour: d.temperature_2m_min[0],
    max_jour: d.temperature_2m_max[0],
  };
}

const app = express();
app.use(express.json());
app.use(express.static('../web')); // sert l'interface Jarvis

// ── Mémoire de conversation (en RAM, par chat) ─────────────────────
// { chatId: [{role, content}, ...] }
const conversations = {};
const MAX_HISTORY = 20;

// ── Personnalité de Julia ──────────────────────────────────────────
const SYSTEM_PROMPT = `Tu es Julia, l'assistante IA personnelle de Mcamara — une intelligence
type Jarvis/Karen (Marvel) : posée, futée, un peu directe, jamais robotique.

Règles de personnalité :
- Tu parles français, ton naturel et chaleureux, jamais formel ni scolaire
- Réponses courtes et directes en conversation normale (1-3 phrases)
- Tu peux avoir de l'humour léger, mais tu restes fiable et précise sur les tâches sérieuses
- Tu ne dis JAMAIS "en tant qu'IA" — tu es Julia, point.
- Si on te demande d'agir (envoyer un message, réagir, etc.) et que tu as les outils pour le faire, tu le fais directement au lieu de juste décrire.
- Tu ne révèles jamais de clés API, mots de passe, ou infos sensibles dans une conversation.
- Pour la détection de présence (check_room_presence) : ne donne JAMAIS un nombre exact de personnes, c'est une estimation heuristique seulement (aucun mouvement / activité légère / forte activité). Sois honnête sur cette limite si on te pose la question.
- Avant d'utiliser shutdown_pc, restart_pc, delete_file, ou kill_process, CONFIRME toujours d'abord avec Mcamara en une phrase avant d'agir, sauf s'il a déjà dit explicitement "vas-y" ou "confirme" dans le message.`;

// ── Définition des outils (tool-calling) ───────────────────────────
const TOOLS = [
  {
    name: 'send_whatsapp_message',
    description:
      "Envoie un message texte WhatsApp à un contact ou un groupe précis (différent du chat en cours).",
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description:
            'JID du destinataire, ex: "224xxxxxxxxx@s.whatsapp.net" pour un contact, ou "xxxxx@g.us" pour un groupe',
        },
        text: { type: 'string', description: 'Le message à envoyer' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'list_whatsapp_chats',
    description: 'Liste tous les contacts et groupes WhatsApp connus de Julia.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_group_info',
    description: "Récupère les infos d'un groupe WhatsApp (nom, participants).",
    input_schema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'JID du groupe, ex: "xxxxx@g.us"' },
      },
      required: ['groupId'],
    },
  },
  {
    name: 'react_to_message',
    description: 'Réagit à un message avec un emoji.',
    input_schema: {
      type: 'object',
      properties: {
        chatId: { type: 'string' },
        messageId: { type: 'string' },
        emoji: { type: 'string', description: 'Ex: "👍", "❤️", "😂"' },
      },
      required: ['chatId', 'messageId', 'emoji'],
    },
  },
  {
    name: 'open_app',
    description: 'Ouvre une application ou un fichier sur le PC de Mcamara.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nom ou chemin de l\'appli/fichier à ouvrir, ex: "chrome", "notepad", "C:\\\\dossier\\\\fichier.txt"' },
      },
      required: ['name'],
    },
  },
  {
    name: 'open_folder',
    description: 'Ouvre un dossier dans l\'explorateur Windows.',
    input_schema: {
      type: 'object',
      properties: {
        folderPath: { type: 'string', description: 'Chemin du dossier, ex: "C:\\\\Users\\\\Mcamara\\\\Documents"' },
      },
      required: ['folderPath'],
    },
  },
  {
    name: 'run_command',
    description: 'Exécute une commande shell sur le PC (usage avancé, prudence).',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'La commande à exécuter' },
      },
      required: ['command'],
    },
  },
  {
    name: 'take_screenshot',
    description: 'Prend une capture d\'écran du PC.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_system_info',
    description: 'Récupère les infos système du PC (RAM, CPU, uptime).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_weather',
    description: 'Donne la météo actuelle et du jour pour une ville donnée.',
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'Nom de la ville, ex: "Conakry"' },
      },
      required: ['city'],
    },
  },
  {
    name: 'check_room_presence',
    description:
      "Détecte si quelqu'un bouge/est présent près du PC, via le signal WiFi (RSSI). NE donne PAS un nombre exact de personnes — seulement une estimation : aucun mouvement / activité légère (~1 personne) / forte activité (~plusieurs personnes). Prend environ 4 secondes.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_processes',
    description: 'Liste les programmes en cours d\'exécution sur le PC.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'kill_process',
    description: 'Ferme de force un programme (par son nom, ex: "chrome.exe", ou son PID).',
    input_schema: {
      type: 'object',
      properties: { nameOrPid: { type: 'string' } },
      required: ['nameOrPid'],
    },
  },
  {
    name: 'shutdown_pc',
    description: 'Éteint le PC après un délai (par défaut 30s pour pouvoir annuler).',
    input_schema: {
      type: 'object',
      properties: { delaySeconds: { type: 'number' } },
    },
  },
  {
    name: 'restart_pc',
    description: 'Redémarre le PC après un délai (par défaut 30s).',
    input_schema: {
      type: 'object',
      properties: { delaySeconds: { type: 'number' } },
    },
  },
  {
    name: 'cancel_shutdown',
    description: 'Annule un arrêt/redémarrage programmé du PC.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'lock_pc',
    description: 'Verrouille la session Windows immédiatement.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_directory',
    description: 'Liste les fichiers/dossiers présents dans un chemin donné.',
    input_schema: {
      type: 'object',
      properties: { dirPath: { type: 'string' } },
      required: ['dirPath'],
    },
  },
  {
    name: 'read_file',
    description: 'Lit le contenu texte d\'un fichier (limité à 8000 caractères).',
    input_schema: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    },
  },
  {
    name: 'write_file',
    description: 'Écrit/remplace le contenu d\'un fichier texte.',
    input_schema: {
      type: 'object',
      properties: { filePath: { type: 'string' }, content: { type: 'string' } },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: 'Supprime définitivement un fichier. Action irréversible — à utiliser avec prudence.',
    input_schema: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    },
  },
  {
    name: 'volume_control',
    description: 'Monte, baisse ou coupe le son du PC.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['up', 'down', 'mute'] },
        steps: { type: 'number', description: 'Nombre de crans pour up/down (défaut 5)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'get_clipboard',
    description: 'Récupère le contenu actuel du presse-papier.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_clipboard',
    description: 'Met un texte dans le presse-papier.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'open_url',
    description: 'Ouvre un lien web dans le navigateur par défaut.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'analyze_image',
    description: 'Analyse une image (capture d\'écran, photo reçue...) avec Gemini Vision et décrit ce qu\'elle contient.',
    input_schema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: 'Chemin du fichier image sur le PC' },
        question: { type: 'string', description: 'Question précise sur l\'image (optionnel)' },
      },
      required: ['imagePath'],
    },
  },
  {
    name: 'shodan_search',
    description: 'Recherche OSINT Shodan : trouve des appareils/services exposés sur internet correspondant à une requête (ex: "webcam", "apache country:GN").',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'shodan_host_info',
    description: 'Donne les infos Shodan détaillées pour une IP précise (ports ouverts, OS, organisation).',
    input_schema: {
      type: 'object',
      properties: { ip: { type: 'string' } },
      required: ['ip'],
    },
  },
];

// ── Exécution réelle des outils (appelle le bridge WA) ─────────────
async function executeTool(name, input) {
  switch (name) {
    case 'send_whatsapp_message':
      await axios.post(`${WA_BRIDGE_URL}/send`, { to: input.to, text: input.text });
      return { success: true };

    case 'list_whatsapp_chats': {
      const { data } = await axios.get(`${WA_BRIDGE_URL}/chats`);
      return data;
    }

    case 'get_group_info': {
      const { data } = await axios.get(`${WA_BRIDGE_URL}/group/${input.groupId}`);
      return data;
    }

    case 'react_to_message':
      await axios.post(`${WA_BRIDGE_URL}/react`, input);
      return { success: true };

    case 'open_app':
      return pcControl.openApp(input.name);

    case 'open_folder':
      return pcControl.openFolder(input.folderPath);

    case 'run_command':
      return pcControl.runCommand(input.command);

    case 'take_screenshot':
      return pcControl.takeScreenshot();

    case 'get_system_info':
      return pcControl.getSystemInfo();

    case 'get_weather':
      return getWeather(input.city);

    case 'check_room_presence':
      return checkRoomPresence();

    case 'list_processes':
      return pcControl.listProcesses();

    case 'kill_process':
      return pcControl.killProcess(input.nameOrPid);

    case 'shutdown_pc':
      return pcControl.shutdownPC(input.delaySeconds);

    case 'restart_pc':
      return pcControl.restartPC(input.delaySeconds);

    case 'cancel_shutdown':
      return pcControl.cancelShutdown();

    case 'lock_pc':
      return pcControl.lockPC();

    case 'list_directory':
      return pcControl.listDirectory(input.dirPath);

    case 'read_file':
      return pcControl.readFile(input.filePath);

    case 'write_file':
      return pcControl.writeFile(input.filePath, input.content);

    case 'delete_file':
      return pcControl.deleteFile(input.filePath);

    case 'volume_control':
      if (input.action === 'mute') return pcControl.setVolumeMute();
      return pcControl.volumeStep(input.action, input.steps);

    case 'get_clipboard':
      return pcControl.getClipboard();

    case 'set_clipboard':
      return pcControl.setClipboard(input.text);

    case 'open_url':
      return pcControl.openUrl(input.url);

    case 'analyze_image':
      return analyzeImageWithGemini(input.imagePath, input.question);

    case 'shodan_search':
      return shodanSearch(input.query);

    case 'shodan_host_info':
      return shodanHostInfo(input.ip);

    default:
      return { error: `Outil inconnu: ${name}` };
  }
}

// Convertit notre liste d'outils (format lisible) vers le format attendu
// par l'API Mistral (compatible OpenAI: { type: 'function', function: {...} })
function outilsFormatMistral() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// ── Appel Mistral (cerveau principal, avec tools) ───────────────────
async function askMistral(history, allowTools) {
  const { data } = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    {
      model: 'mistral-large-latest',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
      tools: allowTools ? outilsFormatMistral() : undefined,
      tool_choice: allowTools ? 'auto' : undefined,
    },
    {
      headers: { Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
      timeout: 30000,
    }
  );
  return data.choices[0].message;
}

// ── Boucle principale de raisonnement ───────────────────────────────
async function reason(chatId, allowTools) {
  let history = conversations[chatId];
  let finalText = '';

  try {
    let message = await askMistral(history, allowTools);
    let iterations = 0;
    const MAX_ITERATIONS = 8;

    // Boucle tant que Mistral demande à utiliser des outils
    while (message.tool_calls?.length && iterations < MAX_ITERATIONS) {
      iterations++;
      history.push({ role: 'assistant', content: message.content || '', tool_calls: message.tool_calls });

      for (const call of message.tool_calls) {
        let result;
        try {
          const args = JSON.parse(call.function.arguments || '{}');
          result = await executeTool(call.function.name, args);
        } catch (toolErr) {
          result = { error: `Échec de l'outil ${call.function.name}: ${toolErr.message}` };
        }
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(result),
        });
      }

      message = await askMistral(history, allowTools);
    }

    finalText = message.content || '';
    history.push({ role: 'assistant', content: finalText });
  } catch (err) {
    console.log('❌ Erreur Mistral:', err.response?.data?.message || err.message);
    finalText = "Désolée, j'ai un problème technique pour réfléchir là — réessaie dans un instant.";
    history.push({ role: 'assistant', content: finalText });
  }

  // Limite la taille de l'historique — coupe uniquement à une frontière sûre
  // (un message utilisateur texte simple), jamais en plein milieu d'un
  // échange d'outil, sinon l'API Mistral rejette la requête suivante.
  if (history.length > MAX_HISTORY) {
    let coupe = history.length - MAX_HISTORY;
    while (coupe < history.length && !(history[coupe].role === 'user' && typeof history[coupe].content === 'string')) {
      coupe++;
    }
    conversations[chatId] = history.slice(coupe);
  }

  return finalText;
}

// ══════════════════════════════════════════════════════════════════
// Route : réception des messages entrants depuis julia_wa.js
// ══════════════════════════════════════════════════════════════════
app.post('/incoming', async (req, res) => {
  const { chatId, senderId, isGroup, text, pushName } = req.body;
  res.json({ received: true }); // on répond tout de suite, traitement async

  const isOwner = estLeOwner(senderId);

  if (!conversations[chatId]) conversations[chatId] = [];
  conversations[chatId].push({ role: 'user', content: `[${pushName}]: ${text}` });

  try {
    const reply = await reason(chatId, isOwner); // outils activés SEULEMENT pour le owner

    if (reply) {
      await axios.post(`${WA_BRIDGE_URL}/send`, { to: chatId, text: reply });
    }
  } catch (err) {
    console.log('❌ Erreur de traitement:', err.message);
  }
});

// ══════════════════════════════════════════════════════════════════
// Route : chat depuis l'interface web Jarvis (protégée par token)
// ══════════════════════════════════════════════════════════════════
app.post('/chat', async (req, res) => {
  const { token, message } = req.body;

  if (!WEB_TOKEN || token !== WEB_TOKEN) {
    return res.status(401).json({ error: 'Token invalide' });
  }

  const chatId = 'web-session'; // conversation dédiée à l'interface web
  if (!conversations[chatId]) conversations[chatId] = [];
  conversations[chatId].push({ role: 'user', content: message });

  try {
    const reply = await reason(chatId, true); // outils toujours activés (session déjà protégée par token)
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// Route : synthèse vocale (relais vers julia_voice.py)
// ══════════════════════════════════════════════════════════════════
const VOICE_URL = process.env.VOICE_SERVICE_URL || 'http://127.0.0.1:5001';

app.post('/speak', async (req, res) => {
  const { token, text } = req.body;
  if (!WEB_TOKEN || token !== WEB_TOKEN) {
    return res.status(401).json({ error: 'Token invalide' });
  }
  try {
    const voiceRes = await axios.post(`${VOICE_URL}/speak`, { text }, { responseType: 'arraybuffer' });
    res.set('Content-Type', 'audio/mpeg');
    res.send(voiceRes.data);
  } catch (err) {
    res.status(503).json({ error: 'Service voix indisponible (julia_voice.py est-il lancé ?)' });
  }
});

// ══════════════════════════════════════════════════════════════════
// Route : transcription vocale (relais vers julia_voice.py /transcribe)
// ══════════════════════════════════════════════════════════════════
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const FormData = require('form-data');

app.post('/listen', upload.single('audio'), async (req, res) => {
  const { token } = req.body;
  if (!WEB_TOKEN || token !== WEB_TOKEN) {
    return res.status(401).json({ error: 'Token invalide' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun audio reçu' });
  }

  try {
    const form = new FormData();
    form.append('audio', req.file.buffer, { filename: 'enregistrement.webm' });

    const voiceRes = await axios.post(`${VOICE_URL}/transcribe`, form, {
      headers: form.getHeaders(),
    });

    res.json(voiceRes.data);
  } catch (err) {
    res.status(503).json({ error: 'Service voix indisponible (julia_voice.py est-il lancé ?)' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`🧠 Julia Brain démarré sur http://127.0.0.1:${PORT}`);
});
