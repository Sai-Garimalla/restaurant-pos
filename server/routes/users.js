const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db/connection');
const { authenticateToken, requireAdmin, requireAdminOrStaff } = require('../middleware/auth');

router.use(authenticateToken);

// GET all staff users (admin or staff)
router.get('/', requireAdminOrStaff, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT id, full_name, username, email, phone, role, status, created_at FROM users ORDER BY status ASC, created_at DESC"
    );
    res.json({ users: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create staff user (admin only)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { full_name, username, email, phone, password, role } = req.body;
    if (!full_name || !username || !password) return res.status(400).json({ error: 'Name, username and password are required.' });
    if (role === 'delivery_boy' && !phone) return res.status(400).json({ error: 'Phone number is required for Delivery Boys.' });
    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      'INSERT INTO users (full_name, username, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
      [full_name, username, email || null, phone || null, hash, ['admin','staff','delivery_boy','kitchen'].includes(role) ? role : 'staff']
    );
    res.json({ success: true, user_id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Username or email already exists.' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH update user (admin only)
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { full_name, username, phone, status, role } = req.body;
    if (role === 'delivery_boy' && !phone) return res.status(400).json({ error: 'Phone number is required for Delivery Boys.' });
    await pool.execute(
      'UPDATE users SET full_name=?, username=?, phone=?, status=?, role=? WHERE id=?',
      [full_name, username, phone || null, status || 'active', ['admin','staff','delivery_boy','kitchen'].includes(role) ? role : 'staff', req.params.id]
    );
    res.json({ success: true, updated_username: username });
  } catch (err) { 
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Username already exists.' });
    res.status(500).json({ error: err.message }); 
  }
});

// PATCH change user password (admin only)
router.patch('/:id/password', requireAdmin, async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const hash = await bcrypt.hash(new_password, 12);
    await pool.execute('UPDATE users SET password_hash=? WHERE id=?', [hash, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE user (admin only, can't delete yourself)
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: "Can't delete your own account." });
    await pool.execute('UPDATE users SET status=? WHERE id=?', ['inactive', req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
