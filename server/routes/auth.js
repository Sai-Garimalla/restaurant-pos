const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, asyncLocalStorage, getRuntimeDbMode } = require('../db/connection');
const rateLimit = require('express-rate-limit');

// Rate limiter: max 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please try again in 15 minutes.' },
});

// Check if any admin exists (for first-time setup)
router.get('/setup-status', async (req, res) => {
  const isTest = getRuntimeDbMode() === 'test';
  asyncLocalStorage.run({ isTest }, async () => {
    try {
      const [rows] = await pool.execute("SELECT COUNT(*) AS count FROM users WHERE role='admin'");
      res.json({ needsSetup: rows[0].count === 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

// First-time admin registration
router.post('/setup', async (req, res) => {
  const isTest = getRuntimeDbMode() === 'test';
  asyncLocalStorage.run({ isTest }, async () => {
    try {
      const [existing] = await pool.execute("SELECT COUNT(*) AS count FROM users WHERE role='admin'");
      if (existing[0].count > 0) {
        return res.status(400).json({ error: 'Admin already exists. Use login instead.' });
      }

      const { full_name, username, email, password } = req.body;
      if (!full_name || !username || !email || !password) {
        return res.status(400).json({ error: 'All fields are required.' });
      }

      const hash = await bcrypt.hash(password, 12);
      await pool.execute(
        'INSERT INTO users (full_name, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
        [full_name, username, email, hash, 'admin']
      );

      res.json({ success: true, message: 'Admin account created successfully.' });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ error: 'Username or email already exists.' });
      }
      res.status(500).json({ error: err.message });
    }
  });
});

// Login
router.post('/login', authLimiter, async (req, res) => {
  const { identifier, password, rememberMe } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Username/email and password are required.' });
  }

  // Always authenticate against the MAIN production DB.
  // After login, the auth middleware handles test/main routing per-role.
  const isTest = false;

  asyncLocalStorage.run({ isTest }, async () => {
    try {
      const [rows] = await pool.execute(
        "SELECT * FROM users WHERE (username=? OR email=?) AND status='active'",
        [identifier, identifier]
      );

      if (rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }

      const user = rows[0];
      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }

      const expiresIn = rememberMe ? '30d' : '8h';
      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, full_name: user.full_name },
        process.env.JWT_SECRET,
        { expiresIn }
      );

      res.json({
        success: true,
        token,
        user: { id: user.id, full_name: user.full_name, username: user.username, role: user.role }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

// Verify token
router.get('/verify', require('../middleware/auth').authenticateToken, (req, res) => {
  res.json({ valid: true, user: req.user });
});

module.exports = router;
