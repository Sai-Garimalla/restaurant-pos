const path = require('path');
require('dotenv').config({ path: require('path').join(__dirname, '../.env'), override: true });
const express = require('express');
const cors = require('cors');
const { initDB } = require('./db/connection');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (Vercel, Cloudflare, Heroku, etc.)
app.set('trust proxy', 1);

// Middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (same-origin, curl, Vercel serverless, etc.)
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    // Allow Vercel preview & production deployment URLs
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    // Allow local development ports
    if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return callback(null, true);
    // Allow local network (LAN) access from phones/tablets on same WiFi
    if (/^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Lazy memoized DB initialization helper for serverless functions
let dbInitPromise = null;
function ensureDB() {
  if (!dbInitPromise) {
    dbInitPromise = initDB().catch(err => {
      console.error('❌ Database initialization error:', err.message);
      dbInitPromise = null; // Reset to allow retry on next request if transient failure
      throw err;
    });
  }
  return dbInitPromise;
}

// Middleware to ensure DB connection is ready before processing API requests
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api')) {
    try {
      await ensureDB();
    } catch (err) {
      return res.status(500).json({ error: `Database Connection Failed: ${err.message}` });
    }
  }
  next();
});

// Serve static client files
app.use(express.static(path.join(__dirname, '../client')));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/bills', require('./routes/bills'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/users', require('./routes/users'));
app.use('/api/delivery', require('./routes/delivery'));
app.use('/api/export',   require('./routes/export'));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../client/index.html'));
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

async function start() {
  try {
    await ensureDB();
    if (require.main === module) {
      app.listen(PORT, () => {
        console.log(`🚀 Restaurant POS server running on http://localhost:${PORT}`);
      });
    }
  } catch (err) {
    console.error('❌ Failed to start server:', err.message);
    if (require.main === module) {
      process.exit(1);
    }
  }
}

// Start local server or queue DB init
start();

// Export the Express app so Vercel can run it as a serverless function
module.exports = app;

