const { pool } = require('./server/db/connection');
async function check() {
  const [rows] = await pool.query("DESCRIBE bills");
  console.log(rows);
  process.exit(0);
}
check();
