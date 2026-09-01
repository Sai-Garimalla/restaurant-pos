const express = require('express');
const router = express.Router();
const mqtt = require('mqtt');
const { pool } = require('../db/connection');
const { authenticateToken, requireAdminOrStaff } = require('../middleware/auth');
router.use(authenticateToken);

// ── IST time helper ──
function getIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

// ── Token prefix based on order type + IST time ──
// DM = Delivery Morning (before 16:00 IST), DE = Delivery Evening (16:00+)
// TM = Takeaway Morning, TE = Takeaway Evening
// T  = Dine-in (no prefix differentiation) => changed to DIN
function getTokenPrefix(orderType) {
  const type = (orderType || '').toLowerCase();
  const ist  = getIST();
  const hour = ist.getHours(); // 0–23
  const isMorning = hour < 16; // before 4 PM IST
  if (type.includes('delivery'))  return isMorning ? 'DM' : 'DE';
  if (type.includes('takeaway'))  return isMorning ? 'TM' : 'TE';
  return 'DIN'; // Dine-in
}

// ── Generate next token for a given prefix ──
async function getNextToken(prefix) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const pfx = prefix || 'DIN';
    // For Dine-in 'DIN', respect token_format (daily vs continuous)
    let dateKey;
    if (pfx === 'DIN') {
      const [settings] = await conn.execute(
        "SELECT value FROM settings WHERE key_name = 'token_format'"
      );
      const format = settings[0]?.value || 'daily';
      dateKey = format === 'daily'
        ? getIST().toISOString().split('T')[0]
        : '0000-01-01';
    } else {
      // Delivery/Takeaway tokens always reset daily
      dateKey = getIST().toISOString().split('T')[0];
    }

    await conn.execute(
      'INSERT INTO token_counter (counter_date, prefix, last_token) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE last_token = last_token + 1',
      [dateKey, pfx]
    );
    const [counter] = await conn.execute(
      'SELECT last_token FROM token_counter WHERE counter_date = ? AND prefix = ?',
      [dateKey, pfx]
    );
    await conn.commit();
    return counter[0].last_token;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ── Bill number: YYYYMMDD-PREFIX+TOKEN format ──
function generateBillNumber(date, prefix, token) {
  const d = date || new Date();
  const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
  const pfx = prefix || 'DIN';
  // Always format as PREFIX + 3-digit padded token: DM001, DE003, DIN005
  const tokenPart = pfx + String(token).padStart(3, '0');
  return `${dateStr}-${tokenPart}`;
}

// ── MQTT cloud print bridge ──
let mqttClient = null;
const rawMqttHost = (process.env.MQTT_HOST || '').trim();
const isMqttConfigured = Boolean(
  rawMqttHost &&
  !rawMqttHost.includes('example.com') &&
  !rawMqttHost.startsWith('your-') &&
  rawMqttHost !== 'placeholder'
);

if (isMqttConfigured) {
  let lastMqttErrorMsg = null;
  let lastMqttOfflineWarned = false;

  mqttClient = mqtt.connect(`mqtts://${rawMqttHost}`, {
    username: process.env.MQTT_USER || undefined,
    password: process.env.MQTT_PASS || undefined,
    reconnectPeriod: 10000,   // reconnect every 10s (throttled)
    connectTimeout: 10000,   // 10s connect timeout
  });

  mqttClient.on('connect', () => {
    lastMqttErrorMsg = null;
    lastMqttOfflineWarned = false;
    console.log('✅ Connected to MQTT Print Broker');
  });

  mqttClient.on('error', (err) => {
    // Only log once per unique error message to prevent console spam
    if (lastMqttErrorMsg !== err.message) {
      lastMqttErrorMsg = err.message;
      console.error(`❌ MQTT Broker Error (${rawMqttHost}):`, err.message);
    }
  });

  mqttClient.on('offline', () => {
    if (!lastMqttOfflineWarned) {
      lastMqttOfflineWarned = true;
      console.warn('⚠️  MQTT Broker offline');
    }
  });
} else {
  console.log('ℹ️  MQTT Print Broker not configured — cloud printing via ESP32 is disabled.');
}

// ── Wait for MQTT connection (handles Vercel cold-start delay) ──
function waitForMqttConnect(timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (!mqttClient) return reject(new Error('MQTT not configured'));
    if (mqttClient.connected) return resolve();
    const timer = setTimeout(() => reject(new Error('MQTT connect timeout')), timeoutMs);
    mqttClient.once('connect', () => { clearTimeout(timer); resolve(); });
    mqttClient.once('error',   (e) => { clearTimeout(timer); reject(e); });
  });
}

function printToPrinter(ip, port, data) {
  return new Promise(async (resolve, reject) => {
    if (!ip) return resolve({ skipped: true, reason: 'No printer IP configured' });
    if (!mqttClient) return resolve({ skipped: true, reason: 'MQTT not configured (MQTT_HOST missing)' });

    // If not yet connected (Vercel cold-start), wait up to 6 s for connection
    if (!mqttClient.connected) {
      try {
        await waitForMqttConnect(6000);
      } catch (e) {
        return resolve({ skipped: true, reason: `MQTT not ready: ${e.message}` });
      }
    }

    mqttClient.publish(`restaurant/printer/${ip}`, data, { qos: 1 }, (err) => {
      if (err) return reject(err);
      resolve({ queued: true, method: 'MQTT', message: 'Sent to printer queue' });
    });
  });
}

// ── Word-wrap helper for receipt/KOT (wraps at nearest space) ──
function wrapAt(str, width) {
  const words = String(str || '').split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? line + ' ' + w : w;
    if (candidate.length <= width) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      // If single word is longer than width, hard-cut it
      line = w.length > width ? w.slice(0, width) : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ── Recompute bill totals server-side from menu prices ──
// Manual items (no item_code) use the client-supplied unit_price.
// Menu items are validated against menu.default_price.
async function recomputeTotals(conn, items, deliveryEnabled, deliveryCharge, parcelEnabled, parcelCharge, discountEnabled, discountType, discountValue) {
  // Fetch menu prices for all non-manual item codes in one query
  const menuCodes = items.filter(i => i.item_code && !i.is_manual).map(i => i.item_code);
  let menuPrices = {};
  if (menuCodes.length > 0) {
    const placeholders = menuCodes.map(() => '?').join(',');
    const [menuRows] = await conn.execute(
      `SELECT item_code, default_price FROM menu WHERE item_code IN (${placeholders})`,
      menuCodes
    );
    menuRows.forEach(r => { menuPrices[r.item_code] = parseFloat(r.default_price); });
  }

  let subtotal = 0;
  const resolvedItems = items.map(item => {
    // Trust cashier price from client (allows editing price on order page)
    const unitPrice = item.unit_price != null ? parseFloat(item.unit_price) :
      (!item.is_manual && item.item_code && menuPrices[item.item_code] != null) ? menuPrices[item.item_code] : 0;
    const qty = parseInt(item.quantity) || 1;
    const lineTotal = parseFloat((unitPrice * qty).toFixed(2));
    subtotal += lineTotal;
    return { ...item, unit_price: unitPrice, line_total: lineTotal };
  });
  subtotal = parseFloat(subtotal.toFixed(2));

  const dc = deliveryEnabled ? (parseFloat(deliveryCharge) || 0) : 0;
  const pc = parcelEnabled ? (parseFloat(parcelCharge) || 0) : 0;
  let discAmt = 0;
  if (discountEnabled) {
    if (discountType === 'percentage') {
      discAmt = parseFloat(((subtotal + dc + pc) * (parseFloat(discountValue) || 0)) / 100).toFixed(2);
    } else {
      discAmt = parseFloat(discountValue) || 0;
    }
  }
  const grandTotal = parseFloat((subtotal + dc + pc - discAmt).toFixed(2));
  return { resolvedItems, subtotal, discountAmount: discAmt, grandTotal };
}
// lineWidth: 48 chars for 80mm paper, 32 chars for 58mm paper
function ep(lineWidth = 48) {
  const ESC = '\x1B', GS = '\x1D', LF = '\n';
  return {
    LF, INIT: ESC+'@', BOLD_ON: ESC+'E\x01', BOLD_OFF: ESC+'E\x00',
    CENTER: ESC+'a\x01', LEFT: ESC+'a\x00',
    DBL_HT: GS+'!\x11', LARGE: GS+'!\x33', NORMAL: GS+'!\x00',
    CUT: GS+'V\x41\x03',
    lineWidth,
    DLINE: '='.repeat(lineWidth), SLINE: '-'.repeat(lineWidth),
    pad:  (s, l) => String(s == null ? '' : s).padEnd(l).slice(0, l),
    padL: (s, l) => String(s == null ? '' : s).padStart(l).slice(-l),
  };
}

// ── Customer Receipt (full details) ──
async function buildCustomerReceipt(bill, items, settings) {
  const paperWidth = parseInt(settings.paper_width) === 58 ? 58 : 80;
  const lw = paperWidth === 58 ? 32 : 48;  // chars per line
  const colA = Math.floor(lw * 0.5);       // left column width in 2-col layouts
  const colB = lw - colA - 2;              // right column (minus 2 for separator)
  const itemNameW  = Math.floor(lw * 0.5); // item name column
  const totalsLabelW = lw - 12;            // totals label width

  const tz = settings.timezone || 'Asia/Kolkata';
  const { LF, INIT, BOLD_ON, BOLD_OFF, CENTER, LEFT, DBL_HT, NORMAL, CUT, SLINE, pad, padL } = ep(lw);

  let r = INIT;
  r += CENTER + BOLD_ON + DBL_HT + (settings.restaurant_name || 'Restaurant') + LF + NORMAL + BOLD_OFF;
  if (settings.tagline) r += CENTER + settings.tagline + LF;
  if (settings.address) {
    settings.address.split('\n').forEach(line => { r += CENTER + line.trim() + LF; });
  }
  if (settings.phone)   r += CENTER + 'Ph: ' + settings.phone + LF;
  if (settings.email)   r += CENTER + 'Email: ' + settings.email + LF;
  if (settings.gst_number) r += CENTER + 'GSTIN: ' + settings.gst_number + LF;
  r += LEFT + SLINE + LF;
  r += CENTER + BOLD_ON + 'CUSTOMER RECEIPT' + BOLD_OFF + LF;
  r += LEFT + SLINE + LF;

  r += 'Bill No  : ' + bill.bill_number + LF;
  r += 'Date     : ' + new Date(bill.created_at).toLocaleDateString('en-IN', { timeZone: tz }) + LF;
  r += 'Time     : ' + new Date(bill.created_at).toLocaleTimeString('en-IN', { timeZone: tz }) + LF;
  r += SLINE + LF;
  // ── 2-column header grid ──
  r += pad('Token: ', 7) + BOLD_ON + pad(String(bill.token_prefix || 'DIN') + String(bill.token_number).padStart(3,'0'), 10) + BOLD_OFF +
       '  ' + 'Type: ' + BOLD_ON + (bill.order_type || 'Dine-in') + BOLD_OFF + LF;
  // Row 2: Customer | Phone
  const custL = bill.customer_name  ? 'Cus: '   + BOLD_ON + pad(bill.customer_name,  colA - 5) + BOLD_OFF : ''.padEnd(colA);
  const custR = bill.customer_phone ? 'Phone: '  + BOLD_ON + bill.customer_phone + BOLD_OFF : '';
  if (bill.customer_name || bill.customer_phone) r += custL + '  ' + custR + LF;
  // Row 3: Location | Taken By
  const locStr  = bill.delivery_address ? 'Loc: ' + BOLD_ON + pad(bill.delivery_address, colA - 5) + BOLD_OFF : ''.padEnd(colA);
  const takenStr = bill.cashier_name   ? 'Taken: ' + BOLD_ON + bill.cashier_name + BOLD_OFF : '';
  if (bill.delivery_address || bill.cashier_name) r += locStr + '  ' + takenStr + LF;
  r += SLINE + LF;

  // Items header: ITEM(itemNameW) QTY(4) PRICE(lw-itemNameW-4-12) AMT(12)
  const priceW = lw - itemNameW - 4 - 12;
  const amtW = 12;
  r += BOLD_ON + pad('ITEM', itemNameW) + padL('QTY', 4) + padL('PRICE', priceW) + padL('AMT', amtW) + LF + BOLD_OFF;
  r += SLINE + LF;

  for (const item of items) {
    const nameLines = wrapAt(item.item_name, itemNameW);
    r += pad(nameLines[0], itemNameW) + padL(item.quantity, 4) +
         padL(parseFloat(item.unit_price).toFixed(2), priceW) +
         padL(parseFloat(item.line_total).toFixed(2), amtW) + LF;
    for (let i = 1; i < nameLines.length; i++) {
      r += pad('  ' + nameLines[i], itemNameW) + LF;
    }
  }

  r += SLINE + LF;
  r += pad('Subtotal', totalsLabelW) + padL(parseFloat(bill.subtotal).toFixed(2), 12) + LF;
  if (bill.delivery_enabled && bill.delivery_charge) {
    r += pad('Delivery Charge', totalsLabelW) + padL(parseFloat(bill.delivery_charge).toFixed(2), 12) + LF;
  }
  if (bill.parcel_enabled && bill.parcel_charge) {
    r += pad('Parcel Charge', totalsLabelW) + padL(parseFloat(bill.parcel_charge).toFixed(2), 12) + LF;
  }
  if (bill.discount_enabled && parseFloat(bill.discount_amount) > 0) {
    const discLabel = `Discount (${bill.discount_type === 'percentage' ? bill.discount_value + '%' : 'Rs.' + bill.discount_value})`;
    r += pad(discLabel, totalsLabelW) + padL('-' + parseFloat(bill.discount_amount).toFixed(2), 12) + LF;
  }
  r += SLINE + LF;
  r += BOLD_ON + pad('GRAND TOTAL', totalsLabelW) + padL(parseFloat(bill.grand_total).toFixed(2), 12) + LF + BOLD_OFF;
  r += SLINE + LF;
  const footerText = settings.footer || 'Thank you! Visit again.';
  footerText.split('\n').forEach(line => { r += CENTER + line.trim() + LF; });
  r += LF + LF + LF + CUT;
  return Buffer.from(r, 'latin1');
}

// ── KOT (Kitchen Order Ticket) ──
async function buildKOT(bill, items, settings) {
  const paperWidth = parseInt(settings.paper_width) === 58 ? 58 : 80;
  const lw = paperWidth === 58 ? 32 : 48;
  const colA = Math.floor(lw * 0.5);
  const itemNameW = lw - 7; // leave 7 chars for QTY column

  const { LF, INIT, BOLD_ON, BOLD_OFF, CENTER, LEFT, CUT, DLINE, pad, padL } = ep(lw);

  let k = INIT + LEFT;
  k += CENTER + BOLD_ON + (settings.restaurant_name || 'Restaurant') + BOLD_OFF + LF;
  k += CENTER + BOLD_ON + '*** KITCHEN ORDER ***' + BOLD_OFF + LF;
  k += CENTER + DLINE + LF;
  // ── 2-column header grid ──
  k += pad('Token: ', 7) + BOLD_ON + pad(String(bill.token_prefix || 'DIN') + String(bill.token_number).padStart(3,'0'), 10) + BOLD_OFF +
       '  ' + 'Type: ' + BOLD_ON + (bill.order_type || 'Dine-in') + BOLD_OFF + LF;
  const kCustL = bill.customer_name  ? 'Cus: '  + BOLD_ON + pad(bill.customer_name,  colA - 5) + BOLD_OFF : ''.padEnd(colA);
  const kCustR = bill.customer_phone ? 'Phone: ' + BOLD_ON + bill.customer_phone + BOLD_OFF : '';
  if (bill.customer_name || bill.customer_phone) k += kCustL + '  ' + kCustR + LF;
  const kLocL  = bill.delivery_address ? 'Loc: ' + BOLD_ON + pad(bill.delivery_address, colA - 5) + BOLD_OFF : ''.padEnd(colA);
  const kTaken = bill.cashier_name    ? 'Taken: ' + BOLD_ON + bill.cashier_name + BOLD_OFF : '';
  if (bill.delivery_address || bill.cashier_name) k += kLocL + '  ' + kTaken + LF;
  if (bill.custom_note) k += BOLD_ON + 'Note: ' + bill.custom_note + BOLD_OFF + LF;
  k += DLINE + LF;
  // Header: ITEM(itemNameW) QTY(7) = lw
  k += BOLD_ON + 'ITEM'.padEnd(itemNameW) + 'QTY'.padStart(7) + LF + BOLD_OFF;
  k += DLINE + LF;

  for (const item of items) {
    const nameLines = wrapAt(item.item_name, itemNameW);
    k += nameLines[0].padEnd(itemNameW) + String(item.quantity).padStart(7) + LF;
    for (let i = 1; i < nameLines.length; i++) {
      k += ('  ' + nameLines[i]).padEnd(itemNameW) + LF;
    }
    if (item.item_note) k += '  -> ' + item.item_note + LF;
  }

  k += DLINE + LF + LF + LF + CUT;
  return Buffer.from(k, 'latin1');
}

// ── Counter Checklist (full details + checkboxes) ──
async function buildCounterChecklist(bill, items, settings) {
  const paperWidth = parseInt(settings.paper_width) === 58 ? 58 : 80;
  const lw = paperWidth === 58 ? 32 : 48;
  const itemNameW = Math.floor(lw * 0.58); // item name column after [ ] prefix
  const totalsLabelW = lw - 12;

  const { LF, INIT, BOLD_ON, BOLD_OFF, CENTER, LEFT, CUT, DLINE, SLINE, pad, padL } = ep(lw);

  let c = INIT + LEFT;
  c += CENTER + BOLD_ON + (settings.restaurant_name || 'Restaurant') + BOLD_OFF + LF;
  if (settings.address) {
    settings.address.split('\n').forEach(line => { c += CENTER + line.trim() + LF; });
  }
  if (settings.phone)   c += CENTER + 'Ph: ' + settings.phone + LF;
  c += CENTER + BOLD_ON + '*** COUNTER CHECKLIST ***' + BOLD_OFF + LF;
  c += CENTER + 'Pack & Verify each item before dispatch' + LF;
  c += DLINE + LF;

  c += 'Bill No  : ' + bill.bill_number + LF;
  const cTz = settings.timezone || 'Asia/Kolkata';
  const dateStr = 'Date: ' + new Date(bill.created_at).toLocaleDateString('en-IN', { timeZone: cTz });
  const timeStr = 'Time: ' + new Date(bill.created_at).toLocaleTimeString('en-IN', { timeZone: cTz });
  c += dateStr.padEnd(24).slice(0, 24) + timeStr.padEnd(24).slice(0, 24) + LF;
  c += DLINE + LF;
  // ── 2-column header grid (no Taken By on checklist) ──
  c += pad('Token: ', 7) + BOLD_ON + pad(String(bill.token_prefix || 'DIN') + String(bill.token_number).padStart(3,'0'), 10) + BOLD_OFF +
       '  ' + 'Type: ' + BOLD_ON + (bill.order_type || 'Dine-in') + BOLD_OFF + LF;
  const cCustL = bill.customer_name  ? 'Cus: '  + BOLD_ON + pad(bill.customer_name,  13) + BOLD_OFF : ''.padEnd(24);
  const cCustR = bill.customer_phone ? 'Phone: ' + BOLD_ON + bill.customer_phone + BOLD_OFF : '';
  if (bill.customer_name || bill.customer_phone) c += cCustL + '  ' + cCustR + LF;
  if (bill.delivery_address) c += 'Loc: ' + BOLD_ON + bill.delivery_address + BOLD_OFF + LF;
  if (bill.custom_note) c += BOLD_ON + 'Note: ' + bill.custom_note + BOLD_OFF + LF;
  c += DLINE + LF;

  // Checklist header: [ ] ITEM(itemNameW) QTY(5) AMOUNT(lw-itemNameW-4-5) = lw
  const amtColW = lw - itemNameW - 4 - 5;
  c += BOLD_ON + '[ ] ' + pad('ITEM', itemNameW) + padL('QTY', 5) + padL('AMOUNT', amtColW) + LF + BOLD_OFF;
  c += SLINE + LF;

  for (const item of items) {
    const name  = pad(item.item_name, itemNameW);
    const qty   = padL(item.quantity, 5);
    const price = padL(parseFloat(item.line_total).toFixed(2), amtColW);
    c += '[ ] ' + name + qty + price + LF;
    // Show unit price below if qty > 1
    if (item.quantity > 1) {
      c += '    @ Rs.' + parseFloat(item.unit_price).toFixed(2) + ' x ' + item.quantity + LF;
    }
    if (item.item_note) c += '    Note: ' + item.item_note + LF;
    c += SLINE + LF;
  }

  c += DLINE + LF;
  c += pad('Subtotal', totalsLabelW) + padL(parseFloat(bill.subtotal).toFixed(2), 12) + LF;
  if (bill.delivery_enabled && bill.delivery_charge) {
    c += pad('Delivery Charge', totalsLabelW) + padL(parseFloat(bill.delivery_charge).toFixed(2), 12) + LF;
  }
  if (bill.parcel_enabled && bill.parcel_charge) {
    c += pad('Parcel Charge', totalsLabelW) + padL(parseFloat(bill.parcel_charge).toFixed(2), 12) + LF;
  }
  if (bill.discount_enabled && parseFloat(bill.discount_amount) > 0) {
    const discLabel = `Discount (${bill.discount_type === 'percentage' ? bill.discount_value + '%' : 'Rs.' + bill.discount_value})`;
    c += pad(discLabel, totalsLabelW) + padL('-' + parseFloat(bill.discount_amount).toFixed(2), 12) + LF;
  }
  c += DLINE + LF;
  c += BOLD_ON + pad('GRAND TOTAL', totalsLabelW) + padL(parseFloat(bill.grand_total).toFixed(2), 12) + LF + BOLD_OFF;
  c += DLINE + LF;
  
  if (bill.order_type && (bill.order_type.includes('Takeaway') || bill.order_type.includes('Delivery'))) {
    c += BOLD_ON + 'Payment Status: [ ] PAID    [ ] UNPAID' + BOLD_OFF + LF;
    c += DLINE + LF;
  }

  const clerk = bill.cashier_name || '____________';
  c += 'Packed by: ' + pad(clerk, 14) + ' Checked by: ' + pad(clerk, 14) + LF;
  c += LF + LF + LF + CUT;
  return Buffer.from(c, 'latin1');
}

// ── POST / — Create Bill ──
router.post('/', requireAdminOrStaff, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const {
      items, customer_name, customer_phone, delivery_address, order_type, custom_note,
      delivery_enabled, delivery_charge,
      parcel_enabled, parcel_charge,
      discount_enabled, discount_type, discount_value, discount_amount,
      subtotal, grand_total, status, token_number, print_intent,
      cash_collected, upi_collected
    } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Bill must have at least one item.' });
    }

    const orderTypeVal = order_type || 'Dine-in';
    const prefix = getTokenPrefix(orderTypeVal);
    const token = token_number || await getNextToken(prefix);
    const now = new Date();
    const billStatus = status === 'draft' ? 'draft' : 'completed';
    const billNumber = generateBillNumber(now, prefix, token);
    // display string e.g. "DM001", "TE001", "DIN005"
    const tokenDisplay = prefix + String(token).padStart(3, '0');

    const { resolvedItems, subtotal: computedSubtotal, discountAmount: computedDiscAmt, grandTotal: computedGrandTotal } =
      await recomputeTotals(conn, items, delivery_enabled, delivery_charge, parcel_enabled, parcel_charge, discount_enabled, discount_type, discount_value);

    const [billResult] = await conn.execute(
      `INSERT INTO bills
       (bill_number, token_number, token_prefix, customer_name, customer_phone, order_type, delivery_address, custom_note,
        subtotal, delivery_enabled, delivery_charge,
        parcel_enabled, parcel_charge,
        discount_enabled, discount_type, discount_value, discount_amount,
        grand_total, status, created_by, created_at, cash_collected, upi_collected)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        billNumber, token, prefix,
        customer_name || null, customer_phone || null,
        orderTypeVal, delivery_address || null, custom_note || null,
        computedSubtotal,
        delivery_enabled ? 1 : 0, delivery_charge || 0,
        parcel_enabled ? 1 : 0, parcel_charge || 0,
        discount_enabled ? 1 : 0, discount_type || 'fixed',
        discount_value || 0, computedDiscAmt,
        computedGrandTotal, billStatus, req.user.id, now,
        cash_collected || 0, upi_collected || 0
      ]
    );

    const billId = billResult.insertId;

    for (const item of resolvedItems) {
      await conn.execute(
        'INSERT INTO bill_items (bill_id, item_code, item_name, quantity, unit_price, line_total, is_manual, item_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [billId, item.item_code || null, item.item_name, item.quantity, item.unit_price, item.line_total, item.is_manual ? 1 : 0, item.item_note || null]
      );
    }

    await conn.commit();

    // Fetch settings for printing
    const [settingsRows] = await pool.execute('SELECT key_name, value FROM settings');
    const settings = {};
    settingsRows.forEach(r => { settings[r.key_name] = r.value; });

    const bill = {
      bill_id: billId, bill_number: billNumber, token_number: token, token_prefix: prefix,
      token_display: tokenDisplay,
      customer_name: customer_name || null,
      customer_phone: customer_phone || null,
      order_type: orderTypeVal,
      delivery_address: delivery_address || null,
      custom_note: custom_note || null,
      subtotal: computedSubtotal, delivery_enabled: delivery_enabled ? 1 : 0, delivery_charge: delivery_charge || 0,
      parcel_enabled: parcel_enabled ? 1 : 0, parcel_charge: parcel_charge || 0,
      discount_enabled: discount_enabled ? 1 : 0, discount_type: discount_type || 'fixed',
      discount_value: discount_value || 0, discount_amount: computedDiscAmt,
      grand_total: computedGrandTotal, created_at: now, cashier_name: req.user.full_name || req.user.username
    };

    let printResults = [];
    let receiptB64 = null, kotB64 = null, checklistB64 = null;

    // Helper: should we print this doc type?
    const shouldPrint = (docType) => {
      if (print_intent === false || !print_intent) return false;
      if (print_intent === true || print_intent === 'all') return true;
      const map = {
        kot: ['kot','kot_receipt','kot_checklist','all'],
        receipt: ['receipt','kot_receipt','receipt_checklist','all'],
        checklist: ['checklist','kot_checklist','receipt_checklist','all'],
      };
      return (map[docType] || []).includes(print_intent);
    };

    if (billStatus === 'completed') {
      // Receipt
      if (shouldPrint('receipt') && settings.customer_printer_ip) {
        const data = await buildCustomerReceipt(bill, items, settings);
        receiptB64 = data.toString('base64');
        try { const r = await printToPrinter(settings.customer_printer_ip, settings.customer_printer_port, data); printResults.push({ type:'receipt', ...r }); }
        catch(e) { printResults.push({ type:'receipt', error: e.message }); }
      } else if (shouldPrint('receipt')) {
        const data = await buildCustomerReceipt(bill, items, settings);
        receiptB64 = data.toString('base64');
        printResults.push({ type:'receipt', skipped:true, reason:'No customer printer IP' });
      }
      // KOT
      if (shouldPrint('kot') && settings.kitchen_printer_ip) {
        const data = await buildKOT(bill, items, settings);
        kotB64 = data.toString('base64');
        try { const r = await printToPrinter(settings.kitchen_printer_ip, settings.kitchen_printer_port, data); printResults.push({ type:'kot', ...r }); }
        catch(e) { printResults.push({ type:'kot', error: e.message }); }
      } else if (shouldPrint('kot')) {
        const data = await buildKOT(bill, items, settings);
        kotB64 = data.toString('base64');
        printResults.push({ type:'kot', skipped:true, reason:'No kitchen printer IP' });
      }
      // Checklist (skip for Dine-in)
      const isDineIn = (bill.order_type || '').toLowerCase().includes('dine');
      if (!isDineIn && shouldPrint('checklist') && settings.customer_printer_ip) {
        const data = await buildCounterChecklist(bill, items, settings);
        checklistB64 = data.toString('base64');
        try { const r = await printToPrinter(settings.customer_printer_ip, settings.customer_printer_port, data); printResults.push({ type:'checklist', ...r }); }
        catch(e) { printResults.push({ type:'checklist', error: e.message }); }
      } else if (!isDineIn && shouldPrint('checklist')) {
        const data = await buildCounterChecklist(bill, items, settings);
        checklistB64 = data.toString('base64');
        printResults.push({ type:'checklist', skipped:true, reason:'No printer IP' });
      }
    }

    res.json({
      success: true, bill_id: billId, bill_number: billNumber, token_number: token,
      token_prefix: prefix, token_display: tokenDisplay,
      print_results: printResults, status: billStatus,
      receipt_b64: receiptB64, kot_b64: kotB64, checklist_b64: checklistB64
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});


// ── PUT /:billId — Update Bill ──
router.put('/:billId', requireAdminOrStaff, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const billId = req.params.billId;
    const {
      items, customer_name, customer_phone, delivery_address, order_type, custom_note,
      delivery_enabled, delivery_charge,
      parcel_enabled, parcel_charge,
      discount_enabled, discount_type, discount_value, discount_amount,
      subtotal, grand_total, status, print_intent,
      cash_collected, upi_collected
    } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Bill must have at least one item.' });
    }

    const billStatus = status === 'draft' ? 'draft' : 'completed';

    const { resolvedItems: updatedItems, subtotal: updSubtotal, discountAmount: updDiscAmt, grandTotal: updGrandTotal } =
      await recomputeTotals(conn, items, delivery_enabled, delivery_charge, parcel_enabled, parcel_charge, discount_enabled, discount_type, discount_value);

    await conn.execute(
      `UPDATE bills SET 
        customer_name=?, customer_phone=?, order_type=?, delivery_address=?, custom_note=?,
        subtotal=?, delivery_enabled=?, delivery_charge=?, parcel_enabled=?, parcel_charge=?,
        discount_enabled=?, discount_type=?, discount_value=?, discount_amount=?,
        grand_total=?, status=?, cash_collected=?, upi_collected=?
       WHERE bill_id=?`,
      [
        customer_name || null, customer_phone || null,
        order_type || 'Dine-in', delivery_address || null, custom_note || null,
        updSubtotal,
        delivery_enabled ? 1 : 0, delivery_charge || 0,
        parcel_enabled ? 1 : 0, parcel_charge || 0,
        discount_enabled ? 1 : 0, discount_type || 'fixed',
        discount_value || 0, updDiscAmt,
        updGrandTotal, billStatus, cash_collected || 0, upi_collected || 0, billId
      ]
    );

    await conn.execute('DELETE FROM bill_items WHERE bill_id=?', [billId]);

    for (const item of updatedItems) {
      await conn.execute(
        'INSERT INTO bill_items (bill_id, item_code, item_name, quantity, unit_price, line_total, is_manual, item_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [billId, item.item_code || null, item.item_name, item.quantity, item.unit_price, item.line_total, item.is_manual ? 1 : 0, item.item_note || null]
      );
    }

    await conn.commit();

    // Fetch updated bill (includes token_prefix)
    const [bills] = await conn.execute('SELECT * FROM bills WHERE bill_id=?', [billId]);
    const billData = bills[0];
    billData.cashier_name = req.user.full_name || req.user.username;
    const prefixStored = billData.token_prefix || 'DIN';
    const tokenNum   = billData.token_number;
    const tokenDisp  = prefixStored + String(tokenNum).padStart(3, '0');

    // Fetch settings for printing
    const [settingsRows] = await pool.execute('SELECT key_name, value FROM settings');
    const settings = {};
    settingsRows.forEach(r => { settings[r.key_name] = r.value; });

    let printResults = [];
    let receiptB64 = null, kotB64 = null, checklistB64 = null;

    const shouldPrint = (docType) => {
      if (print_intent === false || !print_intent) return false;
      if (print_intent === true || print_intent === 'all') return true;
      const map = {
        kot: ['kot','kot_receipt','kot_checklist','all'],
        receipt: ['receipt','kot_receipt','receipt_checklist','all'],
        checklist: ['checklist','kot_checklist','receipt_checklist','all'],
      };
      return (map[docType] || []).includes(print_intent);
    };

    if (billStatus === 'completed') {
      if (shouldPrint('receipt') && settings.customer_printer_ip) {
        const data = await buildCustomerReceipt(billData, items, settings);
        receiptB64 = data.toString('base64');
        try { const r = await printToPrinter(settings.customer_printer_ip, settings.customer_printer_port, data); printResults.push({ type:'receipt', ...r }); }
        catch(e) { printResults.push({ type:'receipt', error: e.message }); }
      } else if (shouldPrint('receipt')) {
        const data = await buildCustomerReceipt(billData, items, settings);
        receiptB64 = data.toString('base64');
        printResults.push({ type:'receipt', skipped:true, reason:'No customer printer IP' });
      }

      if (shouldPrint('kot') && settings.kitchen_printer_ip) {
        const data = await buildKOT(billData, items, settings);
        kotB64 = data.toString('base64');
        try { const r = await printToPrinter(settings.kitchen_printer_ip, settings.kitchen_printer_port, data); printResults.push({ type:'kot', ...r }); }
        catch(e) { printResults.push({ type:'kot', error: e.message }); }
      } else if (shouldPrint('kot')) {
        const data = await buildKOT(billData, items, settings);
        kotB64 = data.toString('base64');
        printResults.push({ type:'kot', skipped:true, reason:'No kitchen printer IP' });
      }

      const isDineIn = (billData.order_type || '').toLowerCase().includes('dine');
      if (!isDineIn && shouldPrint('checklist') && settings.customer_printer_ip) {
        const data = await buildCounterChecklist(billData, items, settings);
        checklistB64 = data.toString('base64');
        try { const r = await printToPrinter(settings.customer_printer_ip, settings.customer_printer_port, data); printResults.push({ type:'checklist', ...r }); }
        catch(e) { printResults.push({ type:'checklist', error: e.message }); }
      } else if (!isDineIn && shouldPrint('checklist')) {
        const data = await buildCounterChecklist(billData, items, settings);
        checklistB64 = data.toString('base64');
        printResults.push({ type:'checklist', skipped:true, reason:'No printer IP' });
      }
    }

    res.json({
      success: true, bill_id: billId,
      bill_number: billData.bill_number, token_number: tokenNum,
      token_prefix: prefixStored, token_display: tokenDisp,
      print_results: printResults, status: billStatus,
      receipt_b64: receiptB64, kot_b64: kotB64, checklist_b64: checklistB64
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// ── POST /:billId/reprint ──
router.post('/:billId/reprint', async (req, res) => {
  try {
    const { type } = req.body; // 'receipt', 'kot', 'checklist', 'both'
    const [bills] = await pool.execute(
      'SELECT b.*, u.full_name AS cashier_name FROM bills b LEFT JOIN users u ON b.created_by = u.id WHERE b.bill_id = ?',
      [req.params.billId]
    );
    if (!bills.length) return res.status(404).json({ error: 'Bill not found.' });
    const [items] = await pool.execute('SELECT * FROM bill_items WHERE bill_id = ?', [req.params.billId]);
    const [settingsRows] = await pool.execute('SELECT key_name, value FROM settings');
    const settings = {};
    settingsRows.forEach(r => { settings[r.key_name] = r.value; });

    const bill = bills[0];
    let printResults = [];
    let receiptB64 = null, kotB64 = null, checklistB64 = null;

    if (type === 'receipt' || type === 'both') {
      const data = await buildCustomerReceipt(bill, items, settings);
      receiptB64 = data.toString('base64');
      if (settings.customer_printer_ip) {
        try {
          const r = await printToPrinter(settings.customer_printer_ip, settings.customer_printer_port, data);
          printResults.push({ type: 'receipt', ...r });
        } catch (e) { printResults.push({ type: 'receipt', error: e.message }); }
      }
    }
    if (type === 'kot' || type === 'both') {
      const data = await buildKOT(bill, items, settings);
      kotB64 = data.toString('base64');
      if (settings.kitchen_printer_ip) {
        try {
          const r = await printToPrinter(settings.kitchen_printer_ip, settings.kitchen_printer_port, data);
          printResults.push({ type: 'kot', ...r });
        } catch (e) { printResults.push({ type: 'kot', error: e.message }); }
      }
    }
    if (type === 'checklist' || type === 'both') {
      const data = await buildCounterChecklist(bill, items, settings);
      checklistB64 = data.toString('base64');
      if (settings.customer_printer_ip) {
        try {
          const r = await printToPrinter(settings.customer_printer_ip, settings.customer_printer_port, data);
          printResults.push({ type: 'checklist', ...r });
        } catch (e) { printResults.push({ type: 'checklist', error: e.message }); }
      }
    }

    res.json({ success: true, print_results: printResults, receipt_b64: receiptB64, kot_b64: kotB64, checklist_b64: checklistB64 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /next-token ──
router.get('/next-token', async (req, res) => {
  try {
    const token = await getNextToken();
    res.json({ token_number: token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
