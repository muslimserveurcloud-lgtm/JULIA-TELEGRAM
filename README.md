# Julia — Premier bloc (WhatsApp + Cerveau)

## 1. Installation

Ouvre **deux terminaux** (CMD ou PowerShell) sur ton PC.

**Terminal 1 — Bridge WhatsApp**
```
cd julia/wa
npm install
```

**Terminal 2 — Cerveau**
```
cd julia/brain
npm install
```

## 2. Configuration

1. Copie `.env.example` vers `.env` (à la racine `julia/`)
2. Remplis tes clés API (Mistral, Gemini, Shodan) et ton `JULIA_OWNER_NUMBER`
   (ton numéro WhatsApp secondaire de test, format `224xxxxxxxxx` sans le +)

## 3. Lancement

**Terminal 2 d'abord (le cerveau doit être prêt avant le bridge) :**
```
cd julia/brain
npm start
# → 🧠 Julia Brain démarré sur http://127.0.0.1:4001
```

**Terminal 1 ensuite :**
```
cd julia/wa
npm start
# → 📡 Julia WA Bridge démarré sur http://127.0.0.1:4000
# Attends 8 secondes...
# 🔑 TON CODE JULIA : XXXXXXXX
```

Va dans WhatsApp (sur le numéro secondaire) > **Appareils connectés** >
**Connecter un appareil** > **Se connecter avec le numéro de téléphone** >
entre le code affiché.

Une fois connecté : `✅ Julia connectée à WhatsApp !`

## 4. Test

Écris à Julia depuis ton numéro **owner** (celui mis dans `.env`) :
- "Salut Julia" → doit répondre naturellement
- "Julia, envoie 'test' à [nom ou numéro]" → doit utiliser l'outil `send_whatsapp_message`
- "Liste mes discussions" → doit utiliser `list_whatsapp_chats`

⚠️ Si quelqu'un d'autre que toi écrit à Julia, elle répond normalement
mais ne peut PAS exécuter d'actions (sécurité anti-détournement).

## 5. Interface web Jarvis (nouveau)

Une fois `julia/brain` lancé (`npm start`), ouvre ton navigateur sur :
```
http://127.0.0.1:4001
```
Entre le `JULIA_WEB_TOKEN` que t'as mis dans `.env`, et discute avec Julia
directement — elle peut aussi contrôler ton PC depuis là (ouvrir une appli,
un dossier, exécuter une commande, capture d'écran, infos système).

### Accès depuis internet (ton téléphone, ailleurs)

Pour tester **aujourd'hui** sans configuration réseau compliquée, le plus
simple est **ngrok** :
1. Télécharge ngrok (ngrok.com), installe-le
2. Lance : `ngrok http 4001`
3. Il te donne une URL publique du style `https://xxxx.ngrok-free.app`
4. Ouvre cette URL depuis ton téléphone → même interface Jarvis, protégée
   par ton token

⚠️ **Sécurité :** cette URL est accessible par quiconque la connaît. Le
token protège l'accès, donc **utilise un token long et unique** (pas
"1234"), et ne partage jamais cette URL. Pour un accès permanent et plus
robuste (sans dépendre d'ngrok à chaque redémarrage), on pourra plus tard
mettre en place un vrai tunnel/agent dédié — étape prévue mais pas encore
faite.

## 6. Voix de Julia — conversation vocale complète (nouveau)

**Terminal 3 :**
```
cd julia/voice
pip install -r requirements.txt --break-system-packages
python julia_voice.py
```

Sur l'interface web, clique sur 🎙️, parle, clique à nouveau pour arrêter.
Julia transcrit ce que t'as dit, réfléchit, te répond en texte **et** en
voix (lecture automatique). Boucle complète : tu parles → elle attend →
elle répond avec sa voix.

Le navigateur demandera l'accès au micro la première fois — accepte.

## 7. Stockage automatique des fichiers

Envoie n'importe quel fichier à Julia depuis **ton PV** (ou un groupe où tu
es présent) — elle le stocke dans `julia/wa/fichiers_recus/` et confirme.

## 8. Gemini (vision) et Shodan (OSINT) — maintenant réellement branchés

- Demande à Julia d'analyser une image/capture d'écran → elle utilise Gemini Vision
- Demande une recherche Shodan (ex: "cherche les caméras exposées en Guinée") → elle interroge l'API Shodan

## Bugs trouvés et corrigés avant de te livrer ce zip

J'ai testé la syntaxe de chaque fichier avant l'envoi (`node --check`) et simulé
plusieurs scénarios. Voici ce qui a été trouvé et réparé :

1. **Bug bloquant** : la fonction météo avait perdu sa ligne de déclaration → le cerveau ne démarrait pas du tout
2. **Bug bloquant** : `julia_presence.js` avait une syntaxe de commentaire Python dans un fichier JS → crash au démarrage
3. **Faille de sécurité** : la vérification "c'est bien toi" utilisait une comparaison partielle (`startsWith`) — un numéro commençant par les mêmes chiffres que le tien aurait pu être confondu avec toi. Corrigé en comparaison exacte
4. **Bug fonctionnel** : la liste des discussions WhatsApp (`/chats`) s'appuyait sur un stockage interne que Baileys n'a plus depuis plusieurs versions — elle aurait toujours été vide. Remplacé par un vrai suivi des chats
5. **Bug de robustesse** : une erreur d'un outil (ex: mauvaise clé Gemini/Shodan) faisait perdre tout le fil de la conversation en basculant sur Mistral. Corrigé pour que Julia gère l'erreur proprement et te le dise
6. **Bug potentiel** : boucle infinie possible si le modèle s'entête à utiliser des outils sans jamais répondre. Plafond de sécurité ajouté
7. **Bug potentiel** : le nettoyage de l'historique de conversation pouvait couper en plein milieu d'un appel d'outil et faire planter l'appel suivant. Corrigé pour couper uniquement à un endroit sûr

## Ce qui n'est PAS encore branché (prochaines étapes)
- Julia qui répond en vocal directement sur WhatsApp (pour l'instant la voix ne marche que sur l'interface web)
- Panel admin, interface Jarvis encore plus poussée — à venir
