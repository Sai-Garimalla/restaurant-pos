const express = require('express');
const router = express.Router();
const { pool } = require('../db/connection');
const { authenticateToken } = require('../middleware/auth');
const XLSX = require('xlsx');

router.use(authenticateToken);

// ── Helper: column widths ──
function colWidths(cols) {
  return cols.map(w => ({ wch: w }));
}

// ─────────────────────────────────────────────────────────────
// GET /api/export/schemas  — list all exportable schemas (admin only)
// ─────────────────────────────────────────────────────────────
router.get('/schemas', async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'staff') {
    return res.status(403).json({ error: 'Admin/Staff access only' });
  }
  res.json({
    schemas: [
      {
        id: 'orders_summary',
        name: 'Orders Summary',
        icon: '🧾',
        description: 'All bills with token, customer, order type, payment status, cashier, delivery info.',
        columns: ['Token','Bill No','Customer','Phone','Order Type','Address','Status','Subtotal','Delivery','Discount','Grand Total','Cash','UPI','Total Collected','Balance','Payment Status','Change Settled','Cashier','Delivered By','Order Time','Delivered At'],
        requiresDate: true,
      },
      {
        id: 'order_items',
        name: 'Order Items Detail',
        icon: '📋',
        description: 'Line-by-line breakdown of every item ordered, with quantity, price, and notes.',
        columns: ['Token','Bill No','Customer','Order Type','Item Code','Item Name','Qty','Unit Price','Line Total','Note','Order Time'],
        requiresDate: true,
      },
      {
        id: 'item_sales',
        name: 'Item-wise Sales',
        icon: '📊',
        description: 'Aggregated sales per menu item: total quantity sold, revenue, average price.',
        columns: ['Item Code','Item Name','Category','Total Qty Sold','Total Revenue','Avg Price','Order Count'],
        requiresDate: true,
      },
      {
        id: 'payment_summary',
        name: 'Payment Summary',
        icon: '💰',
        description: 'Revenue totals: cash/UPI collected, pending balance, unsettled change.',
        columns: ['Metric','Value'],
        requiresDate: true,
      },
      {
        id: 'delivery_performance',
        name: 'Delivery Performance',
        icon: '🛵',
        description: 'Per-delivery-boy stats: orders delivered, cash/UPI collected, shortfall.',
        columns: ['Driver','Orders Delivered','Cash Collected','UPI Collected','Total Collected','Total Billed','Change Given','Shortfall'],
        requiresDate: true,
      },
      {
        id: 'users',
        name: 'Users / Staff',
        icon: '👥',
        description: 'All staff accounts (no passwords) — name, username, role, status, join date.',
        columns: ['ID','Full Name','Username','Email','Phone','Role','Status','Created At'],
        requiresDate: false,
        adminOnly: true,
      },
      {
        id: 'menu',
        name: 'Menu Items',
        icon: '🍽️',
        description: 'Complete menu catalogue with categories, prices, and availability.',
        columns: ['All menu columns'],
        requiresDate: false,
      },
      {
        id: 'bills_raw',
        name: 'Bills (Raw Table)',
        icon: '🗄️',
        description: 'Raw bills table export — all columns, no date filter, full history.',
        columns: ['All bill columns'],
        requiresDate: false,
        adminOnly: true,
      },
      {
        id: 'bill_items_raw',
        name: 'Bill Items (Raw Table)',
        icon: '📦',
        description: 'Raw bill_items table — every item row ever ordered.',
        columns: ['All bill_items columns'],
        requiresDate: false,
        adminOnly: true,
      },
      {
        id: 'settings',
        name: 'Settings',
        icon: '⚙️',
        description: 'Restaurant settings key-value store.',
        columns: ['All settings columns'],
        requiresDate: false,
        adminOnly: true,
      },
      {
        id: 'token_counter',
        name: 'Token Counter',
        icon: '🎫',
        description: 'Token number counters per prefix.',
        columns: ['All token_counter columns'],
        requiresDate: false,
        adminOnly: true,
      },
    ]
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/export/selective  — export selected schemas
// Body: { sheets: ['orders_summary','payment_summary',...], date: 'YYYY-MM-DD' }
// ─────────────────────────────────────────────────────────────
router.post('/selective', async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'staff') {
      return res.status(403).json({ error: 'Admin/Staff access only' });
    }

    const isAdmin = req.user.role === 'admin';
    const { sheets, date } = req.body;
    if (!sheets || !sheets.length) {
      return res.status(400).json({ error: 'No sheets selected.' });
    }

    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    const defaultDate = istNow.toISOString().split('T')[0];
    const exportDate = date || defaultDate;

    const wb = XLSX.utils.book_new();

    // Admin-only schemas check
    const adminOnlySchemas = ['users','bills_raw','bill_items_raw','settings','token_counter'];

    for (const sheetId of sheets) {
      if (adminOnlySchemas.includes(sheetId) && !isAdmin) continue;

      switch (sheetId) {

        case 'orders_summary': {
          const [bills] = await pool.execute(`
            SELECT
              CONCAT(CASE WHEN b.token_prefix='T' THEN 'DIN' ELSE IFNULL(b.token_prefix,'DIN') END,
                     LPAD(b.token_number,3,'0'))                          AS token,
              b.bill_number,
              IFNULL(b.customer_name,'Walk-in')                           AS customer_name,
              IFNULL(b.customer_phone,'—')                                AS customer_phone,
              IFNULL(b.order_type,'Dine-in')                              AS order_type,
              IFNULL(b.delivery_address,'—')                              AS delivery_address,
              b.status,
              b.subtotal,
              COALESCE(b.delivery_charge,0)                               AS delivery_charge,
              COALESCE(b.discount_amount,0)                               AS discount,
              b.grand_total,
              COALESCE(b.cash_collected,0)                                AS cash_collected,
              COALESCE(b.upi_collected,0)                                 AS upi_collected,
              ROUND(COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0),2) AS total_collected,
              ROUND(b.grand_total - (COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0)),2) AS balance,
              CASE
                WHEN b.status='cancelled' THEN 'Cancelled'
                WHEN (COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0)) <= 0 THEN 'Unpaid'
                WHEN (COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0)) > (b.grand_total+0.005)
                  THEN CONCAT('Overpaid +₹', ROUND((COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0))-b.grand_total,2))
                WHEN (COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0)) >= (b.grand_total-0.005) THEN 'Paid'
                ELSE CONCAT('Partial -₹', ROUND(b.grand_total-(COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0)),2))
              END                                                         AS payment_status,
              CASE WHEN b.change_settled=1 THEN 'Yes' ELSE 'No' END      AS change_settled,
              IFNULL(u.full_name,'—')                                     AS cashier,
              IFNULL(du.full_name,'—')                                    AS delivered_by,
              DATE_FORMAT(CONVERT_TZ(b.created_at,'+00:00','+05:30'),'%Y-%m-%d %H:%i:%s') AS created_at_ist,
              DATE_FORMAT(CONVERT_TZ(b.delivered_at,'+00:00','+05:30'),'%Y-%m-%d %H:%i:%s') AS delivered_at_ist
            FROM bills b
            LEFT JOIN users u  ON b.created_by   = u.id
            LEFT JOIN users du ON b.delivered_by  = du.id
            WHERE DATE(CONVERT_TZ(b.created_at,'+00:00','+05:30')) = ?
            ORDER BY b.created_at ASC
          `, [exportDate]);
          const hdr = ['Token','Bill No','Customer','Phone','Order Type','Address','Status','Subtotal (₹)','Delivery (₹)','Discount (₹)','Grand Total (₹)','Cash (₹)','UPI (₹)','Total Collected (₹)','Balance (₹)','Payment Status','Change Settled','Cashier','Delivered By','Order Time (IST)','Delivered At (IST)'];
          const rows = bills.map(b => [b.token,b.bill_number,b.customer_name,b.customer_phone,b.order_type,b.delivery_address,b.status,+b.subtotal,+b.delivery_charge,+b.discount,+b.grand_total,+b.cash_collected,+b.upi_collected,+b.total_collected,+b.balance,b.payment_status,b.change_settled,b.cashier,b.delivered_by,b.created_at_ist,b.delivered_at_ist]);
          const ws = XLSX.utils.aoa_to_sheet([hdr, ...rows]);
          ws['!cols'] = colWidths([8,16,18,14,16,24,12,10,10,10,12,10,10,12,10,22,12,16,16,22,22]);
          XLSX.utils.book_append_sheet(wb, ws, 'Orders Summary');
          break;
        }

        case 'order_items': {
          const [items] = await pool.execute(`
            SELECT
              CONCAT(CASE WHEN b.token_prefix='T' THEN 'DIN' ELSE IFNULL(b.token_prefix,'DIN') END,
                     LPAD(b.token_number,3,'0'))                          AS token,
              b.bill_number,
              IFNULL(b.customer_name,'Walk-in')                           AS customer_name,
              IFNULL(b.order_type,'Dine-in')                              AS order_type,
              bi.item_code, bi.item_name, bi.quantity, bi.unit_price, bi.line_total,
              IFNULL(bi.item_note,'—')                                    AS item_note,
              DATE_FORMAT(CONVERT_TZ(b.created_at,'+00:00','+05:30'),'%Y-%m-%d %H:%i:%s') AS order_time_ist
            FROM bill_items bi
            JOIN bills b ON bi.bill_id = b.bill_id
            WHERE DATE(CONVERT_TZ(b.created_at,'+00:00','+05:30')) = ? AND b.status = 'completed'
            ORDER BY b.created_at ASC, bi.id ASC
          `, [exportDate]);
          const hdr = ['Token','Bill No','Customer','Order Type','Item Code','Item Name','Qty','Unit Price (₹)','Line Total (₹)','Note','Order Time (IST)'];
          const rows = items.map(i => [i.token,i.bill_number,i.customer_name,i.order_type,i.item_code||'—',i.item_name,i.quantity,+i.unit_price,+i.line_total,i.item_note,i.order_time_ist]);
          const ws = XLSX.utils.aoa_to_sheet([hdr, ...rows]);
          ws['!cols'] = colWidths([8,16,18,16,12,28,6,12,12,20,22]);
          XLSX.utils.book_append_sheet(wb, ws, 'Order Items Detail');
          break;
        }

        case 'item_sales': {
          const [itemSales] = await pool.execute(`
            SELECT bi.item_code, bi.item_name, COALESCE(mi.category,'—') AS category,
              SUM(bi.quantity) AS total_qty, ROUND(SUM(bi.line_total),2) AS total_revenue,
              ROUND(AVG(bi.unit_price),2) AS avg_price, COUNT(DISTINCT b.bill_id) AS order_count
            FROM bill_items bi
            JOIN bills b      ON bi.bill_id = b.bill_id
            LEFT JOIN menu mi ON bi.item_code = mi.item_code
            WHERE DATE(CONVERT_TZ(b.created_at,'+00:00','+05:30')) = ? AND b.status = 'completed'
            GROUP BY bi.item_code, bi.item_name, mi.category
            ORDER BY total_revenue DESC
          `, [exportDate]);
          const hdr = ['Item Code','Item Name','Category','Total Qty Sold','Total Revenue (₹)','Avg Price (₹)','Orders Count'];
          const rows = itemSales.map(i => [i.item_code||'—',i.item_name,i.category,+i.total_qty,+i.total_revenue,+i.avg_price,+i.order_count]);
          const ws = XLSX.utils.aoa_to_sheet([hdr, ...rows]);
          ws['!cols'] = colWidths([12,30,16,12,16,12,12]);
          XLSX.utils.book_append_sheet(wb, ws, 'Item-wise Sales');
          break;
        }

        case 'payment_summary': {
          const [pSummary] = await pool.execute(`
            SELECT
              COUNT(CASE WHEN status='completed' THEN 1 END)   AS completed_orders,
              COUNT(CASE WHEN status='cancelled' THEN 1 END)   AS cancelled_orders,
              ROUND(SUM(CASE WHEN status='completed' THEN grand_total ELSE 0 END),2) AS gross_revenue,
              ROUND(SUM(CASE WHEN status='completed' THEN COALESCE(cash_collected,0) ELSE 0 END),2) AS total_cash,
              ROUND(SUM(CASE WHEN status='completed' THEN COALESCE(upi_collected,0) ELSE 0 END),2)  AS total_upi,
              ROUND(SUM(CASE WHEN status='completed' THEN COALESCE(cash_collected,0)+COALESCE(upi_collected,0) ELSE 0 END),2) AS total_collected,
              ROUND(SUM(CASE WHEN status='completed'
                AND (COALESCE(cash_collected,0)+COALESCE(upi_collected,0)) < (grand_total-0.005)
                THEN grand_total-(COALESCE(cash_collected,0)+COALESCE(upi_collected,0)) ELSE 0 END),2) AS total_pending,
              ROUND(SUM(CASE WHEN status='completed'
                AND (COALESCE(cash_collected,0)+COALESCE(upi_collected,0)) > (grand_total+0.005)
                AND COALESCE(change_settled,0)=0
                THEN (COALESCE(cash_collected,0)+COALESCE(upi_collected,0))-grand_total ELSE 0 END),2) AS change_unsettled,
              ROUND(SUM(CASE WHEN status='completed'
                AND (COALESCE(cash_collected,0)+COALESCE(upi_collected,0)) > (grand_total+0.005)
                AND COALESCE(change_settled,0)=1
                THEN (COALESCE(cash_collected,0)+COALESCE(upi_collected,0))-grand_total ELSE 0 END),2) AS change_settled_total,
              ROUND(SUM(CASE WHEN status='cancelled' THEN grand_total ELSE 0 END),2) AS cancelled_value
            FROM bills WHERE DATE(CONVERT_TZ(created_at,'+00:00','+05:30')) = ?
          `, [exportDate]);
          const ps = pSummary[0];
          const rows = [['Metric','Value'],['Date',exportDate],['Completed Orders',+ps.completed_orders],['Cancelled Orders',+ps.cancelled_orders],['Gross Revenue (₹)',+ps.gross_revenue],['Total Cash Collected (₹)',+ps.total_cash],['Total UPI Collected (₹)',+ps.total_upi],['Total Collected (₹)',+ps.total_collected],['Pending / Unpaid Balance (₹)',+ps.total_pending],['Unsettled Change Due (₹)',+ps.change_unsettled],['Settled Change Total (₹)',+ps.change_settled_total],['Cancelled Orders Value (₹)',+ps.cancelled_value]];
          const ws = XLSX.utils.aoa_to_sheet(rows);
          ws['!cols'] = colWidths([32,18]);
          XLSX.utils.book_append_sheet(wb, ws, 'Payment Summary');
          break;
        }

        case 'delivery_performance': {
          const [drivers] = await pool.execute(`
            SELECT u.full_name AS driver_name,
              COUNT(b.bill_id) AS orders_delivered,
              ROUND(SUM(COALESCE(b.cash_collected,0)),2) AS cash_collected,
              ROUND(SUM(COALESCE(b.upi_collected,0)),2)  AS upi_collected,
              ROUND(SUM(COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0)),2) AS total_collected,
              ROUND(SUM(b.grand_total),2) AS total_billed,
              ROUND(SUM(CASE WHEN (COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0)) > (b.grand_total+0.005)
                THEN (COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0))-b.grand_total ELSE 0 END),2) AS change_given,
              ROUND(SUM(CASE WHEN (COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0)) < (b.grand_total-0.005)
                THEN b.grand_total-(COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0)) ELSE 0 END),2) AS shortfall
            FROM bills b
            JOIN users u ON b.delivered_by = u.id
            WHERE DATE(CONVERT_TZ(b.created_at,'+00:00','+05:30')) = ?
              AND b.status = 'completed' AND b.delivery_status = 'delivered'
            GROUP BY b.delivered_by, u.full_name
            ORDER BY total_collected DESC
          `, [exportDate]);
          const hdr = ['Driver Name','Orders Delivered','Cash Collected (₹)','UPI Collected (₹)','Total Collected (₹)','Total Billed (₹)','Change Given Out (₹)','Shortfall (₹)'];
          const rows = drivers.length
            ? drivers.map(d => [d.driver_name,+d.orders_delivered,+d.cash_collected,+d.upi_collected,+d.total_collected,+d.total_billed,+d.change_given,+d.shortfall])
            : [['No delivery data for this date']];
          const ws = XLSX.utils.aoa_to_sheet([hdr, ...rows]);
          ws['!cols'] = colWidths([20,14,16,16,18,16,18,14]);
          XLSX.utils.book_append_sheet(wb, ws, 'Delivery Performance');
          break;
        }

        case 'users': {
          if (!isAdmin) break;
          const [rows] = await pool.execute('SELECT id,full_name,username,email,phone,role,status,created_at FROM users ORDER BY id');
          const headers = ['ID','Full Name','Username','Email','Phone','Role','Status','Created At'];
          const data = rows.map(r => [r.id,r.full_name,r.username,r.email||'',r.phone||'',r.role,r.status,r.created_at instanceof Date ? r.created_at.toISOString().replace('T',' ').slice(0,19) : r.created_at]);
          const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
          ws['!cols'] = colWidths([6,20,16,24,14,12,10,22]);
          XLSX.utils.book_append_sheet(wb, ws, 'Users');
          break;
        }

        case 'menu': {
          const [rows] = await pool.execute('SELECT * FROM menu ORDER BY category, item_name');
          if (!rows.length) { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['No data']]), 'Menu'); break; }
          const headers = Object.keys(rows[0]);
          const data = rows.map(r => headers.map(h => { const v = r[h]; return v instanceof Date ? v.toISOString().replace('T',' ').slice(0,19) : (v ?? ''); }));
          const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
          ws['!cols'] = headers.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(wb, ws, 'Menu');
          break;
        }

        case 'bills_raw': {
          if (!isAdmin) break;
          const [rows] = await pool.execute(`SELECT bill_id,bill_number,token_prefix,token_number,customer_name,customer_phone,order_type,delivery_address,status,subtotal,delivery_charge,discount_amount,grand_total,cash_collected,upi_collected,change_settled,delivery_status,packing_status,created_by,assigned_delivery_boy,delivered_by,created_at,delivered_at FROM bills ORDER BY bill_id`);
          if (!rows.length) { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['No data']]), 'Bills'); break; }
          const headers = Object.keys(rows[0]);
          const data = rows.map(r => headers.map(h => { const v = r[h]; return v instanceof Date ? v.toISOString().replace('T',' ').slice(0,19) : (v ?? ''); }));
          const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
          ws['!cols'] = headers.map(() => ({ wch: 16 }));
          XLSX.utils.book_append_sheet(wb, ws, 'Bills Raw');
          break;
        }

        case 'bill_items_raw': {
          if (!isAdmin) break;
          const [rows] = await pool.execute('SELECT * FROM bill_items ORDER BY bill_id, id');
          if (!rows.length) { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['No data']]), 'Bill Items'); break; }
          const headers = Object.keys(rows[0]);
          const data = rows.map(r => headers.map(h => { const v = r[h]; return v instanceof Date ? v.toISOString().replace('T',' ').slice(0,19) : (v ?? ''); }));
          const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
          ws['!cols'] = headers.map(() => ({ wch: 18 }));
          XLSX.utils.book_append_sheet(wb, ws, 'Bill Items Raw');
          break;
        }

        case 'settings': {
          if (!isAdmin) break;
          const [rows] = await pool.execute('SELECT * FROM settings ORDER BY key_name');
          if (!rows.length) { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['No data']]), 'Settings'); break; }
          const headers = Object.keys(rows[0]);
          const data = rows.map(r => headers.map(h => r[h] ?? ''));
          const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
          XLSX.utils.book_append_sheet(wb, ws, 'Settings');
          break;
        }

        case 'token_counter': {
          if (!isAdmin) break;
          const [rows] = await pool.execute('SELECT * FROM token_counter ORDER BY id');
          if (!rows.length) { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['No data']]), 'Token Counter'); break; }
          const headers = Object.keys(rows[0]);
          const data = rows.map(r => headers.map(h => r[h] ?? ''));
          const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
          XLSX.utils.book_append_sheet(wb, ws, 'Token Counter');
          break;
        }
      }
    }

    if (wb.SheetNames.length === 0) {
      return res.status(400).json({ error: 'No valid sheets selected or insufficient permissions.' });
    }

    const ist = new Date(now.getTime() + istOffset);
    const ts = ist.toISOString().replace('T','_').slice(0,16).replace(':','-');
    const filename = `POS_Export_${ts}.xlsx`;
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);

  } catch (err) {
    console.error('Selective export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/export/daily?date=YYYY-MM-DD  — legacy full daily export
// ─────────────────────────────────────────────────────────────
router.get('/daily', async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'staff') {
      return res.status(403).json({ error: 'Admin/Staff access only' });
    }
    // Forward to selective with all date-based sheets
    req.body = { sheets: ['orders_summary','order_items','item_sales','payment_summary','delivery_performance'], date: req.query.date };
    // Re-use selective logic inline
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    const exportDate = req.query.date || istNow.toISOString().split('T')[0];

    const wb = XLSX.utils.book_new();
    const sheets = ['orders_summary','order_items','item_sales','payment_summary','delivery_performance'];

    for (const sheetId of sheets) {
      if (sheetId === 'orders_summary') {
        const [bills] = await pool.execute(`
          SELECT CONCAT(CASE WHEN b.token_prefix='T' THEN 'DIN' ELSE IFNULL(b.token_prefix,'DIN') END, LPAD(b.token_number,3,'0')) AS token,
            b.bill_number, IFNULL(b.customer_name,'Walk-in') AS customer_name, IFNULL(b.customer_phone,'—') AS customer_phone,
            IFNULL(b.order_type,'Dine-in') AS order_type, IFNULL(b.delivery_address,'—') AS delivery_address, b.status,
            b.subtotal, COALESCE(b.delivery_charge,0) AS delivery_charge, COALESCE(b.discount_amount,0) AS discount, b.grand_total,
            COALESCE(b.cash_collected,0) AS cash_collected, COALESCE(b.upi_collected,0) AS upi_collected,
            ROUND(COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0),2) AS total_collected,
            ROUND(b.grand_total-(COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0)),2) AS balance,
            CASE WHEN b.status='cancelled' THEN 'Cancelled'
              WHEN (COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0))<=0 THEN 'Unpaid'
              WHEN (COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0))>=(b.grand_total-0.005) THEN 'Paid'
              ELSE CONCAT('Partial -₹',ROUND(b.grand_total-(COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0)),2))
            END AS payment_status,
            CASE WHEN b.change_settled=1 THEN 'Yes' ELSE 'No' END AS change_settled,
            IFNULL(u.full_name,'—') AS cashier, IFNULL(du.full_name,'—') AS delivered_by,
            DATE_FORMAT(CONVERT_TZ(b.created_at,'+00:00','+05:30'),'%Y-%m-%d %H:%i:%s') AS created_at_ist,
            DATE_FORMAT(CONVERT_TZ(b.delivered_at,'+00:00','+05:30'),'%Y-%m-%d %H:%i:%s') AS delivered_at_ist
          FROM bills b LEFT JOIN users u ON b.created_by=u.id LEFT JOIN users du ON b.delivered_by=du.id
          WHERE DATE(CONVERT_TZ(b.created_at,'+00:00','+05:30'))=? ORDER BY b.created_at ASC
        `, [exportDate]);
        const hdr = ['Token','Bill No','Customer','Phone','Order Type','Address','Status','Subtotal (₹)','Delivery (₹)','Discount (₹)','Grand Total (₹)','Cash (₹)','UPI (₹)','Total Collected (₹)','Balance (₹)','Payment Status','Change Settled','Cashier','Delivered By','Order Time (IST)','Delivered At (IST)'];
        const rows = bills.map(b => [b.token,b.bill_number,b.customer_name,b.customer_phone,b.order_type,b.delivery_address,b.status,+b.subtotal,+b.delivery_charge,+b.discount,+b.grand_total,+b.cash_collected,+b.upi_collected,+b.total_collected,+b.balance,b.payment_status,b.change_settled,b.cashier,b.delivered_by,b.created_at_ist,b.delivered_at_ist]);
        const ws = XLSX.utils.aoa_to_sheet([hdr,...rows]); ws['!cols'] = colWidths([8,16,18,14,16,24,12,10,10,10,12,10,10,12,10,22,12,16,16,22,22]);
        XLSX.utils.book_append_sheet(wb, ws, 'Orders Summary');
      }
      if (sheetId === 'order_items') {
        const [items] = await pool.execute(`
          SELECT CONCAT(CASE WHEN b.token_prefix='T' THEN 'DIN' ELSE IFNULL(b.token_prefix,'DIN') END,LPAD(b.token_number,3,'0')) AS token,
            b.bill_number, IFNULL(b.customer_name,'Walk-in') AS customer_name, IFNULL(b.order_type,'Dine-in') AS order_type,
            bi.item_code, bi.item_name, bi.quantity, bi.unit_price, bi.line_total,
            IFNULL(bi.item_note,'—') AS item_note,
            DATE_FORMAT(CONVERT_TZ(b.created_at,'+00:00','+05:30'),'%Y-%m-%d %H:%i:%s') AS order_time_ist
          FROM bill_items bi JOIN bills b ON bi.bill_id=b.bill_id
          WHERE DATE(CONVERT_TZ(b.created_at,'+00:00','+05:30'))=? AND b.status='completed'
          ORDER BY b.created_at ASC, bi.id ASC
        `, [exportDate]);
        const hdr = ['Token','Bill No','Customer','Order Type','Item Code','Item Name','Qty','Unit Price (₹)','Line Total (₹)','Note','Order Time (IST)'];
        const rows = items.map(i => [i.token,i.bill_number,i.customer_name,i.order_type,i.item_code||'—',i.item_name,i.quantity,+i.unit_price,+i.line_total,i.item_note,i.order_time_ist]);
        const ws = XLSX.utils.aoa_to_sheet([hdr,...rows]); ws['!cols'] = colWidths([8,16,18,16,12,28,6,12,12,20,22]);
        XLSX.utils.book_append_sheet(wb, ws, 'Order Items Detail');
      }
      if (sheetId === 'item_sales') {
        const [s] = await pool.execute(`SELECT bi.item_code,bi.item_name,COALESCE(mi.category,'—') AS category,SUM(bi.quantity) AS total_qty,ROUND(SUM(bi.line_total),2) AS total_revenue,ROUND(AVG(bi.unit_price),2) AS avg_price,COUNT(DISTINCT b.bill_id) AS order_count FROM bill_items bi JOIN bills b ON bi.bill_id=b.bill_id LEFT JOIN menu mi ON bi.item_code=mi.item_code WHERE DATE(CONVERT_TZ(b.created_at,'+00:00','+05:30'))=? AND b.status='completed' GROUP BY bi.item_code,bi.item_name,mi.category ORDER BY total_revenue DESC`, [exportDate]);
        const hdr = ['Item Code','Item Name','Category','Total Qty Sold','Total Revenue (₹)','Avg Price (₹)','Orders Count'];
        const rows = s.map(i => [i.item_code||'—',i.item_name,i.category,+i.total_qty,+i.total_revenue,+i.avg_price,+i.order_count]);
        const ws = XLSX.utils.aoa_to_sheet([hdr,...rows]); ws['!cols'] = colWidths([12,30,16,12,16,12,12]);
        XLSX.utils.book_append_sheet(wb, ws, 'Item-wise Sales');
      }
      if (sheetId === 'payment_summary') {
        const [p] = await pool.execute(`SELECT COUNT(CASE WHEN status='completed' THEN 1 END) AS completed_orders,COUNT(CASE WHEN status='cancelled' THEN 1 END) AS cancelled_orders,ROUND(SUM(CASE WHEN status='completed' THEN grand_total ELSE 0 END),2) AS gross_revenue,ROUND(SUM(CASE WHEN status='completed' THEN COALESCE(cash_collected,0) ELSE 0 END),2) AS total_cash,ROUND(SUM(CASE WHEN status='completed' THEN COALESCE(upi_collected,0) ELSE 0 END),2) AS total_upi,ROUND(SUM(CASE WHEN status='completed' THEN COALESCE(cash_collected,0)+COALESCE(upi_collected,0) ELSE 0 END),2) AS total_collected,ROUND(SUM(CASE WHEN status='completed' AND (COALESCE(cash_collected,0)+COALESCE(upi_collected,0))<(grand_total-0.005) THEN grand_total-(COALESCE(cash_collected,0)+COALESCE(upi_collected,0)) ELSE 0 END),2) AS total_pending,ROUND(SUM(CASE WHEN status='cancelled' THEN grand_total ELSE 0 END),2) AS cancelled_value FROM bills WHERE DATE(CONVERT_TZ(created_at,'+00:00','+05:30'))=?`, [exportDate]);
        const ps = p[0];
        const rows = [['Metric','Value'],['Date',exportDate],['Completed Orders',+ps.completed_orders],['Cancelled Orders',+ps.cancelled_orders],['Gross Revenue (₹)',+ps.gross_revenue],['Total Cash (₹)',+ps.total_cash],['Total UPI (₹)',+ps.total_upi],['Total Collected (₹)',+ps.total_collected],['Pending Balance (₹)',+ps.total_pending],['Cancelled Value (₹)',+ps.cancelled_value]];
        const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = colWidths([32,18]);
        XLSX.utils.book_append_sheet(wb, ws, 'Payment Summary');
      }
      if (sheetId === 'delivery_performance') {
        const [d] = await pool.execute(`SELECT u.full_name AS driver_name,COUNT(b.bill_id) AS orders_delivered,ROUND(SUM(COALESCE(b.cash_collected,0)),2) AS cash_collected,ROUND(SUM(COALESCE(b.upi_collected,0)),2) AS upi_collected,ROUND(SUM(COALESCE(b.cash_collected,0)+COALESCE(b.upi_collected,0)),2) AS total_collected,ROUND(SUM(b.grand_total),2) AS total_billed FROM bills b JOIN users u ON b.delivered_by=u.id WHERE DATE(CONVERT_TZ(b.created_at,'+00:00','+05:30'))=? AND b.status='completed' AND b.delivery_status='delivered' GROUP BY b.delivered_by,u.full_name ORDER BY total_collected DESC`, [exportDate]);
        const hdr = ['Driver Name','Orders Delivered','Cash (₹)','UPI (₹)','Total Collected (₹)','Total Billed (₹)'];
        const rows = d.length ? d.map(x => [x.driver_name,+x.orders_delivered,+x.cash_collected,+x.upi_collected,+x.total_collected,+x.total_billed]) : [['No delivery data']];
        const ws = XLSX.utils.aoa_to_sheet([hdr,...rows]); ws['!cols'] = colWidths([20,14,16,16,18,16]);
        XLSX.utils.book_append_sheet(wb, ws, 'Delivery Performance');
      }
    }

    const filename = `POS_${exportDate}.xlsx`;
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
