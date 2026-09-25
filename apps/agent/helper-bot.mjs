// A real second Minecraft client (Steve) used as the delivery recipient during E2E tests.
import mineflayer from 'mineflayer';
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'Steve', version: '1.21.4', auth: 'offline' });
bot.on('spawn', () => console.log('HELPER_SPAWNED', JSON.stringify(bot.entity.position)));
bot.on('chat', (u, m) => console.log('HELPER_CHAT', u, m));
bot.on('messagestr', (m) => console.log('HELPER_MSG', m));
bot.on('error', (e) => console.log('HELPER_ERROR', e.message));
bot.on('end', (r) => { console.log('HELPER_END', r); process.exit(0); });
