const express = require('express');
const router = express.Router();
const { pool } = require('../db/connection');
const { authenticateToken, requireDeliveryBoy, requireAdminOrStaff, requireKitchen } = require('../middleware/auth');

router.use(authenticateToken);

// Helper: get current IST date string
function getISTDateStr(offset = 0) {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  if (offset) now.setDate(now.getDate() + offset);
  return now.toISOString().split('T')[0];
}
const IST_CREATED = "CONVERT_TZ(b.created_at,'+00:00','+05:30')";

// Validate a date string is YYYY-MM-DD
function isValidDate(str) { return str && /^\d{4}-\d{2}-\d{2}$/.test(str); }

// ─────────────────────────────────────────────
// DELIVERY BOY ROUTES
// ─────────────────────────────────────────────

// GET /api/delivery/locations — distinct delivery addresses for filter dropdown
router.get('/locations', requireDeliveryBoy, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT delivery_address
       FROM bills
       WHERE delivery_address IS NOT NULL AND delivery_address != ''
         AND order_type LIKE '%Delivery%'
       ORDER BY delivery_address ASC`
    );
    res.json({ locations: rows.map(r => r.delivery_address) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/delivery/orders — list delivery orders
// Delivery boys see: open + their assigned orders
// Admin/staff see: all delivery orders
router.get('/orders', requireDeliveryBoy, async (req, res) => {
  try {
    const role = req.user.role;
    const isDeliveryBoy = role === 'delivery_boy';

    // Delivery boys only see Delivery orders (not Takeaway/Dine-in)
    // Admin/Staff can see all
    let where = isDeliveryBoy
      ? `WHERE b.order_type LIKE '%Delivery%' AND b.status = 'completed'`
      : `WHERE (b.order_type LIKE '%Delivery%' OR b.order_type LIKE '%Takeaway%') AND b.status = 'completed'`;
    const params = [];

    const period = req.query.period || 'all'; // Default to all to show pending easily
    const customFrom = req.query.from || null;
    const customTo = req.query.to || null;
    const todayStr = getISTDateStr();

    let dateClause = '';
    const dateClauseParams = [];
    switch (period) {
      case 'today':
        dateClause = `DATE(${IST_CREATED}) = ?`;
        dateClauseParams.push(todayStr);
        break;
      case 'yesterday':
        dateClause = `DATE(${IST_CREATED}) = ?`;
        dateClauseParams.push(getISTDateStr(-1));
        break;
      case 'week':
        dateClause = `DATE(${IST_CREATED}) >= DATE_SUB(?, INTERVAL 6 DAY)`;
        dateClauseParams.push(todayStr);
        break;
      case 'month':
        dateClause = `DATE(${IST_CREATED}) >= DATE_SUB(?, INTERVAL 29 DAY)`;
        dateClauseParams.push(todayStr);
        break;
      case 'year':
        dateClause = `DATE(${IST_CREATED}) >= DATE_SUB(?, INTERVAL 1 YEAR)`;
        dateClauseParams.push(todayStr);
        break;
      case 'custom': {
        const f = isValidDate(customFrom) ? customFrom : todayStr;
        const t = isValidDate(customTo)   ? customTo   : todayStr;
        dateClause = `DATE(${IST_CREATED}) BETWEEN ? AND ?`;
        dateClauseParams.push(f, t);
        break;
      }
      case 'all':
      default:
        dateClause = '';
    }

    if (dateClause) {
      where += ` AND ${dateClause}`;
      params.push(...dateClauseParams);
    }

    if (isDeliveryBoy) {
      // Delivery boys see: undelivered Delivery orders OR Delivery orders assigned/delivered by them
      where += ` AND (b.delivery_status IN ('pending','preparing','ready','picked_up') OR b.delivered_by = ?)`;
      params.push(req.user.id);
    }

    const [rows] = await pool.execute(
      `SELECT b.bill_id, b.bill_number, b.token_number, b.token_prefix,
              b.customer_name, b.customer_phone, b.delivery_address, b.order_type,
              b.grand_total, b.delivery_status, b.packing_status,
              b.cash_collected, b.upi_collected, b.delivered_at, b.created_at,
              b.assigned_delivery_boy,
              u.full_name AS cashier_name,
              du.full_name AS delivery_boy_name,
              au.full_name AS assigned_to_name
       FROM bills b
       LEFT JOIN users u  ON b.created_by = u.id
       LEFT JOIN users du ON b.delivered_by = du.id
       LEFT JOIN users au ON b.assigned_delivery_boy = au.id
       ${where}
       ORDER BY b.created_at DESC
       LIMIT 150`,
      params
    );
    res.json({ orders: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/delivery/orders/:billId — single order with items
router.get('/orders/:billId', requireDeliveryBoy, async (req, res) => {
  try {
    const [bills] = await pool.execute(
      `SELECT b.*, u.full_name AS cashier_name,
              du.full_name AS delivery_boy_name,
              au.full_name AS assigned_to_name
       FROM bills b
       LEFT JOIN users u  ON b.created_by = u.id
       LEFT JOIN users du ON b.delivered_by = du.id
       LEFT JOIN users au ON b.assigned_delivery_boy = au.id
       WHERE b.bill_id = ?`,
      [req.params.billId]
    );
    if (!bills.length) return res.status(404).json({ error: 'Order not found.' });
    const [items] = await pool.execute('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY id', [req.params.billId]);
    res.json({ bill: bills[0], items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/delivery/orders/:billId/pickup — delivery boy picks up
router.post('/orders/:billId/pickup', requireDeliveryBoy, async (req, res) => {
  try {
    const [result] = await pool.execute(
      `UPDATE bills SET delivery_status = 'picked_up', delivered_by = ?, packing_status = 'packed'
       WHERE bill_id = ? AND delivery_status IN ('pending','preparing','ready') AND (assigned_delivery_boy IS NULL OR assigned_delivery_boy = ?)`,
      [req.user.id, req.params.billId, req.user.id]
    );
    if (result.affectedRows === 0) {
      return res.status(400).json({ error: 'Cannot pick up. Order may be assigned to someone else.' });
    }
    res.json({ success: true, delivery_status: 'picked_up' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/delivery/orders/:billId/assign-self — delivery boy self assigns
router.post('/orders/:billId/assign-self', requireDeliveryBoy, async (req, res) => {
  try {
    const [result] = await pool.execute(
      `UPDATE bills SET assigned_delivery_boy = ?
       WHERE bill_id = ? AND (assigned_delivery_boy IS NULL OR assigned_delivery_boy = ?)`,
      [req.user.id, req.params.billId, req.user.id]
    );
    if (result.affectedRows === 0) {
      return res.status(400).json({ error: 'Order is already assigned to someone else.' });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/delivery/orders/:billId/deliver — mark delivered + record payment
router.post('/orders/:billId/deliver', requireDeliveryBoy, async (req, res) => {
  try {
    const { cash_collected, upi_collected } = req.body;
    const cash = parseFloat(cash_collected) || 0;
    const upi  = parseFloat(upi_collected)  || 0;
    const [result] = await pool.execute(
      `UPDATE bills SET delivery_status = 'delivered', delivered_by = ?,
       cash_collected = ?, upi_collected = ?, delivered_at = NOW()
       WHERE bill_id = ? AND delivery_status IN ('pending','preparing','ready','picked_up')`,
      [req.user.id, cash, upi, req.params.billId]
    );
    if (result.affectedRows === 0) {
      return res.status(400).json({ error: 'Cannot mark delivered at current status.' });
    }
    res.json({ success: true, delivery_status: 'delivered', cash_collected: cash, upi_collected: upi });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/delivery/orders/:billId/status — admin/staff update delivery status
router.patch('/orders/:billId/status', requireAdminOrStaff, async (req, res) => {
  try {
    const { delivery_status } = req.body;
    const valid = ['pending','preparing','ready','picked_up','delivered'];
    if (!valid.includes(delivery_status)) return res.status(400).json({ error: 'Invalid status.' });
    await pool.execute('UPDATE bills SET delivery_status = ? WHERE bill_id = ?', [delivery_status, req.params.billId]);
    res.json({ success: true, delivery_status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/delivery/orders/:billId/assign — assign delivery boy (admin/staff)
router.patch('/orders/:billId/assign', requireAdminOrStaff, async (req, res) => {
  try {
    const { delivery_boy_id } = req.body;
    // Verify the target user is a delivery boy
    if (delivery_boy_id) {
      const [u] = await pool.execute("SELECT id FROM users WHERE id = ? AND role = 'delivery_boy' AND status = 'active'", [delivery_boy_id]);
      if (!u.length) return res.status(400).json({ error: 'User is not an active delivery boy.' });
    }
    await pool.execute('UPDATE bills SET assigned_delivery_boy = ? WHERE bill_id = ?', [delivery_boy_id || null, req.params.billId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/delivery/boys — list active delivery boys (for assignment dropdown)
router.get('/boys', requireAdminOrStaff, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT id, full_name, phone FROM users WHERE role = 'delivery_boy' AND status = 'active' ORDER BY full_name"
    );
    res.json({ boys: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// KITCHEN / KOT ROUTES
// ─────────────────────────────────────────────

// GET /api/delivery/kitchen/orders — kitchen view: Delivery + Takeaway orders filtered by date
router.get('/kitchen/orders', requireKitchen, async (req, res) => {
  try {
    const todayStr = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
    const date  = req.query.date  || null;
    const from  = req.query.from  || null;
    const to    = req.query.to    || null;

    let dateClause, dateParams;
    if (from && to) {
      dateClause = `DATE(CONVERT_TZ(b.created_at, '+00:00', '+05:30')) BETWEEN ? AND ?`;
      dateParams = [from, to];
    } else if (from) {
      dateClause = `DATE(CONVERT_TZ(b.created_at, '+00:00', '+05:30')) BETWEEN ? AND ?`;
      dateParams = [from, todayStr];
    } else {
      dateClause = `DATE(CONVERT_TZ(b.created_at, '+00:00', '+05:30')) = ?`;
      dateParams = [date || todayStr];
    }

    const [rows] = await pool.execute(
      `SELECT b.bill_id, b.bill_number, b.token_number, b.token_prefix,
              b.customer_name, b.customer_phone, b.order_type, b.delivery_address,
              b.grand_total, b.packing_status, b.delivery_status, b.created_at,
              b.custom_note, u.full_name AS cashier_name
       FROM bills b
       LEFT JOIN users u ON b.created_by = u.id
       WHERE ${dateClause} AND b.status = 'completed'
         AND (b.order_type LIKE '%Delivery%' OR b.order_type LIKE '%Takeaway%')
       ORDER BY b.created_at ASC`,
      dateParams
    );
    res.json({ orders: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// GET /api/delivery/kitchen/orders/:billId — kitchen: get order with items
router.get('/kitchen/orders/:billId', requireKitchen, async (req, res) => {
  try {
    const [bills] = await pool.execute('SELECT * FROM bills WHERE bill_id = ?', [req.params.billId]);
    if (!bills.length) return res.status(404).json({ error: 'Order not found.' });
    const [items] = await pool.execute('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY id', [req.params.billId]);
    res.json({ bill: bills[0], items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/delivery/kitchen/orders/:billId/packing — update packing status
router.patch('/kitchen/orders/:billId/packing', requireKitchen, async (req, res) => {
  try {
    const { packing_status } = req.body;
    const valid = ['pending', 'packing', 'packed'];
    if (!valid.includes(packing_status)) return res.status(400).json({ error: 'Invalid packing status.' });

    // When packed, also mark delivery_status as 'ready' for delivery/takeaway orders
    const [bills] = await pool.execute('SELECT order_type, delivery_status FROM bills WHERE bill_id = ?', [req.params.billId]);
    const bill = bills[0];

    let updateSql = 'UPDATE bills SET packing_status = ? WHERE bill_id = ?';
    const updateParams = [packing_status, req.params.billId];

    if (packing_status === 'packed' && bill) {
      const ot = (bill.order_type || '').toLowerCase();
      if ((ot.includes('delivery') || ot.includes('takeaway')) && bill.delivery_status === 'pending') {
        updateSql = 'UPDATE bills SET packing_status = ?, delivery_status = ? WHERE bill_id = ?';
        updateParams.splice(1, 0, 'ready');
      }
    }
    // When REVERTED from packed → reset delivery_status back to 'pending'
    if ((packing_status === 'pending' || packing_status === 'packing') && bill) {
      const ot = (bill.order_type || '').toLowerCase();
      if ((ot.includes('delivery') || ot.includes('takeaway')) && bill.delivery_status === 'ready') {
        updateSql = 'UPDATE bills SET packing_status = ?, delivery_status = ? WHERE bill_id = ?';
        updateParams.splice(1, 0, 'pending');
      }
    }

    await pool.execute(updateSql, updateParams);
    res.json({ success: true, packing_status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// TEST PRINT ROUTE
// ─────────────────────────────────────────────
router.post('/test-print', requireAdminOrStaff, async (req, res) => {
  try {
    const { printer } = req.body; // 'customer' or 'kitchen'
    const [settingsRows] = await pool.execute('SELECT key_name, value FROM settings');
    const settings = {};
    settingsRows.forEach(r => { settings[r.key_name] = r.value; });

    const ip      = printer === 'kitchen' ? settings.kitchen_printer_ip      : settings.customer_printer_ip;
    const port    = printer === 'kitchen' ? settings.kitchen_printer_port     : settings.customer_printer_port;
    const usbName = printer === 'kitchen' ? settings.kitchen_usb_printer_name : settings.customer_usb_printer_name;

    const ESC = '\x1B', GS = '\x1D', LF = '\n';
    let t = ESC + '@';
    t += ESC + 'a\x01'; // center
    t += ESC + 'E\x01'; // bold on
    t += GS + '!\x11';  // double-height
    t += (settings.restaurant_name || 'Restaurant') + LF;
    t += GS + '!\x00';  // normal
    t += ESC + 'E\x00'; // bold off
    t += '--------------------------------\n';
    t += ESC + 'a\x01';
    t += 'TEST PRINT' + LF;
    t += (printer === 'kitchen' ? 'Kitchen Printer' : 'Customer Printer') + LF;
    t += new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + LF;
    t += '--------------------------------\n';
    t += 'If you see this, printer is' + LF;
    t += 'working correctly! ✓' + LF;
    t += LF + LF + LF;
    t += GS + 'V\x41\x03'; // cut

    const data = Buffer.from(t, 'latin1');
    const b64  = data.toString('base64');

    res.json({ success: true, data_b64: b64, printer_ip: ip || null, printer_port: port || '9100', printer_usb: usbName || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
