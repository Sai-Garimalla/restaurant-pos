// ======================================================
//  ESP32 RESTAURANT POS PRINT BRIDGE
//  Cloud Printer via MQTT + TCP (ESC/POS)
// ======================================================
//
//  Compatible with any ESC/POS-compatible thermal printer
//  that accepts raw TCP connections on port 9100.
//  Examples: Epson TM series, Star TSP series, Xprinter,
//            TVS RP series, Bixolon, Citizen, and others.
//
//  Libraries (install via Arduino Library Manager):
//    - PubSubClient  by Nick O'Leary  (v2.8+)
//    - WiFiClientSecure  (built into ESP32 Arduino core)
//
//  DATA FLOW:
//    POS Server --> MQTT Broker --> ESP32 (this) --> Thermal Printer (TCP 9100)
//
//  TOPIC FORMAT:
//    restaurant/printer/<printerIP>
//    The printer IP is extracted from the topic at runtime,
//    so multiple printers are supported automatically.
//
//  SETUP:
//    1. Configure sections 1, 2, and 3 below.
//    2. Flash to your ESP32.
//    3. Open Serial Monitor at 115200 baud to see connection status.
// ======================================================

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>


// ======================================================
// 1. RESTAURANT WI-FI
//    Set to your restaurant's Wi-Fi network credentials.
// ======================================================

const char* ssid     = "YOUR_WIFI_SSID";       // TODO: Replace with your Wi-Fi network name
const char* password = "YOUR_WIFI_PASSWORD";   // TODO: Replace with your Wi-Fi password


// ======================================================
// 2. MQTT BROKER  (must match server/.env MQTT_* values)
//    Supports any MQTT broker with TLS on port 8883.
//    Popular options: HiveMQ Cloud (free tier), Mosquitto, EMQX
// ======================================================

const char* mqtt_server = "YOUR_MQTT_HOST";    // TODO: Replace with your MQTT broker host
const int   mqtt_port   = 8883;                // TLS port — change to 1883 for non-TLS brokers
const char* mqtt_user   = "YOUR_MQTT_USER";    // TODO: Replace with your MQTT username
const char* mqtt_pass   = "YOUR_MQTT_PASS";    // TODO: Replace with your MQTT password


// ======================================================
// 3. PRINTER
//    Default printer IP. This is also parsed dynamically
//    from the MQTT topic, so multiple printers are
//    supported automatically.
//    Port 9100 = standard RAW/ESC-POS TCP port.
// ======================================================

const char* printerIP   = "0.0.0.0";          // TODO: Replace with your printer's static IP
const int   printerPort = 9100;


// ======================================================
// MQTT BUFFER
//  8192 bytes handles full ESC/POS receipt + KOT + checklist.
//  Increase to 16384 if prints are being truncated.
// ======================================================

#define MQTT_BUFFER_SIZE 8192


// ======================================================
// RECONNECT THROTTLE (ms)
// ======================================================

#define WIFI_RECONNECT_MS  5000
#define MQTT_RECONNECT_MS  5000


// ======================================================
// CLIENTS
// ======================================================

WiFiClientSecure secureClient;
PubSubClient     mqtt(secureClient);
WiFiClient       printerClient;

unsigned long lastWifiAttempt = 0;
unsigned long lastMqttAttempt = 0;


// ======================================================
// Wi-Fi SETUP
// ======================================================

void setup_wifi() {
  Serial.println();
  Serial.println("======================================");
  Serial.println("   ESP32  RESTAURANT POS PRINT BRIDGE");
  Serial.println("======================================");

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  Serial.print("Connecting to Wi-Fi '");
  Serial.print(ssid);
  Serial.print("'");

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (millis() - t0 > 30000) {        // 30 s timeout
      Serial.println();
      Serial.println("  [WARN] Wi-Fi timeout — will retry in loop.");
      return;
    }
  }

  Serial.println();
  Serial.println("  [OK] Wi-Fi connected!");
  Serial.print  ("  IP      : "); Serial.println(WiFi.localIP());
  Serial.print  ("  Gateway : "); Serial.println(WiFi.gatewayIP());
  Serial.print  ("  Signal  : "); Serial.print(WiFi.RSSI()); Serial.println(" dBm");
  Serial.println();
}


// ======================================================
// MQTT CALLBACK
//  Called automatically by mqtt.loop() when a message
//  arrives on  restaurant/printer/<ip>
// ======================================================

void callback(char* topic, byte* payload, unsigned int length) {

  Serial.println();
  Serial.println("======================================");
  Serial.println("  [MQTT] PRINT JOB RECEIVED");
  Serial.print  ("  Topic  : "); Serial.println(topic);
  Serial.print  ("  Size   : "); Serial.print(length); Serial.println(" bytes");

  // --- Parse target printer IP from topic ---
  // topic = "restaurant/printer/192.168.1.x"
  String topicStr = String(topic);
  int    slash    = topicStr.lastIndexOf('/');
  String targetIP = (slash >= 0) ? topicStr.substring(slash + 1) : "";

  if (targetIP.length() == 0) {
    Serial.println("  [ERR] Cannot parse printer IP from topic. Abort.");
    return;
  }

  Serial.print("  Printer : "); Serial.print(targetIP);
  Serial.print(":"); Serial.println(printerPort);

  // --- Connect to printer over TCP ---
  printerClient.stop();
  printerClient.setTimeout(4000);      // 4 s TCP connect timeout

  Serial.println("  Connecting to printer...");

  if (!printerClient.connect(targetIP.c_str(), printerPort)) {
    Serial.println("  [ERR] PRINTER CONNECTION FAILED");
    Serial.println("  Check:");
    Serial.print  ("    1. Printer is ON and at IP "); Serial.println(targetIP);
    Serial.println("    2. Printer is on the same Wi-Fi network");
    Serial.println("    3. Port 9100 is enabled on the printer");
    Serial.println("    4. ESP32 and printer are on the same subnet");
    printerClient.stop();
    return;
  }

  Serial.println("  [OK] Connected to printer!");

  // --- Send raw ESC/POS bytes ---
  size_t sent = printerClient.write(payload, length);
  printerClient.flush();

  Serial.print("  Sent: ");
  Serial.print(sent); Serial.print(" / ");
  Serial.print(length); Serial.println(" bytes");

  if (sent == length) {
    Serial.println("  [OK] Receipt sent successfully!");
  } else {
    Serial.println("  [WARN] Partial send — receipt may be truncated.");
  }

  delay(500);              // Let printer drain its buffer before disconnect
  printerClient.stop();
  Serial.println("  Printer disconnected.");
  Serial.println("======================================");
}


// ======================================================
// MQTT RECONNECT  (non-blocking — throttled by millis)
// ======================================================

void reconnect_mqtt() {
  unsigned long now = millis();
  if (now - lastMqttAttempt < MQTT_RECONNECT_MS) return;
  lastMqttAttempt = now;

  Serial.println();
  Serial.print("Connecting to MQTT broker: ");
  Serial.println(mqtt_server);

  // Unique client ID from chip MAC so multiple ESP32s can coexist
  String clientId = "ESP32_POS_Printer_";
  clientId += String((uint32_t)ESP.getEfuseMac(), HEX);

  if (mqtt.connect(clientId.c_str(), mqtt_user, mqtt_pass)) {

    Serial.println("  [OK] MQTT connected!");

    // QoS 1 — broker buffers message if ESP32 briefly disconnects
    if (mqtt.subscribe("restaurant/printer/+", 1)) {
      Serial.println("  Subscribed: restaurant/printer/+  [QoS 1]");
    } else {
      Serial.println("  [ERR] Subscribe failed!");
    }

  } else {
    int rc = mqtt.state();
    Serial.print("  [ERR] MQTT failed, rc="); Serial.println(rc);
    switch (rc) {
      case -4: Serial.println("  -> CONNECTION_TIMEOUT");       break;
      case -3: Serial.println("  -> CONNECTION_LOST");          break;
      case -2: Serial.println("  -> CONNECT_FAILED");           break;
      case -1: Serial.println("  -> DISCONNECTED");             break;
      case  1: Serial.println("  -> BAD_PROTOCOL");             break;
      case  2: Serial.println("  -> BAD_CLIENT_ID");            break;
      case  3: Serial.println("  -> UNAVAILABLE");              break;
      case  4: Serial.println("  -> BAD_CREDENTIALS — check MQTT_USER/MQTT_PASS"); break;
      case  5: Serial.println("  -> UNAUTHORIZED");             break;
      default: Serial.println("  -> UNKNOWN");                  break;
    }
    Serial.print("  Retry in ");
    Serial.print(MQTT_RECONNECT_MS / 1000);
    Serial.println("s ...");
  }
}


// ======================================================
// SETUP
// ======================================================

void setup() {
  Serial.begin(115200);
  delay(1000);

  setup_wifi();

  // Skip TLS certificate verification (fine for most MQTT setups).
  // For production hardening: embed your broker's root CA + call setCACert().
  secureClient.setInsecure();

  mqtt.setServer(mqtt_server, mqtt_port);
  mqtt.setCallback(callback);
  mqtt.setBufferSize(MQTT_BUFFER_SIZE);   // Must be set BEFORE first connect
  mqtt.setKeepAlive(60);                  // PING broker every 60 s
  mqtt.setSocketTimeout(10);             // Socket timeout 10 s

  Serial.println("======================================");
  Serial.println("  [OK] ESP32 setup complete.");
  Serial.println("======================================");
  Serial.print  ("  MQTT host    : "); Serial.println(mqtt_server);
  Serial.print  ("  MQTT user    : "); Serial.println(mqtt_user);
  Serial.print  ("  MQTT port    : "); Serial.println(mqtt_port);
  Serial.print  ("  Buffer       : "); Serial.print(MQTT_BUFFER_SIZE); Serial.println(" bytes");
  Serial.print  ("  Printer IP   : "); Serial.println(printerIP);
  Serial.print  ("  Printer port : "); Serial.println(printerPort);
  Serial.println("======================================");
}


// ======================================================
// LOOP
// ======================================================

void loop() {

  // --- Wi-Fi watchdog ---
  if (WiFi.status() != WL_CONNECTED) {
    unsigned long now = millis();
    if (now - lastWifiAttempt > WIFI_RECONNECT_MS) {
      lastWifiAttempt = now;
      Serial.println("[WARN] Wi-Fi lost. Reconnecting...");
      WiFi.disconnect();
      WiFi.begin(ssid, password);
    }
    return;   // Wait for Wi-Fi before touching MQTT
  }

  // --- MQTT watchdog ---
  if (!mqtt.connected()) {
    reconnect_mqtt();
    return;   // Don't call mqtt.loop() while disconnected
  }

  // --- Keep connection alive & dispatch incoming print jobs ---
  mqtt.loop();
}
