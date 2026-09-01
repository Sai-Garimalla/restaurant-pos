const express = require('express');
const router = express.Router();
const { pool, getRuntimeDbMode, setRuntimeDbMode } = require('../db/connection');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// Public endpoint — returns safe restaurant identity (no auth required)
// Used by login page and other pre-auth UI
router.get('/public', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT key_name, value FROM settings WHERE key_name IN ('restaurant_name','tagline','address','phone','email','gst_number','footer','currency','timezone','delivery_locations')"
    );
    const data = {};
    rows.forEach(r => { data[r.key_name] = r.value; });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use(authenticateToken);


// Get all settings
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT key_name, value FROM settings');
    const settings = {};
    rows.forEach(r => { settings[r.key_name] = r.value; });
    settings.db_mode = getRuntimeDbMode();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update settings (admin only)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { db_mode, ...otherSettings } = req.body;
    if (db_mode && (db_mode === 'main' || db_mode === 'test')) {
      setRuntimeDbMode(db_mode);
      otherSettings.db_mode = db_mode;
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const [key, value] of Object.entries(otherSettings)) {
        await conn.execute(
          'INSERT INTO settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
          [key, String(value)]
        );
      }
      await conn.commit();
      res.json({ success: true, db_mode: getRuntimeDbMode() });
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

module.exports = router;
