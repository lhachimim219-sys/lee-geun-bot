// index.js
// نقطة تشغيل بوت الواتساب - يدير الاتصال، رمز QR، وتحميل الأوامر من مجلد plugins

import baileys from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// تفكيك الكائن بشكل آمن لتفادي خطأ TypeError
const baileysObj = baileys.default || baileys;
const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadContentFromMessage
} = baileysObj;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, 'session');
const PLUGINS_DIR = path.join(__dirname, 'plugins');
const PREFIX = process.env.BOT_PREFIX || '.';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📦 تحميل الأوامر من مجلد plugins
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const commandMap = new Map();

async function loadPlugins() {
    commandMap.clear();

    if (!fs.existsSync(PLUGINS_DIR)) {
        console.log('⚠️  مجلد plugins غير موجود، سيتم تجاهل تحميل الأوامر.');
        return;
    }

    const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));

    for (const file of files) {
        try {
            const fullPath = path.join(PLUGINS_DIR, file);
            // إضافة ?update= لتفادي الكاش عند إعادة التحميل
            const moduleUrl = `${pathToFileURL(fullPath).href}?update=${Date.now()}`;
            const mod = await import(moduleUrl);
            const handler = mod.default;

            if (!handler || !Array.isArray(handler.command)) {
                console.log(`⚠️  تخطي ${file}: لا يحتوي على handler.command صالح`);
                continue;
            }

            for (const cmd of handler.command) {
                commandMap.set(cmd, handler);
            }

            console.log(`✅ تم تحميل: ${file} (${handler.command.join(', ')})`);
        } catch (err) {
            console.error(`❌ فشل تحميل ${file}:`, err.message);
        }
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📩 استخراج نص الرسالة من مختلف الأنواع
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function extractText(message) {
    if (!message) return '';
    return (
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.buttonsResponseMessage?.selectedButtonId ||
        message.listResponseMessage?.singleSelectReply?.selectedRowId ||
        message.templateButtonReplyMessage?.selectedId ||
        ''
    );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🚀 بدء تشغيل البوت
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function startBot() {
    await loadPlugins();

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const createSocket = makeWASocket.default || makeWASocket;
    const conn = createSocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['WhatsApp Bot', 'Chrome', '1.0.0']
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 امسح رمز QR التالي بواتساب (الأجهزة المرتبطة > ربط جهاز):\n');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log('🔌 انقطع الاتصال.', shouldReconnect ? 'جاري إعادة المحاولة...' : 'تم تسجيل الخروج، احذف مجلد session وأعد التشغيل.');

            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✅ تم الاتصال بنجاح بواتساب!');
        }
    });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 📨 استقبال الرسائل ومعالجة الأوامر
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    conn.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                if (!msg.message || msg.key.fromMe) continue;

                const chat = msg.key.remoteJid;
                const rawText = extractText(msg.message).trim();

                if (!rawText.startsWith(PREFIX)) continue;

                const withoutPrefix = rawText.slice(PREFIX.length).trim();
                const [command, ...args] = withoutPrefix.split(/\s+/);
                const text = args.join(' ');

                if (!command) continue;

                const handler = commandMap.get(command);
                if (!handler) continue;

                // بناء كائن الرسالة m بواجهة مبسطة يستخدمها كل الـ plugins
                const m = {
                    key: msg.key,
                    chat,
                    sender: msg.key.participant || msg.key.remoteJid,
                    message: msg.message,
                    reply: (text) => conn.sendMessage(chat, { text }, { quoted: msg })
                };

                console.log(`⚡ أمر: ${command} | من: ${m.sender}`);

                await handler(m, { conn, text, command, usedPrefix: PREFIX, args });
            } catch (err) {
                console.error('❌ خطأ أثناء معالجة رسالة:', err);
            }
        }
    });

    return conn;
}

startBot().catch((err) => {
    console.error('❌ فشل تشغيل البوت:', err);
    process.exit(1);
});
