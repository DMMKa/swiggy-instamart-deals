const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatCompactItem(deal, index = null) {
  const num = index !== null ? `${index}. ` : '• ';

  let displayName = deal.name || '';
  const pack = (deal.pack || '').trim();
  if (pack && !displayName.toLowerCase().includes(pack.toLowerCase())) {
    displayName = `${displayName} (${pack})`;
  }

  let priceLine = '';
  let locationLine = '';

  const discountBadge = deal.tier === 'MEGA_LOOT' 
    ? `💣 <b>${deal.discount}% LOOT</b>` 
    : `<b>${deal.discount}% OFF</b>`;

  if (deal.stores && deal.stores.length > 0) {
    if (deal.priceVaries || deal.stores.some(s => s.price !== deal.price)) {
      priceLine = `MRP: ₹${deal.mrp} | Best Price: ₹${deal.price} | ${discountBadge}`;
      const details = deal.stores.map((s) => `${s.label} (₹${s.price})`).join(', ');
      locationLine = `\n📍 Available at: <i>${escapeHtml(details)}</i>`;
    } else {
      priceLine = `MRP: ₹${deal.mrp} | Price: ₹${deal.price} | ${discountBadge}`;
      const names = deal.stores.map((s) => s.label).join(', ');
      locationLine = `\n📍 Available at: <i>${escapeHtml(names)}</i>`;
    }
  } else {
    priceLine = `MRP: ₹${deal.mrp} | Price: ₹${deal.price} | ${discountBadge}`;
  }

  return (
`${num}<b>${escapeHtml(displayName)}</b>
${priceLine}${locationLine}`
  );
}

function formatDealMessage(deal) {
  return formatCompactItem(deal);
}

async function sendDealAlert(bot, chatId, deal) {
  const text = formatCompactItem(deal);
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  } catch (err) {
    return false;
  }
}

async function sendBatchAlerts(bot, chatId, deals, options = {}) {
  if (!deals || !deals.length) return;

  const timeTag = options.timeString ? ` • ${options.timeString}` : '';
  const topHeader = options.workerInfo
    ? `<b>[${options.workerInfo} • ${deals.length} Deals Found${timeTag}]</b>\n\n`
    : `<b>[Instamart Deals • ${deals.length} Deals Found${timeTag}]</b>\n\n`;

  const groups = [
    { title: '🚨 <b>PRICE ERRORS & GLITCHES (≤ ₹50)</b> 🚨', items: deals.filter(d => d.tier === 'GLITCH') },
    { title: '💣 ⚡ <b>MASSIVE LOOT DEALS (80% – 100% OFF)</b> ⚡ 💣', items: deals.filter(d => d.tier === 'MEGA_LOOT') },
    { title: '🔥 <b>70% TO 79% OFF</b> 🔥', items: deals.filter(d => d.tier === 'TIER_70') },
    { title: '✨ <b>SPECIAL BRAND DEALS</b> ✨', items: deals.filter(d => d.tier === 'TIER_40' || d.tier === 'TIER_LOW') }
  ];

  const messages = [];
  let currentMsg = topHeader;

  for (const group of groups) {
    if (group.items.length === 0) continue;
    
    let groupHeader = `\n${group.title}\n`;
    
    for (let i = 0; i < group.items.length; i++) {
      const itemText = formatCompactItem(group.items[i], i + 1) + '\n\n';
      
      if ((currentMsg + groupHeader + itemText).length > 3800) {
        messages.push(currentMsg.trim());
        currentMsg = groupHeader + itemText; 
        groupHeader = ''; 
      } else {
        currentMsg += groupHeader + itemText;
        groupHeader = ''; 
      }
    }
  }

  if (currentMsg.trim()) {
    messages.push(currentMsg.trim());
  }

  for (let i = 0; i < messages.length; i++) {
    try {
      await bot.sendMessage(chatId, messages[i], {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    } catch (err) {
      console.error('[Notifier] Failed to send batch message:', err.message);
    }
    if (i < messages.length - 1) {
      await sleep(1000);
    }
  }
}

module.exports = { formatCompactItem, formatDealMessage, sendDealAlert, sendBatchAlerts };
