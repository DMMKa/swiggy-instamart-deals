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

  let isGlitch = false;
  const isPremiumCat = cat.includes('appliance') || cat.includes('skincare') || cat.includes('electronic');
  if (item.price <= 50 && (isPremiumCat || item.mrp >= 400)) {
    isGlitch = true;
  }

  let customThreshold = 70;

  if (brand.includes('aashirvaad') || name.includes('aashirvaad')) customThreshold = 40;
  else if (brand.includes('tide') || name.includes('tide')) customThreshold = 40;
  else if (name.includes('atta') || name.includes('coffee')) customThreshold = 40;
  else if (name.includes('cashew') || name.includes('almond') || brand.includes('ariel')) customThreshold = 50;
  else if (name.includes('dal')) customThreshold = 60;
  else if (name.includes('chocolate') || cat.includes('home decor')) customThreshold = 70;

  let tier = 'TIER_LOW';
  if (isGlitch) tier = 'GLITCH';
  else if (item.discount >= 70) tier = 'TIER_70';
  else if (item.discount >= 40) tier = 'TIER_40';

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
    
    // SKIP LOGIC: Under 40% goes completely ignored
    if (item.discount < rule.threshold && rule.tier !== 'GLITCH') continue;
    item.tier = rule.tier;

    const itemKey = getCanonicalItemKey(item);
    if (!itemKey) continue;

    // Cross-store duplicate merging
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
      // Brand new item never seen before
      shouldAlert = true;
    } else {
      const lastAlertPrice = prev.lastAlertedPrice !== undefined ? prev.lastAlertedPrice : null;
      const lastSeenPrice = prev.price !== undefined ? prev.price : null;

      if (lastAlertPrice === null) {
        // Was seen before but wasn't cheap enough to alert, now it is
        shouldAlert = true;
      } else if (item.price < lastAlertPrice) {
        // STRICT RULE: Price dropped FURTHER than the last time we shared it
        shouldAlert = true;
        alertType = 'PRICE_DROP';
      } else if (lastSeenPrice !== null && item.price < lastSeenPrice && item.price <= lastAlertPrice) {
        // STRICT RULE: Price became expensive yesterday, but dropped BACK to deal price today
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
      // Update cache silently without sending telegram alert
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
