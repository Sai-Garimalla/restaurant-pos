const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const { pool } = require('../db/connection');
const { authenticateToken, requireAdminOrStaff } = require('../middleware/auth');

router.get('/template', (req, res) => {
  const csvData = "item_name,category,default_price\nDemo Burger,Mains,8.99\nDemo Pizza,Mains,12.99\nDemo Coffee,Beverages,3.99\n";
  res.setHeader('Content-Disposition', 'attachment; filename="menu_template.csv"');
  res.setHeader('Content-Type', 'text/csv');
  res.send(csvData);
});

router.use(authenticateToken);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Get all menu items
router.get('/', async (req, res) => {
  try {
    const { search, category } = req.query;
    let query = 'SELECT * FROM menu WHERE is_active = 1';
    const params = [];

    if (search) {
      query += ' AND (item_name LIKE ? OR item_code LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }

    query += ' ORDER BY category, item_name';
    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get categories
router.get('/categories', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT DISTINCT category FROM menu WHERE is_active = 1 ORDER BY category"
    );
    res.json(rows.map(r => r.category));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload Excel/CSV menu (replaces existing)
router.post('/upload', requireAdminOrStaff, upload.single('menu_file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    let data = [];
    const filename = req.file.originalname.toLowerCase();
    
    if (filename.endsWith('.csv')) {
      const csvStr = req.file.buffer.toString('utf8');
      const lines = csvStr.split(/\r?\n/).filter(l => l.trim());
      if (lines.length > 0) {
        const headers = lines[0].split(',').map(h => h.trim());
        for (let i = 1; i < lines.length; i++) {
          const row = lines[i].split(',').map(c => c.trim());
          const obj = {};
          headers.forEach((h, idx) => { obj[h] = row[idx] || ''; });
          data.push(obj);
        }
      }
    } else {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    }

    if (!data.length) return res.status(400).json({ error: 'File is empty.' });

    // Validate columns
    const required = ['item_name', 'category', 'default_price'];
    const headers = Object.keys(data[0]);
    for (const col of required) {
      if (!headers.includes(col)) {
        return res.status(400).json({ error: `Missing column: "${col}". Required: item_name, category, default_price` });
      }
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('UPDATE menu SET is_active = 0');

      let inserted = 0, skipped = 0;
      const prefixCounters = {};

      for (const row of data) {
        let code = ''; // Always auto-generate
        const name = String(row['item_name'] || '').trim();
        const category = String(row['category'] || 'General').trim();
        const price = parseFloat(row['default_price']) || 0;

        if (!name || price <= 0) { skipped++; continue; }

        if (!code) {
           const prefix = category.substring(0, 3).toUpperCase() || 'GEN';
           if (!prefixCounters[prefix]) {
              const [rows] = await conn.execute(
                'SELECT item_code FROM menu WHERE item_code LIKE ? ORDER BY item_code DESC LIMIT 1',
                [prefix + '%']
              );
              let nextNum = 1;
              if (rows.length > 0) {
                 const numPart = rows[0].item_code.substring(prefix.length);
                 const parsed = parseInt(numPart, 10);
                 if (!isNaN(parsed)) nextNum = parsed + 1;
              }
              prefixCounters[prefix] = nextNum;
           }
           code = prefix + String(prefixCounters[prefix]++).padStart(3, '0');
        }

        await conn.execute(
          `INSERT INTO menu (item_code, item_name, category, default_price, is_active)
           VALUES (?, ?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE item_name=VALUES(item_name), category=VALUES(category),
           default_price=VALUES(default_price), is_active=1`,
          [code, name, category, price]
        );
        inserted++;
      }

      await conn.commit();
      res.json({ success: true, inserted, skipped });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add single menu item
router.post('/', requireAdminOrStaff, async (req, res) => {
  try {
    const { item_name, category, default_price } = req.body;
    if (!item_name || !default_price) {
      return res.status(400).json({ error: 'Item name and price are required.' });
    }
    
    let item_code = req.body.item_code;
    const catName = (category || 'General').trim();
    if (!item_code) {
      const prefix = catName.substring(0, 3).toUpperCase() || 'GEN';
      const [rows] = await pool.execute(
        'SELECT item_code FROM menu WHERE item_code LIKE ? ORDER BY item_code DESC LIMIT 1',
        [prefix + '%']
      );
      let nextNum = 1;
      if (rows.length > 0) {
         const numPart = rows[0].item_code.substring(prefix.length);
         const parsed = parseInt(numPart, 10);
         if (!isNaN(parsed)) nextNum = parsed + 1;
      }
      item_code = prefix + String(nextNum).padStart(3, '0');
    }

    await pool.execute(
      'INSERT INTO menu (item_code, item_name, category, default_price) VALUES (?, ?, ?, ?)',
      [item_code, item_name, catName, parseFloat(default_price)]
    );
    res.json({ success: true, item_code });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Item code already exists.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Update menu item
router.put('/:id', requireAdminOrStaff, async (req, res) => {
  try {
    const { item_name, category, default_price } = req.body;
    await pool.execute(
      'UPDATE menu SET item_name=?, category=?, default_price=? WHERE id=?',
      [item_name, category, parseFloat(default_price), req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete menu item (soft)
router.delete('/:id', requireAdminOrStaff, async (req, res) => {
  try {
    await pool.execute('UPDATE menu SET is_active=0 WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
