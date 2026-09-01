# /scripts — Utility Scripts

Helper scripts for database management. Run these from the **project root**.

> ⚠️ Always make sure your `.env` file is configured correctly before running these scripts.

---

## `update_menu.js`

Seeds the `menu` table with demo items. Edit the `menuItems` array inside the script to match your actual menu before running.

```bash
node scripts/update_menu.js
```

> **Note:** You can also manage your menu entirely through the in-app **Menu Management** page without running this script.

---

## `flush_db.js`

⚠️ **Destructive.** Drops and recreates all tables. Use only for a clean reset during initial setup or development.

```bash
node scripts/flush_db.js
```

---

## `fix-admin.js`

Resets or creates the admin user. Useful if you've lost access to the admin account.

```bash
node scripts/fix-admin.js
```

---

## `check_db.js`

Connects to the database and prints table counts — useful for quickly verifying the connection and data state.

```bash
node scripts/check_db.js
```
