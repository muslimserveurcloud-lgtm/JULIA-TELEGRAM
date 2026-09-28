/**
 * julia_pc_control.js — Contrôle du PC par Julia
 * ============================================================
 * Fonctions exécutées LOCALEMENT sur le PC où tourne julia_brain.js.
 * Appelées comme "outils" par le cerveau (tool-calling Mistral).
 *
 * ⚠️ Puissant : run_command peut exécuter n'importe quelle commande
 * système. Protégé par l'authentification owner (WhatsApp) et le
 * token web (.env) — ne jamais exposer sans ces protections.
 */

const { exec } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

function execPromise(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: error.message, stderr });
      } else {
        resolve({ success: true, output: stdout.trim() });
      }
    });
  });
}

// Ouvre une application ou un fichier (Windows: 'start', via cmd)
async function openApp(name) {
  return execPromise(`start "" "${name}"`);
}

// Ouvre un dossier dans l'explorateur Windows
async function openFolder(folderPath) {
  return execPromise(`explorer "${folderPath}"`);
}

// Exécute une commande shell arbitraire (owner uniquement, côté brain)
async function runCommand(command) {
  return execPromise(command);
}

// Capture d'écran — nécessite le package "screenshot-desktop"
async function takeScreenshot() {
  const screenshot = require('screenshot-desktop');
  const outputDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  const filename = `screenshot_${Date.now()}.png`;
  const filepath = path.join(outputDir, filename);

  await screenshot({ filename: filepath });
  return { success: true, filepath };
}

// Infos système de base
function getSystemInfo() {
  return {
    plateforme: os.platform(),
    hostname: os.hostname(),
    memoireLibreGo: (os.freemem() / 1e9).toFixed(2),
    memoireTotaleGo: (os.totalmem() / 1e9).toFixed(2),
    cpu: os.cpus()[0]?.model || 'inconnu',
    uptimeHeures: (os.uptime() / 3600).toFixed(1),
  };
}

// ── Processus ────────────────────────────────────────────────────
async function listProcesses() {
  const result = await execPromise('tasklist /FO CSV /NH');
  if (!result.success) return result;
  const processes = result.output
    .split('\n')
    .filter(Boolean)
    .slice(0, 60) // évite une réponse énorme
    .map((line) => {
      const parts = line.replace(/"/g, '').split(',');
      return { nom: parts[0], pid: parts[1], memoire: parts[4] };
    });
  return { success: true, processes };
}

async function killProcess(nameOrPid) {
  const isPid = /^\d+$/.test(nameOrPid);
  const cmd = isPid ? `taskkill /PID ${nameOrPid} /F` : `taskkill /IM "${nameOrPid}" /F`;
  return execPromise(cmd);
}

// ── Alimentation ─────────────────────────────────────────────────
async function shutdownPC(delaySeconds = 30) {
  return execPromise(`shutdown /s /t ${delaySeconds}`);
}
async function restartPC(delaySeconds = 30) {
  return execPromise(`shutdown /r /t ${delaySeconds}`);
}
async function cancelShutdown() {
  return execPromise('shutdown /a');
}
async function lockPC() {
  return execPromise('rundll32.exe user32.dll,LockWorkStation');
}

// ── Fichiers ─────────────────────────────────────────────────────
function listDirectory(dirPath) {
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true }).map((d) => ({
      nom: d.name,
      type: d.isDirectory() ? 'dossier' : 'fichier',
    }));
    return { success: true, items };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function readFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { success: true, content: content.slice(0, 8000) }; // limite pour éviter l'explosion de contexte
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function writeFile(filePath, content) {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function deleteFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Volume ───────────────────────────────────────────────────────
async function setVolumeMute(mute) {
  // Simule la touche Mute (F(mute)) via PowerShell — fonctionne sans dépendance externe
  const ps = `powershell -c "$obj = New-Object -ComObject WScript.Shell; $obj.SendKeys([char]173)"`;
  return execPromise(ps);
}
async function volumeStep(direction, times = 5) {
  // direction: 'up' ou 'down' — simule les touches multimédia
  const keyChar = direction === 'up' ? '175' : '174';
  const ps = `powershell -c "$o = New-Object -ComObject WScript.Shell; 1..${times} | %% { $o.SendKeys([char]${keyChar}) }"`;
  return execPromise(ps);
}

// ── Presse-papier ────────────────────────────────────────────────
async function getClipboard() {
  return execPromise('powershell -c "Get-Clipboard"');
}
async function setClipboard(text) {
  const escaped = text.replace(/"/g, '\\"');
  return execPromise(`powershell -c "Set-Clipboard -Value \\"${escaped}\\""`);
}

// ── Ouvrir un lien web ───────────────────────────────────────────
async function openUrl(url) {
  return execPromise(`start "" "${url}"`);
}

module.exports = {
  openApp,
  openFolder,
  runCommand,
  takeScreenshot,
  getSystemInfo,
  listProcesses,
  killProcess,
  shutdownPC,
  restartPC,
  cancelShutdown,
  lockPC,
  listDirectory,
  readFile,
  writeFile,
  deleteFile,
  setVolumeMute,
  volumeStep,
  getClipboard,
  setClipboard,
  openUrl,
};
