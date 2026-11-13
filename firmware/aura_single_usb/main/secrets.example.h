/*
 * Copy this file to secrets.h (git-ignored) and fill in your values.
 *
 *   WIFI_SSID / WIFI_PASS   2.4 GHz Wi-Fi the ESP32-S3 joins (same LAN as the assistant)
 *   SERVER_URI              wss://<LAN IP of the PC running professor-assistant>:<port of DEVICE_ADDR>/device
 *   SERVER_CERT_NAME        a name you passed to `devicectl server-cert --host`, e.g. voice-assistant.local;
 *                           the certificate is checked against this name, the connection goes to the IP
 *   DEVICE_ID / DEVICE_SECRET_HEX   from `devicectl add --id aura-esp32-01` (the secret is printed once)
 *   DEVICE_LANGUAGE         en | hi | hinglish | auto
 *   DEVICE_MODE             general | documents | web | auto
 */
#pragma once

#define WIFI_SSID          "YOUR_WIFI_SSID"
#define WIFI_PASS          "YOUR_WIFI_PASSWORD"
#define SERVER_URI         "wss://192.168.1.43:8443/device"
#define SERVER_CERT_NAME   "voice-assistant.local"
#define DEVICE_ID          "aura-esp32-01"
#define DEVICE_SECRET_HEX  "0000000000000000000000000000000000000000000000000000000000000000"
#define DEVICE_LANGUAGE    "auto"
#define DEVICE_MODE        "auto"
