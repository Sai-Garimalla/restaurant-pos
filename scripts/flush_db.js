/**
 * flush_db.js — Development/testing utility
 * ⚠️  DANGER: Truncates bills, bill_items, and token_counter. ALL ORDER DATA IS LOST.
 * This script is intentionally NOT deployed to production.
 * Requires manual confirmation before executing.
 */
const readline = require('readline');

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function flush() {
  console.log('\n⚠️  WARNING: This will PERMANENTLY DELETE all bills, bill_items, and token_counter rows.\n');
  const answer = await confirm('Type "yes I am sure" to proceed, or anything else to abort: ');
  if (answer !== 'yes I am sure') {
    console.log('Aborted — no changes made.');
    process.exit(0);
  }

  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  const { pool } = require('../server/db/connection.js');

  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    console.log('Flushing bill_items...');
    await conn.query('TRUNCATE TABLE bill_items');
    console.log('Flushing bills...');
    await conn.query('TRUNCATE TABLE bills');
    console.log('Flushing token_counter...');
    await conn.query('TRUNCATE TABLE token_counter');
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log('✅ Database flushed successfully!');
  } catch (e) {
    console.error('❌ Error during flush:', e);
  } finally {
    conn.release();
    process.exit(0);
  }
}

flush();
