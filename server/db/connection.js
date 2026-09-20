const mysql = require('mysql2/promise');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), override: true });

const asyncLocalStorage = new AsyncLocalStorage();

let runtimeDbMode = process.env.USE_TEST_DB === 'true' ? 'test' : 'main';

function getRuntimeDbMode() {
  return runtimeDbMode;
}

function setRuntimeDbMode(mode) {
  if (mode === 'test' || mode === 'main') {
    runtimeDbMode = mode;
    console.log(`🔄 Database mode switched to: ${runtimeDbMode.toUpperCase()}`);
  }
}

const dbConfig = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 4000,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  timezone: 'Z',
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

const mainPool = mysql.createPool(dbConfig);
const testPool = mysql.createPool({ ...dbConfig, database: process.env.DB_NAME + '_test' });

function isTestMode() {
  const store = asyncLocalStorage.getStore();
  if (store && typeof store.isTest === 'boolean') {
    return store.isTest;
  }
  return runtimeDbMode === 'test';
}

const pool = {
  execute: (...args) => (isTestMode() ? testPool : mainPool).execute(...args),
  query: (...args) => (isTestMode() ? testPool : mainPool).query(...args),
  getConnection: () => (isTestMode() ? testPool : mainPool).getConnection()
};

// Schema version — bump this when you add new tables/columns so the next
// cold start re-runs DDL; otherwise only a fast ping is performed.
const SCHEMA_VERSION = '10';

async function ensureColumn(conn, tableName, columnName, columnDef) {
  try {
    const [rows] = await conn.execute(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [tableName, columnName]
    );
    if (rows.length === 0) {
      await conn.execute(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnDef}`);
      console.log(`➕ Added missing column: ${tableName}.${columnName}`);
    }
  } catch (err) {
    console.error(`Failed to ensure column ${tableName}.${columnName}:`, err.message);
  }
}

async function initDB() {
  // Auto-create databases if they do not exist
  try {
    const { database, ...configWithoutDB } = dbConfig;
    const tempConn = await mysql.createConnection(configWithoutDB);
    await tempConn.execute(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\``);
    await tempConn.execute(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}_test\``);
    await tempConn.end();
  } catch (err) {
    console.error("⚠️  Failed to auto-create database (might lack permissions):", err.message);
  }

  // Fast path: if schema is already up-to-date just ping the DB
  try {
    const [rows] = await mainPool.execute(
      "SELECT value FROM settings WHERE key_name='schema_version'"
    );
    if (rows.length > 0 && rows[0].value === SCHEMA_VERSION) {
      // Schema is current — load admin's saved db_mode preference (defaults to 'main')
      try {
        const [modeRows] = await mainPool.execute("SELECT value FROM settings WHERE key_name='db_mode'");
        if (modeRows.length > 0 && (modeRows[0].value === 'test' || modeRows[0].value === 'main')) {
          runtimeDbMode = modeRows[0].value;
        }
      } catch (e) {}
      console.log(`✅ DB ready (schema v${SCHEMA_VERSION}, mode: ${runtimeDbMode.toUpperCase()})`);
      return;
    }
  } catch (e) {
    // settings table doesn't exist yet — fall through to full init
  }

  // Slow path: first-ever deploy or schema was bumped — run full DDL
  console.log(`⚙️  Running schema migration to v${SCHEMA_VERSION}...`);
  await initSingleDB(mainPool, false);
  try {
    await initSingleDB(testPool, true);
  } catch (e) {
    console.warn('⚠️ Test DB initialization skipped:', e.message);
  }

  // Stamp the schema version so next cold start skips DDL
  await mainPool.execute(
    "INSERT INTO settings (key_name, value) VALUES ('schema_version', ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    [SCHEMA_VERSION]
  );

  // Load admin's saved db_mode (defaults to 'main' unless explicitly switched)
  try {
    const [modeRows] = await mainPool.execute("SELECT value FROM settings WHERE key_name='db_mode'");
    if (modeRows.length > 0 && (modeRows[0].value === 'test' || modeRows[0].value === 'main')) {
      runtimeDbMode = modeRows[0].value;
    }
  } catch (e) {}

  console.log(`✅ Databases initialized (schema v${SCHEMA_VERSION}, mode: ${runtimeDbMode.toUpperCase()})`);
}

async function initSingleDB(targetPool, isTest = false) {
  const conn = await targetPool.getConnection();
  try {
    // Users table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        full_name VARCHAR(100) NOT NULL,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NULL,
        phone VARCHAR(20),
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('admin','staff','delivery_boy','kitchen') DEFAULT 'admin',
        status ENUM('active','inactive') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Add missing columns / fix constraints on users table
    await ensureColumn(conn, 'users', 'phone', 'VARCHAR(20)');
    try { await conn.execute("ALTER TABLE users MODIFY COLUMN role ENUM('admin','staff','delivery_boy','kitchen') DEFAULT 'admin'"); } catch(e) {}
    // Make email optional (nullable) — TiDB requires dropping unique index first
    try { await conn.execute("ALTER TABLE users DROP INDEX email"); } catch(e) {}
    try { await conn.execute("ALTER TABLE users MODIFY COLUMN email VARCHAR(100) NULL"); } catch(e) {}
    try { await conn.execute("ALTER TABLE users ADD UNIQUE INDEX idx_email (email)"); } catch(e) {}

    // Menu table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS menu (
        id INT AUTO_INCREMENT PRIMARY KEY,
        item_code VARCHAR(50) UNIQUE NOT NULL,
        item_name VARCHAR(200) NOT NULL,
        category VARCHAR(100),
        default_price DECIMAL(10,2) NOT NULL,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Bills table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS bills (
        bill_id INT AUTO_INCREMENT PRIMARY KEY,
        bill_number VARCHAR(50) UNIQUE NOT NULL,
        token_number INT NOT NULL,
        customer_name VARCHAR(100),
        customer_phone VARCHAR(20),
        order_type VARCHAR(100) DEFAULT 'Dine-in',
        delivery_address TEXT,
        custom_note TEXT,
        subtotal DECIMAL(10,2) DEFAULT 0,
        delivery_enabled TINYINT(1) DEFAULT 0,
        delivery_charge DECIMAL(10,2) DEFAULT 0,
        parcel_enabled TINYINT(1) DEFAULT 0,
        parcel_charge DECIMAL(10,2) DEFAULT 0,
        discount_enabled TINYINT(1) DEFAULT 0,
        discount_type ENUM('percentage','fixed') DEFAULT 'fixed',
        discount_value DECIMAL(10,2) DEFAULT 0,
        discount_amount DECIMAL(10,2) DEFAULT 0,
        grand_total DECIMAL(10,2) DEFAULT 0,
        status ENUM('completed','draft','cancelled') DEFAULT 'completed',
        token_prefix VARCHAR(5) DEFAULT 'T',
        delivery_status ENUM('pending','preparing','ready','picked_up','delivered') DEFAULT 'pending',
        packing_status ENUM('pending','packing','packed') DEFAULT 'pending',
        cash_collected DECIMAL(10,2) DEFAULT 0,
        upi_collected DECIMAL(10,2) DEFAULT 0,
        delivered_by INT,
        delivered_at TIMESTAMP NULL,
        assigned_delivery_boy INT,
        change_settled TINYINT(1) DEFAULT 0,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id),
        FOREIGN KEY (delivered_by) REFERENCES users(id)
      )
    `);

    // Ensure all columns exist on bills table
    await ensureColumn(conn, 'bills', 'customer_name', 'VARCHAR(100)');
    await ensureColumn(conn, 'bills', 'order_type', "VARCHAR(100) DEFAULT 'Dine-in'");
    await ensureColumn(conn, 'bills', 'delivery_address', 'TEXT');
    await ensureColumn(conn, 'bills', 'custom_note', 'TEXT');
    await ensureColumn(conn, 'bills', 'token_prefix', "VARCHAR(5) DEFAULT 'T'");
    await ensureColumn(conn, 'bills', 'delivery_status', "ENUM('pending','preparing','ready','picked_up','delivered') DEFAULT 'pending'");
    await ensureColumn(conn, 'bills', 'packing_status', "ENUM('pending','packing','packed') DEFAULT 'pending'");
    await ensureColumn(conn, 'bills', 'cash_collected', 'DECIMAL(10,2) DEFAULT 0');
    await ensureColumn(conn, 'bills', 'upi_collected', 'DECIMAL(10,2) DEFAULT 0');
    await ensureColumn(conn, 'bills', 'parcel_enabled', 'TINYINT(1) DEFAULT 0');
    await ensureColumn(conn, 'bills', 'parcel_charge', 'DECIMAL(10,2) DEFAULT 0');
    await ensureColumn(conn, 'bills', 'delivered_by', 'INT');
    await ensureColumn(conn, 'bills', 'delivered_at', 'TIMESTAMP NULL');
    await ensureColumn(conn, 'bills', 'assigned_delivery_boy', 'INT');
    await ensureColumn(conn, 'bills', 'change_settled', 'TINYINT(1) DEFAULT 0');
    try { await conn.execute("ALTER TABLE bills MODIFY COLUMN status ENUM('completed','draft','cancelled') DEFAULT 'completed'"); } catch(e) {}

    // Bill items table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS bill_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        bill_id INT NOT NULL,
        item_code VARCHAR(50),
        item_name VARCHAR(200) NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        unit_price DECIMAL(10,2) NOT NULL,
        line_total DECIMAL(10,2) NOT NULL,
        is_manual TINYINT(1) DEFAULT 0,
        item_note VARCHAR(255),
        FOREIGN KEY (bill_id) REFERENCES bills(bill_id)
      )
    `);
    
    // Add item_note if missing
    try { await conn.execute("ALTER TABLE bill_items ADD COLUMN IF NOT EXISTS item_note VARCHAR(255)"); } catch(e) {}

    // Settings table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS settings (
        key_name VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Token counter table (supports prefix per order type)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS token_counter (
        id INT AUTO_INCREMENT PRIMARY KEY,
        counter_date DATE NOT NULL,
        prefix VARCHAR(5) NOT NULL DEFAULT 'T',
        last_token INT DEFAULT 0,
        UNIQUE KEY unique_date_prefix (counter_date, prefix)
      )
    `);
    // Migrate old token_counter rows (add prefix column if missing)
    try { await conn.execute("ALTER TABLE token_counter ADD COLUMN IF NOT EXISTS prefix VARCHAR(5) NOT NULL DEFAULT 'T'"); } catch(e) {}
    try { await conn.execute("ALTER TABLE token_counter DROP INDEX unique_date"); } catch(e) {}
    try { await conn.execute("ALTER TABLE token_counter ADD UNIQUE KEY unique_date_prefix (counter_date, prefix)"); } catch(e) {}

    // Insert default settings if not exists
    const defaultSettings = [
      ['restaurant_name', 'Your Restaurant'],
      ['tagline', 'Good Food, Great Experience'],
      ['address', ''],
      ['phone', ''],
      ['email', ''],
      ['gst_number', ''],
      ['currency', '₹'],
      ['timezone', 'Asia/Kolkata'],
      ['footer', 'Thank you for dining with us! Visit again soon.'],
      ['delivery_locations', 'Zone 1, Zone 2, Zone 3'],
      ['token_format', 'daily'],
      ['auto_print_kot', '1'],
      ['auto_print_receipt', '1'],
      ['auto_print_checklist', '0'],
      ['paper_width', '80'],
      ['customer_printer_ip', process.env.CUSTOMER_PRINTER_IP || ''],
      ['customer_printer_port', process.env.CUSTOMER_PRINTER_PORT || '9100'],
      ['customer_usb_printer_name', process.env.CUSTOMER_USB_PRINTER_NAME || ''],
      ['kitchen_printer_ip', process.env.KITCHEN_PRINTER_IP || ''],
      ['kitchen_printer_port', process.env.KITCHEN_PRINTER_PORT || '9100'],
      ['kitchen_usb_printer_name', process.env.KITCHEN_USB_PRINTER_NAME || ''],
    ];

    for (const [key, value] of defaultSettings) {
      await conn.execute(
        'INSERT IGNORE INTO settings (key_name, value) VALUES (?, ?)',
        [key, value]
      );
    }


    console.log(`✅ Database initialized successfully (${isTest ? 'TEST' : 'MAIN'})`);

  } finally {
    conn.release();
  }
}

module.exports = { pool, initDB, asyncLocalStorage, getRuntimeDbMode, setRuntimeDbMode };
