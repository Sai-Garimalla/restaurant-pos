# 🍽️ Restaurant POS

A self-hosted, open-source **Point of Sale system** for restaurants. Supports dine-in, takeaway, and delivery orders with cloud printing via MQTT and ESC/POS thermal printers.

> **This is a template.** Fork or clone it, configure your environment, add your menu, and run your own POS.

---

## Features

- **Billing & Receipts** — Dine-in, Takeaway, and Delivery orders with automatic token numbering
- **KOT Printing** — Kitchen Order Tickets sent to a separate kitchen printer
- **Menu Management** — Add, edit, delete menu items; bulk upload via CSV/XLSX
- **Dashboard & Reports** — Daily sales summary, revenue breakdown, item-level sales reports
- **Customer History** — Search orders by phone number
- **Delivery Management** — Assign delivery boys, track order status
- **Kitchen Display** — Dedicated kitchen screen for packing/preparing orders
- **User Management** — Admin, Staff, Delivery Boy, Kitchen roles
- **Cloud Printing** — ESC/POS thermal printing via MQTT → ESP32 bridge (no USB required)
- **Paper Width Support** — 58mm (32 chars) and 80mm (48 chars) receipt paper
- **Export** — Download sales data as Excel (.xlsx)
- **Responsive UI** — Works on desktop, tablet, and mobile browsers

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML, Vanilla CSS, Vanilla JS |
| Backend | Node.js + Express |
| Database | MySQL / TiDB / MariaDB |
| Auth | JWT |
| Printing | ESC/POS over MQTT → ESP32 → TCP 9100 |
| Deployment | Vercel (backend) + static frontend |

---

## Requirements

- Node.js 18+
- MySQL 8+, MariaDB 10.6+, or TiDB (serverless)
- A network ESC/POS thermal printer (optional — needed for printing)
- An MQTT broker (optional — needed for cloud printing)
- An ESP32 microcontroller (optional — needed for cloud printing)

---

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/your-username/restaurant-pos.git
cd restaurant-pos
```

### 2. Install Dependencies

```bash
npm install          # root dependencies
cd server && npm install && cd ..
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your database credentials and other settings. See [CONFIGURATION.md](CONFIGURATION.md) for details.

### 4. Configure Restaurant Info

Edit [`config/restaurant.json`](config/restaurant.json) with your restaurant's name, address, phone, and receipt footer text.

### 5. Set Up the Database

Create your database, then start the server — the schema is created automatically on first startup:

```bash
# MySQL example
mysql -u root -p -e "CREATE DATABASE restaurant_pos;"
```

### 6. Start the Server

```bash
npm start
# Server runs on http://localhost:3000
```

### 7. Open the App

Navigate to `http://localhost:3000` in your browser.

### 8. Create Admin Account

On first launch, you'll see a **"Set Up Admin"** form on the login page. Create your admin account.

### 9. Add Your Menu

Go to **Menu Management** → Add items manually, or upload a CSV/XLSX file.  
Alternatively, edit and run `scripts/update_menu.js`.

### 10. Configure Printer (Optional)

Go to **Settings** → enter your printer's IP address and select your paper width (80mm or 58mm).  
Flash the ESP32 bridge sketch (see [Printing](#printing) below).

---

## Project Structure

```
restaurant-pos/
├── client/                  # Frontend (HTML, CSS, JS)
│   ├── assets/              # Logo, images (place your own here)
│   ├── css/style.css        # All styles
│   ├── js/api.js            # Shared API helpers and sidebar
│   └── *.html               # Application pages
├── config/
│   ├── restaurant.json      # Restaurant identity (name, address, phone)
│   └── printer.json         # Printer defaults
├── server/                  # Backend (Node.js + Express)
│   ├── db/connection.js     # DB pool + schema init
│   ├── middleware/          # Auth middleware
│   └── routes/              # API route handlers
├── scripts/                 # Utility scripts (menu seed, db flush, etc.)
├── ESP32_Cloud_Printer/     # Arduino sketch for print bridge
├── .env.example             # Environment variable template
└── vercel.json              # Vercel deployment config
```

---

## Printing

The POS uses a **MQTT → ESP32 → TCP 9100** architecture for wireless cloud printing:

```
POS Server (Vercel/localhost)
        │
        │  MQTT (TLS 8883)
        ▼
  MQTT Broker (any — HiveMQ, Mosquitto, EMQX, etc.)
        │
        │  MQTT subscription
        ▼
   ESP32 (on your local network)
        │
        │  TCP port 9100 (RAW ESC/POS)
        ▼
  ESC/POS Thermal Printer
```

### Supported Printers

Any printer that accepts raw ESC/POS bytes over TCP port 9100, including:

- Epson TM series (TM-T20, TM-T82, TM-T88)
- Star TSP series
- Xprinter XP series
- TVS RP series
- Bixolon SRP series
- Citizen CT-S series
- Any generic ESC/POS thermal printer with network (Wi-Fi/Ethernet) connectivity

### Paper Widths

| Setting | Chars/Line | Common Use |
|---------|-----------|-----------|
| 80mm | 48 | Standard restaurant receipts |
| 58mm | 32 | Compact desktop printers |

### ESP32 Setup

1. Install [Arduino IDE](https://www.arduino.cc/en/software) with the ESP32 board package
2. Install the **PubSubClient** library (Sketch → Include Library → Manage Libraries)
3. Open `ESP32_Cloud_Printer/ESP32_Cloud_Printer.ino`
4. Fill in your **Wi-Fi credentials**, **MQTT broker details**, and **printer IP** in sections 1, 2, and 3
5. Flash to your ESP32
6. Monitor Serial at 115200 baud to confirm connection

---

## Configuration

See **[CONFIGURATION.md](CONFIGURATION.md)** for a detailed guide on all configuration options.

---

## Deployment

The project includes a `vercel.json` for Vercel deployment (backend as serverless functions, frontend as static files).

```bash
vercel deploy
```

Set all `.env` variables as **Vercel Environment Variables** in the project dashboard.

---

## License

MIT — free to use, modify, and distribute.