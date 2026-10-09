require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const config = require('../config.json');
const { fetchEssentialAisleDeals, fetchNoiceDeals } = require('./swiggyApi');
const { findAlertWorthyDeals, getCanonicalItemKey } = require('./dealTracker');
const { sendBatchAlerts } = require('./notifier');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const minDiscount = parseInt(process.env.MIN_DISCOUNT_PERCENT, 10) || config.minDiscount || 70;

const storesList = config.stores && config.stores.length > 0 ? config.stores : [
  {
    id: process.env.SWIGGY_STORE_ID || config.store?.sid || '',
    pid: process.env.SWIGGY_PRIMARY_STORE_ID || config.store?.pid || '',
    secid: process.env.SWIGGY_SECONDARY_STORE_ID || config.store?.secid || '',
    label: 'Primary Store'
  }
];

if (!storesList[0].id) {
  console.error('❌ FATAL: No stores defined in config.json!');
  process.exit(1);
}

const args = process.argv.slice(2);
let mode = 'auto';
let skipSync = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--skip-sync') {
    skipSync = true;
  } else if (!arg.startsWith('--')) {
    mode = arg.toLowerCase();
  }
}

async function syncToHourMark(skip = false, targetBufferSecs = 30) {
  if (skip) return;

  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(Date.now() + istOffsetMs);
  const mins = istNow.getUTCMinutes();
  const secs = istNow.getUTCSeconds();
  const ms = istNow.getUTCMilliseconds();

  // If the runner boots slightly early, wait until the top/bottom of the hour
  if (mins >= 55 && mins <= 59) {
    const minsLeft = 60 - mins;
    const msToWait = (minsLeft * 60 * 1000) - (secs * 1000) - ms + (targetBufferSecs * 1000);
    if (msToWait > 0 && msToWait <= 6 * 60 * 1000) {
      console.log(`[Sync] Waiting ${(msToWait / 1000).toFixed(1)}s to align with schedule...`);
      await sleep(msToWait);
    }
  } else if (mins >= 25 && mins <= 29) {
    const minsLeft = 30 - mins;
    const msToWait = (minsLeft * 60 * 1000) - (secs * 1000) - ms + (targetBufferSecs * 1000);
    if (msToWait > 0 && msToWait <= 6 * 60 * 1000) {
      console.log(`[Sync] Waiting ${(msToWait / 1000).toFixed(1)}s to align with schedule...`);
      await sleep(msToWait);
    }
  }
}

async function runCampaignAcrossAllStores(campaignKey, campaignCfg, options = {}) {
  const { bot, chatId, storesList, threshold, timeString } = options;
  const name = campaignCfg.name || campaignKey;
  const tag = campaignCfg.tag || '';
  const headerName = tag ? `${tag} ${name}` : name;
  const subcategories = campaignCfg.subcategories || [];

  console.log(`\n======================================================`);
  console.log(`🚀 Scanning ${name} across all ${storesList.length} Dark Stores`);
  console.log(`======================================================`);

  const mergedDealsMap = new Map();

  for (let s = 0; s < storesList.length; s++) {
    const store = storesList[s];
    const currentStoreConfig = { sid: store.id, pid: store.pid, secid: store.secid };
    const storeLabel = store.label || store.id;

    console.log(`\n🏪 [${s + 1}/${storesList.length}] Fetching for Store: ${storeLabel}...`);

    let items = [];
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        items = await fetchEssentialAisleDeals(currentStoreConfig, {
          subcategories,
          campaignName: name,
          dealType: campaignKey
        });
        if (items && items.length > 0) break;
      } catch (e) {
        console.error(`[${campaignKey}:${storeLabel}] Attempt ${attempts}/${maxAttempts} error:`, e.message);
      }
      if (attempts < maxAttempts) await sleep(15 * 1000);
    }

    if (items.length > 0) {
      const refreshCycle = campaignCfg.refreshCycle || 'daily';
      const weeklyResetDay = campaignCfg.weeklyResetDay !== undefined ? campaignCfg.weeklyResetDay : 1;
      const weeklyCategories = campaignCfg.weeklyCategories || config.weeklyCategories || ['Electronics and Appliances'];

      const storeAlerts = findAlertWorthyDeals(items, threshold, campaignKey, {
        refreshCycle,
        weeklyResetDay,
        weeklyCategories,
        storeId: store.id
      });

      console.log(`[${campaignKey}:${storeLabel}] Found ${storeAlerts.length} alert-worthy deals.`);

      for (const alert of storeAlerts) {
        const itemKey = getCanonicalItemKey(alert);

        if (!mergedDealsMap.has(itemKey)) {
          mergedDealsMap.set(itemKey, {
            ...alert,
            stores: [{ id: store.id, label: storeLabel, price: alert.price, discount: alert.discount }],
            priceVaries: false
          });
        } else {
          const existing = mergedDealsMap.get(itemKey);
          existing.stores.push({ id: store.id, label: storeLabel, price: alert.price, discount: alert.discount });

          if (alert.price !== existing.price) {
            existing.priceVaries = true;
          }

          if (alert.price < existing.price) {
            existing.price = alert.price;
            existing.discount = alert.discount;
            existing.mrp = alert.mrp;
            existing.searchLink = alert.searchLink;
            existing.itemLink = alert.itemLink;
          }
        }
      }
    }
    if (s < storesList.length - 1) await sleep(1500);
  }

  const mergedDeals = Array.from(mergedDealsMap.values());
  mergedDeals.sort((a, b) => b.discount - a.discount);

  console.log(`\n📊 [${campaignKey}] Merged Total: ${mergedDeals.length} unique deals across all stores.`);

  if (bot && chatId && mergedDeals.length > 0) {
    await sendBatchAlerts(bot, chatId, mergedDeals, { timeString, workerInfo: headerName });
  }
}

async function main() {
  console.log(`[CronRunner] Mode: ${mode.toUpperCase()} | Configured Stores: ${storesList.length}`);

  await syncToHourMark(skipSync);

  let bot = null;
  if (token && token !== 'your_bot_token_here') {
    bot = new TelegramBot(token, { polling: false });
  }

  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  const timeString = timeFormatter.format(new Date()) + ' IST';

  let runFresh = false, runGrocery = false, runTreats = false, runMunchies = false;
  let runBeverages = false, runPersonal = false, runLifestyle = false, runNoice = false;

  if (mode === 'fresh' || mode === 'produce') runFresh = true;
  else if (mode === 'grocery' || mode === 'staples') runGrocery = true;
  else if (mode === 'essentials' || mode === 'keywords' || mode === 'aisles') { runFresh = true; runGrocery = true; }
  else if (mode === 'treats' || mode === 'sweets') runTreats = true;
  else if (mode === 'munchies' || mode === 'snacks') runMunchies = true;
  else if (mode === 'lifestyle' || mode === 'home' || mode === 'electronics' || mode === 'baby') runLifestyle = true;
  else if (mode === 'beverages' || mode === 'drinks' || mode === 'juices') runBeverages = true;
  else if (mode === 'personal' || mode === 'personalcare') runPersonal = true;
  else if (mode === 'noice') runNoice = true;
  else {
    runFresh = true; runGrocery = true; runTreats = true; runMunchies = true;
    runBeverages = true; runPersonal = true; runLifestyle = true;
  }

  const campaigns = config.campaigns || {};
  const sharedOptions = { bot, chatId, storesList, timeString };

  if (runFresh) {
    const cfg = campaigns.fresh || campaigns.essentials || {};
    const threshold = parseInt(process.env.FRESH_MIN_DISCOUNT || process.env.ESSENTIALS_MIN_DISCOUNT, 10) || cfg.minDiscount || 60;
    await runCampaignAcrossAllStores('fresh', cfg, { ...sharedOptions, threshold });
  }

  if (runGrocery) {
    const cfg = campaigns.grocery || campaigns.essentials || {};
    const threshold = parseInt(process.env.GROCERY_MIN_DISCOUNT || process.env.ESSENTIALS_MIN_DISCOUNT, 10) || cfg.minDiscount || 60;
    await runCampaignAcrossAllStores('grocery', cfg, { ...sharedOptions, threshold });
  }

  if (runTreats) {
    const cfg = campaigns.treats || {};
    const threshold = parseInt(process.env.TREATS_MIN_DISCOUNT, 10) || cfg.minDiscount || 70;
    await runCampaignAcrossAllStores('treats', cfg, { ...sharedOptions, threshold });
  }

  if (runMunchies) {
    const cfg = campaigns.munchies || campaigns.treats || {};
    const threshold = parseInt(process.env.MUNCHIES_MIN_DISCOUNT || process.env.TREATS_MIN_DISCOUNT, 10) || cfg.minDiscount || 70;
    await runCampaignAcrossAllStores('munchies', cfg, { ...sharedOptions, threshold });
  }

  if (runBeverages) {
    const cfg = campaigns.beverages || {};
    const threshold = parseInt(process.env.BEVERAGES_MIN_DISCOUNT, 10) || cfg.minDiscount || 70;
    await runCampaignAcrossAllStores('beverages', cfg, { ...sharedOptions, threshold });
  }

  if (runPersonal) {
    const cfg = campaigns.personalCare || campaigns.personal || {};
    const threshold = parseInt(process.env.PERSONAL_MIN_DISCOUNT, 10) || cfg.minDiscount || 70;
    await runCampaignAcrossAllStores('personalCare', cfg, { ...sharedOptions, threshold });
  }

  if (runLifestyle) {
    const cfg = campaigns.lifestyle || {};
    const threshold = parseInt(process.env.LIFESTYLE_MIN_DISCOUNT, 10) || cfg.minDiscount || 85;
    await runCampaignAcrossAllStores('lifestyle', cfg, { ...sharedOptions, threshold });
  }

  if (runNoice) {
    console.log(`\n--- Running The NOICE Store Scan across all stores ---`);
    const cfg = campaigns.noice || {};
    const noiceThreshold = parseInt(process.env.NOICE_MIN_DISCOUNT, 10) || cfg.minDiscount || minDiscount || 50;
    const mergedNoiceMap = new Map();

    for (let s = 0; s < storesList.length; s++) {
      const store = storesList[s];
      const storeCfg = { sid: store.id, pid: store.pid, secid: store.secid };
      const storeLabel = store.label || store.id;

      try {
        const items = await fetchNoiceDeals(storeCfg);
        const alerts = findAlertWorthyDeals(items, noiceThreshold, 'noice', {
          refreshCycle: cfg.refreshCycle || 'weekly',
          weeklyResetDay: cfg.weeklyResetDay !== undefined ? cfg.weeklyResetDay : 1,
          storeId: store.id
        });

        for (const alert of alerts) {
          const itemKey = getCanonicalItemKey(alert);
          if (!mergedNoiceMap.has(itemKey)) {
            mergedNoiceMap.set(itemKey, {
              ...alert,
              stores: [{ id: store.id, label: storeLabel, price: alert.price, discount: alert.discount }],
              priceVaries: false
            });
          } else {
            const existing = mergedNoiceMap.get(itemKey);
            existing.stores.push({ id: store.id, label: storeLabel, price: alert.price, discount: alert.discount });
            if (alert.price !== existing.price) existing.priceVaries = true;
            if (alert.price < existing.price) {
              existing.price = alert.price;
              existing.discount = alert.discount;
              existing.mrp = alert.mrp;
              existing.searchLink = alert.searchLink;
              existing.itemLink = alert.itemLink;
            }
          }
        }
      } catch (e) {
        console.error(`[NOICE:${storeLabel}] Error:`, e.message);
      }
      await sleep(1000);
    }

    const mergedNoice = Array.from(mergedNoiceMap.values());
    mergedNoice.sort((a, b) => b.discount - a.discount);
    if (bot && chatId && mergedNoice.length > 0) {
      await sendBatchAlerts(bot, chatId, mergedNoice, { timeString, workerInfo: '✨ The NOICE Store' });
    }
  }

  console.log('\n[CronRunner] All 4 dark stores scanned and combined successfully.');
}

main().catch((err) => {
  console.error('[CronRunner] Fatal error:', err);
  process.exit(1);
});
