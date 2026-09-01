const mysql = require('mysql2/promise');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 4000,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: true },
});

async function run() {
  await pool.execute("UPDATE settings SET value='main' WHERE key_name='db_mode'");
  console.log('✅ db_mode reset to MAIN');
  await pool.end();
}

run().catch(e => { console.error(e.message); process.exit(1); });
