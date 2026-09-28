"""
julia_voice.py — Reconnaissance ET synthèse vocale de Julia
============================================================
- faster-whisper : voix -> texte (déjà en place)
- edge-tts       : texte -> voix, gratuit, voix française naturelle (NOUVEAU)

Installation :
    pip install flask faster-whisper edge-tts --break-system-packages

Lancement :
    python julia_voice.py

Endpoints :
    POST /transcribe  -> form-data "audio"  -> { text, language, duration }
    POST /speak        -> json { text }      -> fichier audio .mp3
"""

from flask import Flask, request, jsonify, send_file
from faster_whisper import WhisperModel
import os
import tempfile
import asyncio
import edge_tts

app = Flask(__name__)

MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = "int8" if DEVICE == "cpu" else "float16"

# Voix française par défaut — féminine, naturelle (catalogue Edge TTS)
# Autres options : "fr-FR-HenriNeural" (homme), "fr-FR-EloiseNeural"
VOICE = os.environ.get("JULIA_VOICE", "fr-FR-DeniseNeural")

print(f"[Julia Voice] Chargement du modèle Whisper '{MODEL_SIZE}' sur {DEVICE}...")
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
print(f"[Julia Voice] Prêt. Voix TTS : {VOICE}")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": MODEL_SIZE, "voice": VOICE})


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "Aucun fichier audio reçu (champ 'audio' attendu)"}), 400

    audio_file = request.files["audio"]
    suffix = os.path.splitext(audio_file.filename)[1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(tmp_path, language="fr", beam_size=5, vad_filter=True)
        full_text = " ".join(s.text.strip() for s in segments)
        return jsonify({"text": full_text.strip(), "language": info.language, "duration": info.duration})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        os.remove(tmp_path)


@app.route("/speak", methods=["POST"])
def speak():
    """Reçoit du texte, renvoie un fichier audio .mp3 avec la voix de Julia."""
    data = request.get_json(force=True)
    text = (data or {}).get("text", "").strip()
    voice = (data or {}).get("voice") or VOICE

    if not text:
        return jsonify({"error": "Champ 'text' vide"}), 400

    output_path = os.path.join(tempfile.gettempdir(), f"julia_tts_{os.getpid()}_{abs(hash(text))}.mp3")

    async def generer():
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(output_path)

    try:
        asyncio.run(generer())
        return send_file(output_path, mimetype="audio/mpeg")
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=False)
