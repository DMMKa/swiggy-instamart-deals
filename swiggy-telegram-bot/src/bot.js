require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const config = require('../config.json');
const { loadCache } = require('./dealTracker');
const { getUser, updateUser } = require('./userManager');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
let minDiscount = parseInt(process.env.MIN_DISCOUNT_PERCENT, 10) || config.minDiscount || 50;

const storesList = config.stores || [];

console.log('====================================================');
console.log('⚡ Instamart Telegram Deal Alert Bot (4 Stores x 5 Workers)');
console.log(`📍 Tracking ${storesList.length} Dark Stores.`);
console.log('====================================================');

let bot = null;
if (token && token !== 'your_bot_token_here') {
  bot = new TelegramBot(token, { polling: true });
  console.log('🤖 Telegram Bot is connected and listening for commands!');

  bot.setMyCommands([
    { command: 'start', description: 'Show welcome message & commands' },
    { command: 'setdiscount', description: 'Set discount % for each of the 5 workers' },
    { command: 'myinfo', description: 'View your profile & active stores' },
    { command: 'status', description: 'Check bot status & scan stats' }
  ]).catch(err => console.error('[Bot] Failed to set menu commands:', err.message));

  bot.on('polling_error', (err) => {
    console.error('[Bot Polling Error]', err.code || '', err.message || err);
  });
}

if (bot) {
  const rejectMedia = (msg) => {
    bot.sendMessage(msg.chat.id, '⚠️ <b>Uploads are disabled.</b>\n\nPlease use the <b>Menu</b> button.', { parse_mode: 'HTML' });
  };
  bot.on('photo', rejectMedia);
  bot.on('document', rejectMedia);

  bot.onText(/\/(?:start|help)(?:@\w+)?(?:\s|$)/, (msg) => {
    const text = 
`👋 <b>Welcome to Instamart Hunter Deal Bot!</b>

I monitor <b>4 Dark Stores</b> simultaneously across <b>5 Parallel Workers</b> every hour to find you the highest discounts!

⚙️ <b>Commands:</b>
• <code>/myinfo</code> — View your tracked stores and active thresholds
• <code>/setdiscount</code> — Change discount threshold for any specific worker
• <code>/status</code> — Check bot status & tracked deals`;

    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  });

  const WORKERS = [
    { key: 'fresh', name: 'Daily Fresh Produce & Meats', tag: '🥦', defaultDiscount: 60 },
    { key: 'grocery', name: 'Daily Staples & Cooking Essentials', tag: '🌾', defaultDiscount: 60 },
    { key: 'treats', name: 'Sweets, Chocolates & Bakery', tag: '🍫', defaultDiscount: 70 },
    { key: 'munchies', name: 'Snacks, Munchies & Instant Foods', tag: '🍿', defaultDiscount: 70 },
    { key: 'beverages', name: 'Cold Drinks, Nutrition & Spreads', tag: '🥤', defaultDiscount: 70 },
    { key: 'personalCare', name: 'Personal Care, Bath & Skincare', tag: '🧴', defaultDiscount: 70 },
    { key: 'lifestyle', name: 'Baby Care & Lifestyle', tag: '🛍️', defaultDiscount: 85 }
  ];

  bot.onText(/^\/myinfo(?:@\w+)?/i, (msg) => {
    const user = getUser(msg.chat.id, {});
    const wd = user.workerDiscounts || {};
    
    let storesText = storesList.map((s, i) => `• <b>${s.label}</b> (ID: <code>${s.id}</code>)`).join('\n');

    bot.sendMessage(
      msg.chat.id,
      `👤 <b>Your Profile & Active Configuration:</b>\n\n` +
      `📍 <b>Tracked Dark Stores:</b>\n${storesText}\n\n` +
      `🎯 <b>Worker Alert Thresholds:</b>\n` +
      `• 🥦 <b>Fresh Produce</b>: <b>≥ ${wd.fresh || 60}% OFF</b>\n` +
      `• 🌾 <b>Groceries</b>: <b>≥ ${wd.grocery || 60}% OFF</b>\n` +
      `• 🍫 <b>Treats</b>: <b>≥ ${wd.treats || 70}% OFF</b>\n` +
      `• 🍿 <b>Munchies</b>: <b>≥ ${wd.munchies || 70}% OFF</b>\n` +
      `• 🥤 <b>Beverages</b>: <b>≥ ${wd.beverages || 70}% OFF</b>\n` +
      `• 🧴 <b>Personal Care</b>: <b>≥ ${wd.personalCare || 70}% OFF</b>\n` +
      `• 🛍️ <b>Lifestyle</b>: <b>≥ ${wd.lifestyle || 85}% OFF</b>\n`,
      { parse_mode: 'HTML' }
    );
  });

  bot.onText(/^\/status(?:@\w+)?/i, (msg) => {
    const user = getUser(msg.chat.id, {});
    const wd = user.workerDiscounts || {};
    
    let storesText = storesList.map((s, i) => `• <b>${s.label}</b>: <code>${s.id}</code>`).join('\n');

    const statusText = 
`📊 <b>Bot Status & Schedules</b>:
• <b>Status</b>: 🟢 Online & Listening
• <b>Active Stores (${storesList.length})</b>:\n${storesText}

🎯 <b>Active Worker Thresholds</b>:
• 🌾 Essentials & Fresh: <b>≥ ${wd.essentials || 60}% OFF</b>
• 🍿 Sweets & Treats: <b>≥ ${wd.treats || 70}% OFF</b>
• 🛍️ Lifestyle & Home: <b>≥ ${wd.lifestyle || 85}% OFF</b>
• 🥤 Beverages & Spreads: <b>≥ ${wd.beverages || 70}% OFF</b>
• 🧴 Personal Care: <b>≥ ${wd.personalCare || 70}% OFF</b>

⏰ <b>Automated Schedules</b>:
• <b>Hourly Scans</b>: 10:00 AM – 10:00 PM IST (via GitHub Actions)`;

    bot.sendMessage(msg.chat.id, statusText, { parse_mode: 'HTML' });
  });
}
