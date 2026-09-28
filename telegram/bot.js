const axios = require("axios");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID || "");
const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:4001";
const JULIA_WEB_TOKEN = process.env.JULIA_WEB_TOKEN || "";

if (!TOKEN) {
    console.error("❌ TELEGRAM_BOT_TOKEN manquant");
    process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

let offset = 0;

async function telegram(method, data = {}) {
    const response = await axios.post(
        `${API}/${method}`,
        data,
        {
            timeout: 70000
        }
    );

    if (!response.data.ok) {
        throw new Error(
            response.data.description || "Erreur Telegram"
        );
    }

    return response.data.result;
}

async function sendMessage(chatId, text) {
    if (!text) {
        text = "Julia n'a pas retourné de réponse.";
    }

    for (let i = 0; i < text.length; i += 4000) {
        await telegram("sendMessage", {
            chat_id: chatId,
            text: text.substring(i, i + 4000)
        });
    }
}

async function askJulia(message) {
    const response = await axios.post(
        `${BRAIN_URL}/chat`,
        {
            token: JULIA_WEB_TOKEN,
            message
        },
        {
            timeout: 120000
        }
    );

    return (
        response.data.reply ||
        response.data.message ||
        "Julia n'a pas retourné de réponse."
    );
}

async function processUpdate(update) {
    if (!update.message) {
        return;
    }

    const message = update.message;
    const chatId = message.chat.id;
    const userId = String(message.from?.id || "");
    const text = message.text || "";

    if (text === "/start") {
        await sendMessage(
            chatId,
            "☁️ JULIA AI\n\n" +
            "Bienvenue.\n\n" +
            "Utilise /id pour afficher ton Telegram ID."
        );

        return;
    }

    if (text === "/id") {
        await sendMessage(
            chatId,
            `🆔 Ton Telegram ID : ${userId}`
        );

        return;
    }

    if (OWNER_ID && userId !== OWNER_ID) {
        await sendMessage(
            chatId,
            "🔒 Julia est actuellement en mode privé."
        );

        return;
    }

    if (!text) {
        return;
    }

    try {
        await sendMessage(
            chatId,
            "🧠 Julia réfléchit..."
        );

        const answer = await askJulia(text);

        await sendMessage(
            chatId,
            answer
        );

    } catch (error) {

        console.error(
            "Erreur Julia :",
            error.response?.data || error.message
        );

        await sendMessage(
            chatId,
            "❌ Impossible de contacter Julia pour le moment."
        );
    }
}

async function main() {

    console.log("☁️ JULIA TELEGRAM démarre...");

    await telegram(
        "deleteWebhook",
        {
            drop_pending_updates: false
        }
    );

    console.log(
        "✅ Bot Telegram connecté."
    );

    while (true) {

        try {

            const updates = await telegram(
                "getUpdates",
                {
                    offset,
                    timeout: 50,
                    allowed_updates: ["message"]
                }
            );

            for (const update of updates) {

                offset = update.update_id + 1;

                try {
                    await processUpdate(update);
                } catch (error) {
                    console.error(
                        "Erreur update :",
                        error.message
                    );
                }
            }

        } catch (error) {

            console.error(
                "Telegram :",
                error.message
            );

            await new Promise(
                resolve => setTimeout(resolve, 5000)
            );
        }
    }
}

main().catch(error => {

    console.error(
        "Erreur fatale :",
        error
    );

    process.exit(1);
});
