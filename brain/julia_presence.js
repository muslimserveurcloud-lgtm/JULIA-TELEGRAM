/**
 * julia_presence.js — Détection de présence WiFi (option gratuite)
 * ============================================================
 * Basé sur la logique de RuView (ruvnet/RuView), mais en version "gratuite" :
 * pas de matériel CSI (ESP32-S3), juste le RSSI (force du signal WiFi) que
 * Windows expose déjà via `netsh wlan show interfaces`.
 *
 * ⚠️ LIMITE IMPORTANTE À COMPRENDRE :
 * Le RSSI seul (une antenne, sur le PC) ne peut PAS compter précisément le
 * nombre de personnes dans une pièce. Il peut seulement dire si le signal
 * fluctue (= mouvement/présence probable) ou reste stable (= calme/absence).
 * Un vrai comptage de personnes demanderait le matériel CSI (ESP32-S3 mesh)
 * évoqué dans RuView — pas branché ici.
 *
 * Ce que ce module donne concrètement :
 *   - "aucun mouvement détecté"
 *   - "activité légère détectée (probablement 1 personne)"
 *   - "forte activité détectée (probablement plusieurs personnes)"
 *
 * C'est une estimation heuristique, pas une mesure certaine.
 */

const { exec } = require('child_process');

function getSignalPercent() {
  return new Promise((resolve) => {
    exec('netsh wlan show interfaces', (error, stdout) => {
      if (error) return resolve(null);
      const match = stdout.match(/Signal\s*:\s*(\d+)%/i);
      resolve(match ? parseInt(match[1], 10) : null);
    });
  });
}

async function checkRoomPresence({ sampleCount = 8, intervalMs = 500 } = {}) {
  const samples = [];

  for (let i = 0; i < sampleCount; i++) {
    const value = await getSignalPercent();
    if (value !== null) samples.push(value);
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  if (samples.length < 3) {
    return {
      error: "Impossible de lire le signal WiFi (vérifie que le PC est bien connecté en WiFi, pas en Ethernet — le RSSI ne fonctionne que sur une connexion WiFi).",
    };
  }

  // Variance des échantillons = indicateur de fluctuation/mouvement
  const moyenne = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance =
    samples.reduce((acc, v) => acc + Math.pow(v - moyenne, 2), 0) / samples.length;
  const ecartType = Math.sqrt(variance);

  let estimation;
  if (ecartType < 0.8) {
    estimation = 'aucun mouvement détecté';
  } else if (ecartType < 2.5) {
    estimation = 'activité légère détectée (probablement 1 personne)';
  } else {
    estimation = 'forte activité détectée (probablement plusieurs personnes)';
  }

  return {
    estimation,
    fiabilite: 'heuristique (RSSI seul) — pas un comptage exact',
    ecart_type: ecartType.toFixed(2),
    echantillons: samples,
  };
}

module.exports = { checkRoomPresence };
