const jwt = require('jsonwebtoken');
const { asyncLocalStorage, getRuntimeDbMode } = require('../db/connection');

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    // Only admins can operate in test mode.
    // Staff, kitchen, and delivery_boy always use the main production DB.
    const isTest = decoded.role === 'admin' && getRuntimeDbMode() === 'test';
    asyncLocalStorage.run({ isTest }, () => {
      next();
    });
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Admin access required.' });
  }
}

function requireAdminOrStaff(req, res, next) {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'staff')) {
    next();
  } else {
    res.status(403).json({ error: 'Staff or Admin access required.' });
  }
}

function requireDeliveryBoy(req, res, next) {
  if (req.user && (req.user.role === 'delivery_boy' || req.user.role === 'admin')) {
    next();
  } else {
    res.status(403).json({ error: 'Delivery boy access required.' });
  }
}

function requireKitchen(req, res, next) {
  if (req.user && (req.user.role === 'kitchen' || req.user.role === 'admin' || req.user.role === 'staff')) {
    next();
  } else {
    res.status(403).json({ error: 'Kitchen access required.' });
  }
}

module.exports = { authenticateToken, requireAdmin, requireAdminOrStaff, requireDeliveryBoy, requireKitchen };
