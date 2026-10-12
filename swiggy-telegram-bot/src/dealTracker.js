const fs = require('fs');
const path = require('path');

function getCacheFilePath(campaignKey = 'default', storeId = 'default') {
  return path.join(__dirname, '..', 'data', `deals_cache_${storeId}_${campaignKey}.json`);
}

function ensureDataDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadCache(campaignKey = 'default', storeId = 'default') {
  const filePath = getCacheFilePath(campaignKey, storeId);
  ensureDataDir(filePath);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {}
  return { items: {} };
}

function saveCache(cache, campaignKey = 'default', storeId = 'default') {
  const filePath = getCacheFilePath(campaignKey, storeId);
  ensureDataDir(filePath);
  try {
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {}
}

function getIstContext(overrideDate = null, overrideHour = null) {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  let istDate = overrideDate ? new Date(`${overrideDate}T${String(overrideHour || 0).padStart(2, '0')}:00:00.000Z`) : new Date(now.getTime() + istOffset);
  const dateStr = overrideDate || istDate.toISOString().slice(0, 10);
  const hour = overrideHour !== null ? overrideHour : istDate.getUTCHours();
  return { dateStr, hour, now: now.getTime() };
}

function normalizeProductName(name) {
  if (!name) return '';
  let str = name.trim().toLowerCase();
  str = str.replace(/\([^)]*\)/g, ' ');
  str = str.replace(/[-\s,]+(?:uk\s*\d+|\d+\s*uk)\b/gi, ' ');
  return str.replace(/[-_,\s]+/g, ' ').trim();
}

function getCanonicalItemKey(item) {
  const packStr = (item.pack || '').trim().toLowerCase();
  const rawName = (item.name || '').trim().toLowerCase();
  
  if (rawName) {
    return packStr ? `name:${rawName}:${packStr}` : `name:${rawName}`;
  }
  if (item.parentProductId) {
    return packStr ? `pid:${item.parentProductId}:${packStr}` : `pid:${item.parentProductId}`;
  }
  return String(item.skuId || '');
}

function evaluateCustomRules(item, baseThreshold) {
  const name = (item.name || '').toLowerCase();
  const brand = (item.brand || '').toLowerCase();
  const cat = (item.category || '').toLowerCase() + ' ' + (item.subCategory || '').toLowerCase();

  const isElectronics = cat.includes('electronic') || cat.includes('appliance') || cat.includes('mobile') || cat.includes('earphone') || cat.includes('laptop');

  let isGlitch = false;
  const isPremiumCat = isElectronics || cat.includes('skincare');
  if (item.price <= 50 && (isPremiumCat || item.mrp >= 400)) {
    isGlitch = true;
  }

  // Threshold calculation
  let customThreshold = baseThreshold;

  // Rule 1: Electronics strictly requires 90%
  if (isElectronics) {
    customThreshold = 90;
  }
  // Rule 2: High priority essentials & cleaning
  else if (brand.includes('aashirvaad') || name.includes('aashirvaad')) customThreshold = 40;
  else if (brand.includes('tide') || name.includes('tide')) customThreshold = 40;
  else if (brand.includes('vim') || name.includes('vim')) customThreshold = 40;
  else if (name.includes('atta') || name.includes('coffee')) customThreshold = 40;
  else if (name.includes('cashew') || name.includes('almond') || brand.includes('ariel')) customThreshold = 50;
  else if (name.includes('dal')) customThreshold = 60;
  else if (name.includes('chocolate') || cat.includes('home decor')) customThreshold = 70;
  
  // Rule 3: Targeted personal care brands (default at 70%)
  else if (brand.includes('loreal') || brand.includes("l'oreal") || name.includes('loreal') || name.includes("l'oreal")) customThreshold = 70;
  else if (brand.includes('nivea') || name.includes('nivea')) customThreshold = 70;
  else if (brand.includes('be neude') || name.includes('be neude')) customThreshold = 70;
  else if (brand.includes('ajmal') || name.includes('ajmal')) customThreshold = 70;
  else if (brand.includes('himalaya') || name.includes('himalaya')) customThreshold = 70;
  else if (brand.includes('pantene') || name.includes('pantene')) customThreshold = 70;
  else if (name.includes('shampoo') || name.includes('body lotion') || name.includes('face wash') || name.includes('hair oil')) customThreshold = 70;

  // Assign tier
  let tier = 'TIER_LOW';
  if (isGlitch) {
    tier = 'GLITCH';
  } else if (!isElectronics && item.discount >= 80) {
    tier = 'MEGA_LOOT'; // 80%, 90%, 100% OFF for all non-electronics
  } else if (isElectronics && item.discount >= 90) {
    tier = 'MEGA_LOOT'; // 90%+ OFF for electronics
  } else if (item.discount >= 70) {
    tier = 'TIER_70';
  } else if (item.discount >= 40) {
    tier = 'TIER_40';
  }

  return { threshold: customThreshold, tier };
}

function findAlertWorthyDeals(items, minDiscount = 70, campaignKey = 'default', options = {}) {
  const storeId = options.storeId || 'default';
  const cache = loadCache(campaignKey, storeId);
  const alertList = [];
  const now = new Date().getTime();
  const seenInCurrentRun = new Map();

  for (const item of items) {
    const rule = evaluateCustomRules(item, typeof minDiscount === 'number' ? minDiscount : 70);
    
    // Skip if below threshold, unless it is a glitch or 80%+ mega loot
    if (item.discount < rule.threshold && rule.tier !== 'GLITCH' && rule.tier !== 'MEGA_LOOT') continue;
    item.tier = rule.tier;

    const itemKey = getCanonicalItemKey(item);
    if (!itemKey) continue;

    if (seenInCurrentRun.has(itemKey)) {
      const existingAlert = seenInCurrentRun.get(itemKey);
      if (item.price < existingAlert.price) {
        existingAlert.price = item.price;
        existingAlert.mrp = item.mrp;
        existingAlert.discount = item.discount;
        if (cache.items[itemKey]) {
          cache.items[itemKey].price = item.price;
          cache.items[itemKey].discount = item.discount;
        }
      }
      continue;
    }

    const prev = cache.items[itemKey];
    let shouldAlert = false;
    let alertType = 'NEW_DEAL';

    if (!prev) {
      shouldAlert = true;
    } else {
      const lastAlertPrice = prev.lastAlertedPrice !== undefined ? prev.lastAlertedPrice : null;
      const lastSeenPrice = prev.price !== undefined ? prev.price : null;

      if (lastAlertPrice === null) {
        shouldAlert = true;
      } else if (item.price < lastAlertPrice) {
        shouldAlert = true;
        alertType = 'PRICE_DROP';
      } else if (lastSeenPrice !== null && item.price < lastSeenPrice && item.price <= lastAlertPrice) {
        shouldAlert = true;
      }
    }

    if (shouldAlert) {
      const alertObj = { ...item, alertType, prevPrice: prev ? prev.lastAlertedPrice : null, campaignKey };
      alertList.push(alertObj);
      seenInCurrentRun.set(itemKey, alertObj);

      cache.items[itemKey] = {
        name: item.name, pack: item.pack || '', category: item.category || '',
        price: item.price, mrp: item.mrp, discount: item.discount,
        lastAlertedPrice: item.price, lastAlertedDiscount: item.discount,
        firstSeen: prev ? prev.firstSeen : now, lastSeen: now
      };
    } else {
      seenInCurrentRun.set(itemKey, { price: item.price });
      if (!cache.items[itemKey]) {
        cache.items[itemKey] = {
          name: item.name, pack: item.pack || '', category: item.category || '',
          price: item.price, mrp: item.mrp, discount: item.discount,
          firstSeen: now, lastSeen: now
        };
      } else {
        cache.items[itemKey].price = item.price;
        cache.items[itemKey].discount = item.discount;
        cache.items[itemKey].lastSeen = now;
      }
    }
  }

  alertList.sort((a, b) => b.discount - a.discount);
  saveCache(cache, campaignKey, storeId);
  return alertList;
}

function getCachedDeals(campaignKey = 'default', minDiscount = 0, storeId = 'default') {
  const cache = loadCache(campaignKey, storeId);
  const result = [];
  for (const val of Object.values(cache.items || {})) {
    if (val.discount >= minDiscount) result.push(val);
  }
  return result.sort((a, b) => b.discount - a.discount);
}

module.exports = {
  loadCache,
  saveCache,
  findAlertWorthyDeals,
  getCachedDeals,
  getIstContext,
  getCanonicalItemKey,
  normalizeProductName
};
