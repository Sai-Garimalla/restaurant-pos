# Configuration Guide

Complete configuration reference for the Restaurant POS template.

---

## 1. Environment Variables (`.env`)

Copy `.env.example` to `.env` and fill in all values.

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_HOST` | ✅ | Database host (e.g. `localhost` or TiDB hostname) |
| `DB_PORT` | ✅ | Database port (`3306` for MySQL, `4000` for TiDB) |
| `DB_USER` | ✅ | Database username |
| `DB_PASSWORD` | ✅ | Database password |
| `DB_NAME` | ✅ | Database name (e.g. `restaurant_pos`) |
| `JWT_SECRET` | ✅ | Random string for signing JWTs (min 32 chars) |
| `PORT` | ❌ | Server port (default: `3000`) |
| `ALLOWED_ORIGINS` | ❌ | Comma-separated CORS origins (default: `http://localhost:3000`) |
| `MQTT_HOST` | ❌ | MQTT broker hostname (only needed for cloud printing) |
| `MQTT_USER` | ❌ | MQTT broker username |
| `MQTT_PASS` | ❌ | MQTT broker password |
| `USE_TEST_DB` | ❌ | Set `true` only in test/CI environments |

### Generating a JWT Secret

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> ⚠️ **Never commit `.env` to git.** It is already in `.gitignore`.

---

## 2. Restaurant Identity & Settings (In-App Settings Page)

All restaurant identity, branding, printer configuration, and POS preferences are stored directly in your database and managed live through the **Settings** page (`/settings.html`) by an Admin.

No manual JSON config files are required.

### Configurable Fields in Admin Settings

| Field | Description |
|-------|-------------|
| **Restaurant Name** | Full restaurant name — displayed across the login page, sidebar navigation, and receipts |
| **Tagline / Slogan** | Subtitle displayed on the login page below the restaurant name and on customer receipts |
| **Address** | Physical address printed on customer receipts and checklists |
| **Phone** | Contact phone number printed on customer receipts and checklists |
| **Email** | Contact email address printed on customer receipts (optional) |
| **GST / Tax Number** | GSTIN / Tax registration number printed on customer receipts (optional) |
| **Currency Symbol** | Currency symbol displayed throughout the app (default: `₹`) |
| **Timezone** | IANA timezone used for receipt and bill timestamps (default: `Asia/Kolkata`) |
| **Receipt Footer Message** | Custom message printed at the bottom of customer receipts |
| **Delivery Locations / Areas** | Comma-separated list of delivery zones displayed on the billing page |
| **Token Reset** | Daily reset (`1, 2, 3...` each day) or Continuous numbering |
| **Auto-print Options** | Auto-print Customer Receipts, KOT tickets, or Counter Checklists |
| **Printer IPs & Ports** | ESC/POS network thermal printer IP and port settings for Customer & Kitchen printers |
| **Paper Width** | ESC/POS thermal paper width (`80mm` / 48 chars or `58mm` / 32 chars) |
| **Database Environment** | Live switcher between Production Database and Test Database |

---

## 3. Database Setup

### MySQL (local)

```bash
mysql -u root -p
CREATE DATABASE restaurant_pos;
CREATE USER 'pos_user'@'localhost' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON restaurant_pos.* TO 'pos_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

Then set in `.env`:
```
DB_HOST=localhost
DB_PORT=3306
DB_USER=pos_user
DB_PASSWORD=your_password
DB_NAME=restaurant_pos
```

### TiDB (serverless, free tier)

1. Sign up at [tidbcloud.com](https://tidbcloud.com)
2. Create a free Serverless cluster
3. Copy the connection string from the dashboard
4. Set `DB_PORT=4000` and `ssl` is handled automatically

### Schema Initialization

The database schema is created automatically on first server startup. No manual SQL migrations needed.

---

## 4. Menu Setup

### Option A: In-App Menu Management (recommended)

Go to **Menu Management** in the app to add, edit, and delete items. You can also bulk upload via CSV or XLSX.

**CSV format:**
```
item_name,category,default_price
Grilled Chicken,Mains,14.99
Caesar Salad,Starters,8.99
```

Download the template from Menu Management → **Download Template**.

### Option B: Seed Script

Edit the `menuItems` array in `scripts/update_menu.js`, then run:

```bash
node scripts/update_menu.js
```

---

## 5. Printer Setup

### Supported Printers

Any ESC/POS thermal printer with **network connectivity (Wi-Fi or Ethernet)** and **TCP port 9100** support:

- Epson TM series (TM-T20, TM-T82, TM-T88, etc.)
- Star TSP series
- Xprinter XP series
- Bixolon SRP series
- Citizen CT-S series
- TVS RP series
- Generic ESC/POS network printers

### Paper Width

| Setting | Chars/Line | Paper Width |
|---------|-----------|------------|
| `80` | 48 chars/line | 80mm (most common) |
| `58` | 32 chars/line | 58mm (compact) |

Set in the app: **Settings → Paper Width**

### Printer Network Configuration

1. Connect the printer to your restaurant's Wi-Fi or LAN
2. Assign it a **static IP address** (or reserve the IP in your router's DHCP settings)
3. Note the IP address — you'll enter it in the **Settings** page

### MQTT Broker Setup (for cloud printing)

The ESP32 bridge connects to any MQTT broker. Free options:

- **HiveMQ Cloud** — [hivemq.com/mqtt-cloud-broker](https://www.hivemq.com/mqtt-cloud-broker/) (free tier: 100 connections)
- **EMQX Cloud** — [emqx.com](https://www.emqx.com) (free tier available)
- **Self-hosted Mosquitto** — install on any Linux server or Raspberry Pi

Set the MQTT credentials in your `.env`:
```
MQTT_HOST=your-broker.example.com
MQTT_USER=your-username
MQTT_PASS=your-password
```

### ESP32 Setup

1. Install [Arduino IDE](https://www.arduino.cc/en/software)
2. Add ESP32 board support (File → Preferences → Additional Board URLs → add the Espressif URL)
3. Install **PubSubClient** library (Sketch → Include Library → Manage Libraries → search "PubSubClient")
4. Open `ESP32_Cloud_Printer/ESP32_Cloud_Printer.ino`
5. Edit the three config sections at the top:

```cpp
// Section 1: Wi-Fi
const char* ssid     = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// Section 2: MQTT Broker
const char* mqtt_server = "YOUR_MQTT_HOST";
const char* mqtt_user   = "YOUR_MQTT_USER";
const char* mqtt_pass   = "YOUR_MQTT_PASS";

// Section 3: Printer
const char* printerIP = "192.168.1.xxx";  // Your printer's static IP
```

6. Select your ESP32 board (Tools → Board → ESP32 Dev Module)
7. Flash the sketch
8. Open Serial Monitor at 115200 baud — you should see:
   ```
   [OK] Wi-Fi connected!
   [OK] MQTT connected!
   Subscribed: restaurant/printer/+  [QoS 1]
   ```

---

## 6. Assets

Place your custom images in `client/assets/`:

| File | Description |
|------|-------------|
| `logo.png` | Restaurant logo — shown in login page and sidebar (recommended: 200×200px) |
| `payment_qr.png` | UPI / payment QR code (optional) |

A generic placeholder logo is included. Replace it with your own.

> ⚠️ Do NOT commit real payment QR codes to a public repository.

---

## 7. Deployment (Vercel)

1. Push your code to GitHub (ensure `.env` is gitignored — it is by default)
2. Connect the GitHub repo to [Vercel](https://vercel.com)
3. Set all environment variables in the Vercel dashboard (Project → Settings → Environment Variables)
4. Deploy

The included `vercel.json` configures the backend as serverless API routes and serves the frontend as static files.

---

## 8. Security Checklist

Before going live:

- [ ] `.env` is NOT committed to git (check with `git status`)
- [ ] `JWT_SECRET` is a random string of at least 32 characters
- [ ] Database user has only the minimum necessary permissions (no `GRANT ALL` on production)
- [ ] MQTT broker has authentication enabled (not anonymous access)
- [ ] `ALLOWED_ORIGINS` in `.env` is set to your actual frontend URL (not `*`)
- [ ] Admin account has a strong password
- [ ] Printer IP is on a private subnet (not exposed to the internet)
