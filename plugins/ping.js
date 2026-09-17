// plugins/ping.js
// أمر بسيط للتأكد من أن البوت يعمل: .بينج

let handler = async (m) => {
    const start = Date.now();
    await m.reply('🏓 جاري القياس...');
    const speed = Date.now() - start;
    await m.reply(`🏓 *Pong!*\n⚡ السرعة: ${speed}ms`);
};

handler.command = ['بينج', 'ping'];
handler.tags = ['main'];
handler.help = ['بينج'];

export default handler;
