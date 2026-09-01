const express = require('express');
const router = express.Router();
const { pool } = require('../db/connection');
const { authenticateToken, requireAdminOrStaff } = require('../middleware/auth');

router.use(authenticateToken);

// ── Recent customers (last 10 distinct) ──
router.get('/recent-customers', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT customer_phone, customer_name, MAX(created_at) AS last_visit,
              COUNT(*) AS visit_count, COALESCE(SUM(grand_total),0) AS total_spent
       FROM bills
       WHERE customer_phone IS NOT NULL AND status='completed'
       GROUP BY customer_phone, customer_name
       ORDER BY last_visit DESC
       LIMIT 10`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Phone number suggestions (partial search) ──
router.get('/phone-suggest', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    // Normalize: strip spaces for phone matching, keep original for name
    const qNorm = q.replace(/\s+/g, '');
    const [rows] = await pool.execute(
      `SELECT DISTINCT customer_phone, customer_name
       FROM bills
       WHERE (REPLACE(customer_phone,' ','') LIKE ? OR LOWER(REPLACE(customer_name,' ','')) LIKE LOWER(?)) 
         AND customer_phone IS NOT NULL AND status='completed'
       GROUP BY customer_phone, customer_name
       ORDER BY MAX(created_at) DESC
       LIMIT 10`,
      [`%${qNorm}%`, `%${qNorm}%`]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Customer lookup by phone (must come BEFORE /:billId) ──
router.get('/customer/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const [nameResult] = await pool.execute(
      "SELECT customer_name FROM bills WHERE customer_phone=? AND customer_name IS NOT NULL AND status='completed' ORDER BY created_at DESC LIMIT 1",
      [phone]
    );
    const customer_name = nameResult.length ? nameResult[0].customer_name : null;

    const [orders] = await pool.execute(
      `SELECT b.bill_id, b.bill_number, b.token_number, b.created_at,
              b.grand_total, b.order_type, b.subtotal, b.discount_amount
       FROM bills b WHERE b.customer_phone=? AND b.status='completed'
       ORDER BY b.created_at DESC LIMIT 20`,
      [phone]
    );

    // Total spent + visit count
    const [totals] = await pool.execute(
      "SELECT COALESCE(SUM(grand_total),0) AS total_spent, COUNT(*) AS visit_count FROM bills WHERE customer_phone=? AND status='completed'",
      [phone]
    );

    // Per-item aggregates: what this customer orders and how much
    const [itemHistory] = await pool.execute(
      `SELECT bi.item_name,
              SUM(bi.quantity)  AS total_qty,
              SUM(bi.line_total) AS total_spent,
              COUNT(DISTINCT bi.bill_id) AS order_count
       FROM bill_items bi
       JOIN bills b ON bi.bill_id = b.bill_id
       WHERE b.customer_phone=? AND b.status='completed'
       GROUP BY bi.item_name
       ORDER BY total_qty DESC`,
      [phone]
    );

    res.json({
      customer_name,
      total_spent:  parseFloat(totals[0].total_spent),
      visit_count:  parseInt(totals[0].visit_count),
      history:      orders,
      item_history: itemHistory
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Customer lookup by name ──
router.get('/customer-by-name/:name', async (req, res) => {
  try {
    const nameQuery = req.params.name;
    // Normalize query: remove extra spaces, lowercase for matching
    const normQuery = nameQuery.replace(/\s+/g, '').toLowerCase();

    // Find distinct customers matching this name pattern
    const [distinctCustomers] = await pool.execute(
      `SELECT customer_phone, customer_name, MAX(created_at) AS last_visit,
              COUNT(*) AS visit_count, COALESCE(SUM(grand_total),0) AS total_spent
       FROM bills
       WHERE REPLACE(LOWER(customer_name),' ','') LIKE ? AND status='completed'
         AND customer_phone IS NOT NULL
       GROUP BY customer_phone, customer_name
       ORDER BY last_visit DESC
       LIMIT 20`,
      [`%${normQuery}%`]
    );

    // If multiple distinct phone numbers found, return them for disambiguation
    const distinctPhones = [...new Set(distinctCustomers.map(r => r.customer_phone))];
    if (distinctPhones.length > 1) {
      return res.json({ multiple_customers: distinctCustomers.map(r => ({
        customer_phone: r.customer_phone,
        customer_name:  r.customer_name,
        visit_count:    parseInt(r.visit_count),
        total_spent:    parseFloat(r.total_spent),
        last_visit:     r.last_visit
      }))});
    }

    // Single customer — proceed as before
    const customer_phone = distinctCustomers.length ? distinctCustomers[0].customer_phone : null;
    const full_customer_name = distinctCustomers.length ? distinctCustomers[0].customer_name : nameQuery;

    const [orders] = await pool.execute(
      `SELECT b.bill_id, b.bill_number, b.token_number, b.created_at,
              b.grand_total, b.order_type, b.subtotal, b.discount_amount
       FROM bills b WHERE REPLACE(LOWER(b.customer_name),' ','') LIKE LOWER(?) AND b.status='completed'
       ORDER BY b.created_at DESC LIMIT 20`,
      [`%${normQuery}%`]
    );

    const [totals] = await pool.execute(
      "SELECT COALESCE(SUM(grand_total),0) AS total_spent, COUNT(*) AS visit_count FROM bills WHERE REPLACE(LOWER(customer_name),' ','') LIKE LOWER(?) AND status='completed'",
      [`%${normQuery}%`]
    );

    const [itemHistory] = await pool.execute(
      `SELECT bi.item_name,
              SUM(bi.quantity)  AS total_qty,
              SUM(bi.line_total) AS total_spent,
              COUNT(DISTINCT bi.bill_id) AS order_count
       FROM bill_items bi
       JOIN bills b ON bi.bill_id = b.bill_id
       WHERE REPLACE(LOWER(b.customer_name),' ','') LIKE LOWER(?) AND b.status='completed'
       GROUP BY bi.item_name
       ORDER BY total_qty DESC`,
      [`%${normQuery}%`]
    );

    res.json({
      customer_name: full_customer_name,
      customer_phone,
      total_spent:  parseFloat(totals[0].total_spent),
      visit_count:  parseInt(totals[0].visit_count),
      history:      orders,
      item_history: itemHistory
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET list of bills with filters + ordering ──
// ── GET list of bills with filters + ordering ──
router.get('/', async (req, res) => {
  try {
    const page           = parseInt(req.query.page) || 1;
    const limit          = parseInt(req.query.limit) || 20;
    const offset         = (page - 1) * limit;
    const search         = req.query.search || '';
    const startDate      = req.query.startDate || '';
    const endDate        = req.query.endDate || '';
    const status         = req.query.status || 'completed';
    const tokenPrefix    = req.query.token_prefix || '';
    const paymentStatus  = req.query.payment_status || '';

    let where = 'WHERE b.status = ?';
    const params = [status];

    if (search) {
      where += ' AND (b.bill_number LIKE ? OR b.customer_phone LIKE ? OR b.customer_name LIKE ? OR CAST(b.token_number AS CHAR) LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (startDate && endDate) {
      where += ' AND DATE(b.created_at) >= ? AND DATE(b.created_at) <= ?';
      params.push(startDate, endDate);
    } else if (startDate) {
      where += ' AND DATE(b.created_at) >= ?';
      params.push(startDate);
    } else if (endDate) {
      where += ' AND DATE(b.created_at) <= ?';
      params.push(endDate);
    }
    if (tokenPrefix) {
      if (tokenPrefix === 'Delivery') {
        where += " AND b.token_prefix IN ('DM', 'DE')";
      } else if (tokenPrefix === 'Takeaway') {
        where += " AND b.token_prefix IN ('TM', 'TE')";
      } else {
        where += ' AND b.token_prefix = ?';
        params.push(tokenPrefix);
      }
    }

    if (paymentStatus === 'paid') {
      where += ' AND (COALESCE(b.cash_collected,0) + COALESCE(b.upi_collected,0)) >= b.grand_total';
    } else if (paymentStatus === 'unpaid') {
      where += ' AND (COALESCE(b.cash_collected,0) + COALESCE(b.upi_collected,0)) = 0';
    } else if (paymentStatus === 'partial') {
      where += ' AND (COALESCE(b.cash_collected,0) + COALESCE(b.upi_collected,0)) > 0 AND (COALESCE(b.cash_collected,0) + COALESCE(b.upi_collected,0)) < b.grand_total';
    } else if (paymentStatus === 'overpaid') {
      where += ' AND (COALESCE(b.cash_collected,0) + COALESCE(b.upi_collected,0)) > (b.grand_total + 0.005)';
    } else if (paymentStatus === 'change_unsettled') {
      where += ' AND (COALESCE(b.cash_collected,0) + COALESCE(b.upi_collected,0)) > (b.grand_total + 0.005) AND COALESCE(b.change_settled, 0) = 0';
    } else if (paymentStatus === 'change_settled') {
      where += ' AND (COALESCE(b.cash_collected,0) + COALESCE(b.upi_collected,0)) > (b.grand_total + 0.005) AND COALESCE(b.change_settled, 0) = 1';
    }

    const countSql = `SELECT COUNT(*) AS total FROM bills b ${where}`;
    const [countResult] = await pool.execute(countSql, params);

    const listSql = `
      SELECT b.bill_id, b.bill_number, b.token_number, b.token_prefix,
             b.customer_name, b.customer_phone, b.order_type, b.status,
             b.grand_total, b.created_at, u.full_name AS cashier_name,
             b.delivery_status, b.packing_status, b.cash_collected, b.upi_collected,
             b.delivered_at, b.assigned_delivery_boy, b.change_settled
      FROM bills b
      LEFT JOIN users u ON b.created_by = u.id
      ${where}
      ORDER BY b.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const [bills] = await pool.execute(listSql, params);

    res.json({
      bills,
      pagination: { page, limit, total: countResult[0].total, pages: Math.ceil(countResult[0].total / limit) }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET single bill with items ──
router.get('/:billId', async (req, res) => {
  try {
    const [bills] = await pool.execute(
      `SELECT b.*, u.full_name AS cashier_name, du.full_name AS delivery_boy_name
       FROM bills b
       LEFT JOIN users u ON b.created_by = u.id
       LEFT JOIN users du ON b.delivered_by = du.id
       WHERE b.bill_id = ?`,
      [req.params.billId]
    );
    if (!bills.length) return res.status(404).json({ error: 'Bill not found.' });
    const [items] = await pool.execute('SELECT * FROM bill_items WHERE bill_id=? ORDER BY id', [req.params.billId]);
    res.json({ bill: bills[0], items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST mark as paid ──
router.post('/:billId/mark-paid', async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'staff') {
      return res.status(403).json({ error: 'Access denied. Only admin or staff can update payment status.' });
    }
    const { payment_method, grand_total } = req.body;
    let cash = 0, upi = 0;
    if (payment_method === 'cash') cash = grand_total;
    if (payment_method === 'upi') upi = grand_total;
    
    const [result] = await pool.execute(
      "UPDATE bills SET cash_collected=?, upi_collected=? WHERE bill_id=?",
      [cash, upi, req.params.billId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Bill not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST mark all unpaid dine-in orders as paid ──
router.post('/mark-all-dinein-paid', async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'staff') {
      return res.status(403).json({ error: 'Access denied.' });
    }
    
    // Find unpaid dine-in orders and update their cash_collected to match grand_total
    const [result] = await pool.execute(
      `UPDATE bills 
       SET cash_collected = grand_total 
       WHERE status = 'completed' 
       AND LOWER(order_type) LIKE '%dine%in%' 
       AND (COALESCE(cash_collected, 0) + COALESCE(upi_collected, 0)) = 0`
    );
    
    res.json({ success: true, updatedCount: result.affectedRows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST mark/toggle change settled status ──
router.post('/:billId/settle-change', async (req, res) => {
  try {
    // Only admin or staff can settle extra change
    if (req.user.role !== 'admin' && req.user.role !== 'staff') {
      return res.status(403).json({ error: 'Access denied. Only admin or staff can settle extra change.' });
    }

    const { settled } = req.body;
    let newSettled = 1;
    if (settled !== undefined) {
      newSettled = settled ? 1 : 0;
    } else {
      // Toggle if not specified
      const [current] = await pool.execute('SELECT change_settled FROM bills WHERE bill_id=?', [req.params.billId]);
      if (!current.length) return res.status(404).json({ error: 'Bill not found' });
      newSettled = current[0].change_settled ? 0 : 1;
    }

    const [result] = await pool.execute(
      "UPDATE bills SET change_settled=? WHERE bill_id=?", [newSettled, req.params.billId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Bill not found' });
    res.json({ success: true, change_settled: newSettled });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST cancel a bill ──
router.post('/:billId/cancel', requireAdminOrStaff, async (req, res) => {
  try {
    const [result] = await pool.execute(
      "UPDATE bills SET status='cancelled' WHERE bill_id=?", [req.params.billId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Bill not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
