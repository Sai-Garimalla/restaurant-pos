/**
 * update_menu.js — Seed / update the menu table with demo items.
 *
 * USAGE:
 *   node scripts/update_menu.js
 *
 * Replace the menuItems array below with your own restaurant menu
 * before running this script, or manage your menu through the
 * in-app Menu Management page instead.
 *
 * ⚠️  This script soft-deletes all existing menu items first,
 *     then upserts the items defined below.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { pool } = require('../server/db/connection');

// ── Replace this array with your actual menu ──────────────────────────────
const menuItems = [
  // Starters
  { code: 'ST-01', name: 'Garden Salad',           category: 'Starters',    price: 5.99  },
  { code: 'ST-02', name: 'Soup of the Day',         category: 'Starters',    price: 4.99  },
  { code: 'ST-03', name: 'Garlic Bread',            category: 'Starters',    price: 3.99  },

  // Mains
  { code: 'MN-01', name: 'Grilled Chicken',         category: 'Mains',       price: 14.99 },
  { code: 'MN-02', name: 'Margherita Pizza',        category: 'Mains',       price: 12.99 },
  { code: 'MN-03', name: 'Classic Burger',          category: 'Mains',       price: 10.99 },
  { code: 'MN-04', name: 'Pasta Arrabbiata',        category: 'Mains',       price: 11.99 },
  { code: 'MN-05', name: 'Grilled Salmon',          category: 'Mains',       price: 18.99 },

  // Sides
  { code: 'SD-01', name: 'French Fries',            category: 'Sides',       price: 3.49  },
  { code: 'SD-02', name: 'Coleslaw',                category: 'Sides',       price: 2.49  },

  // Desserts
  { code: 'DS-01', name: 'Chocolate Brownie',       category: 'Desserts',    price: 5.99  },
  { code: 'DS-02', name: 'Ice Cream (2 scoops)',    category: 'Desserts',    price: 4.99  },

  // Beverages
  { code: 'BV-01', name: 'Soft Drink',              category: 'Beverages',   price: 2.49  },
  { code: 'BV-02', name: 'Fresh Juice',             category: 'Beverages',   price: 3.99  },
  { code: 'BV-03', name: 'Coffee',                  category: 'Beverages',   price: 2.99  },
  { code: 'BV-04', name: 'Tea',                     category: 'Beverages',   price: 1.99  },
];
// ─────────────────────────────────────────────────────────────────────────

async function updateMenu() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Soft-delete all existing items so old ones don't appear in the app
    await conn.execute('UPDATE menu SET is_active = 0');
    console.log('Deactivated existing menu items.');

    let count = 0;
    for (const item of menuItems) {
      await conn.execute(
        `INSERT INTO menu (item_code, item_name, category, default_price, is_active)
         VALUES (?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           item_name      = VALUES(item_name),
           category       = VALUES(category),
           default_price  = VALUES(default_price),
           is_active      = 1`,
        [item.code, item.name, item.category, item.price]
      );
      count++;
    }

    await conn.commit();
    console.log(`✅ Done! ${count} menu items inserted/updated.`);
  } catch (err) {
    await conn.rollback();
    console.error('❌ Error updating menu:', err);
  } finally {
    conn.release();
    process.exit(0);
  }
}

updateMenu();
