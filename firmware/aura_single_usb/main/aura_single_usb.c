/*
 * AURA desk device — ESP32-S3 (N16R8) firmware for the Professor Voice Assistant.
 *
 * Audio path (USB cable to the PC, see pc_usb_audio_bridge.py):
 *   PC microphone --bridge--> USB "speaker" endpoint --> ESP32-S3 (AFE + "Hi ESP" wake word)
 *   server reply   <-- WSS --  ESP32-S3 --> USB "microphone" endpoint --bridge--> PC speaker
 *
 * Network path: Wi-Fi + WSS to the assistant's device listener, speaking device
 * protocol v1 (docs/DEVICE_PROTOCOL.md):
 *   TLS (server certificate signed by the local CA, name checked)
 *   -> challenge / hello with HMAC-SHA256(secret, "VAP1-AUTH\n" id "\n" nonce) -> ready
 *   -> utterance_start, VAP1 kind-1 frames, utterance_end{frames}
 *   <- stt_result, tts_start, VAP1 kind-5 frames, tts_end, turn_complete
 *
 * Wi-Fi credentials, server address, device id and secret live in secrets.h
 * (copy secrets.example.h). The CA certificate is main/certs/ca.crt
 * (devicectl init-ca writes it to data/device-tls/ca.crt).
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/ringbuf.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_heap_caps.h"
#include "mbedtls/md.h"

#include "usb_device_uac.h"
#include "esp_websocket_client.h"
#include "esp_wn_iface.h"
#include "esp_wn_models.h"
#include "esp_afe_sr_iface.h"
#include "esp_afe_sr_models.h"
#include "model_path.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#pragma message("main/secrets.h not found: building with placeholder values from secrets.example.h")
#include "secrets.example.h"
#endif

static const char *TAG = "AURA";

#define FIRMWARE_VERSION      "aura-2.0.0"
// 1 = PC mic -> ESP -> PC speaker loopback, no Wi-Fi/AFE (USB bring-up test)
#define BRINGUP_USB_LOOPBACK  0

/* ---- audio / protocol constants (must match the server, see internal/device) ---- */
#define SAMPLE_RATE           16000
#define BYTES_PER_MS          32                       // 16 kHz * 2 bytes
#define VAP1_HEADER           16
#define KIND_MIC_PCM          1                        // device -> server
#define KIND_SPK_PCM          5                        // server -> device
#define MAX_FRAME_BYTES       8192
#define PLAYBACK_BUFFER_MS    1000                     // declared in hello; server caps lead_ms below it
#define RB_SIZE               (128 * 1024)             // 4 s of 16 kHz PCM per direction
#define TTS_HOLD_US           (600 * 1000)             // ignore the mic this long after the reply has played
#define MAX_SILENCE_FRAMES    45                       // ~1.4 s of AFE frames (32 ms each)
#define MAX_UTTERANCE_US      (15 * 1000 * 1000)       // server allows up to VOICE_MAX_RECORDING_SECONDS
#define PENDING_FRAME_MAX     2048                     // one AFE fetch (512 samples = 1024 bytes) fits
#define MAX_PENDING           32                       // ~1 s of audio while waiting for audio_start

extern const char ca_crt_start[] asm("_binary_ca_crt_start");

static RingbufHandle_t rb_pc_to_esp = NULL;   // PC mic        -> ESP (AFE input)
static RingbufHandle_t rb_esp_to_pc = NULL;   // server reply  -> ESP -> PC speaker

static esp_afe_sr_iface_t *afe_handle = NULL;
static esp_afe_sr_data_t  *afe_data   = NULL;
static esp_websocket_client_handle_t ws_client = NULL;
static bool s_ws_started = false;

/* session state (written by the websocket task, read by the AFE task) */
static volatile bool     s_ready = false;          // authenticated: "ready" received
static volatile uint32_t s_lead_bytes = 200 * BYTES_PER_MS;
/* uplink turn state (AFE task) */
static volatile bool     s_streaming = false;
static volatile uint32_t s_audio_ok_turn = 0;      // turn the server accepted (audio_start)
static volatile uint32_t s_turn = 0;               // last turn id used (ids increase per connection)
static uint32_t          s_seq = 0;
static int64_t           s_turn_started_us = 0;
/* downlink playback state */
static volatile uint32_t s_play_turn = 0;          // turn whose audio we accept
static volatile bool     s_tts_active = false;     // between tts_start and tts_end
static volatile bool     s_tts_ended = false;      // play out the rest even below the lead
static volatile int64_t  s_mute_until_us = 0;
static volatile bool     s_playing = false;
static volatile uint32_t s_underruns = 0;

/* ---------------- helpers ---------------- */

static void put_be16(uint8_t *p, uint16_t v) { p[0] = v >> 8; p[1] = v; }
static void put_be32(uint8_t *p, uint32_t v) { p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v; }
static uint32_t get_be32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Find "key":"value" in a compact JSON object (the server uses Go's encoding/json:
 * no spaces). Returns false when absent or too long. */
static bool json_str(const char *js, const char *key, char *out, size_t cap) {
    char pat[40];
    snprintf(pat, sizeof(pat), "\"%s\":\"", key);
    const char *p = strstr(js, pat);
    if (!p) return false;
    p += strlen(pat);
    size_t n = 0;
    while (p[n] && p[n] != '"') {
        if (n + 1 >= cap) return false;
        out[n] = p[n];
        n++;
    }
    out[n] = 0;
    return p[n] == '"';
}

static uint32_t json_u32(const char *js, const char *key, uint32_t dflt) {
    char pat[40];
    snprintf(pat, sizeof(pat), "\"%s\":", key);
    const char *p = strstr(js, pat);
    if (!p) return dflt;
    return (uint32_t)strtoul(p + strlen(pat), NULL, 10);
}

static void ws_send_text(const char *s) {
    if (ws_client && esp_websocket_client_is_connected(ws_client)) {
        esp_websocket_client_send_text(ws_client, s, strlen(s), pdMS_TO_TICKS(200));
    }
}

/* mac = hex(HMAC-SHA256(secret, "VAP1-AUTH\n" + device_id + "\n" + nonce)) */
static bool device_mac(const char *nonce, char out_hex[65]) {
    const char *sh = DEVICE_SECRET_HEX;
    size_t hl = strlen(sh);
    if (hl < 64 || hl % 2 != 0 || hl > 128) {
        ESP_LOGE(TAG, "DEVICE_SECRET_HEX must be the 64-hex secret printed by devicectl add");
        return false;
    }
    uint8_t key[64];
    for (size_t i = 0; i < hl / 2; i++) {
        int a = hexval(sh[2 * i]), b = hexval(sh[2 * i + 1]);
        if (a < 0 || b < 0) return false;
        key[i] = (uint8_t)(a << 4 | b);
    }
    char msg[160];
    int ml = snprintf(msg, sizeof(msg), "VAP1-AUTH\n%s\n%s", DEVICE_ID, nonce);
    if (ml <= 0 || ml >= (int)sizeof(msg)) return false;
    uint8_t mac[32];
    if (mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, hl / 2,
                        (const uint8_t *)msg, ml, mac) != 0) return false;
    for (int i = 0; i < 32; i++) sprintf(out_hex + 2 * i, "%02x", mac[i]);
    out_hex[64] = 0;
    return true;
}

static void flush_playback(void) {
    size_t n;
    void *it;
    while ((it = xRingbufferReceiveUpTo(rb_esp_to_pc, &n, 0, RB_SIZE)) != NULL) vRingbufferReturnItem(rb_esp_to_pc, it);
    s_playing = false;
}

static size_t playback_fill(void) { return RB_SIZE - xRingbufferGetCurFreeSize(rb_esp_to_pc); }

/* ---------------- USB audio callbacks ---------------- */

// Host -> device: PC microphone audio (USB "speaker" endpoint)
static esp_err_t uac_out_cb(uint8_t *buf, size_t len, void *arg) {
#if BRINGUP_USB_LOOPBACK
    if (rb_esp_to_pc) xRingbufferSend(rb_esp_to_pc, buf, len, 0);
#else
    if (rb_pc_to_esp) xRingbufferSend(rb_pc_to_esp, buf, len, 0);
#endif
    return ESP_OK;
}

// Device -> host: server reply to the PC speaker (USB "microphone" endpoint)
static esp_err_t uac_in_cb(uint8_t *buf, size_t len, size_t *bytes_read, void *arg) {
    *bytes_read = len;
    memset(buf, 0, len);
    if (!rb_esp_to_pc) return ESP_OK;
    if (!s_playing) {
        size_t fill = playback_fill();
#if BRINGUP_USB_LOOPBACK
        if (fill < 80 * BYTES_PER_MS) return ESP_OK;
#else
        // contract: start once lead_ms is buffered, or at once after tts_end
        if (fill == 0 || (fill < s_lead_bytes && !s_tts_ended)) return ESP_OK;
#endif
        s_playing = true;
    }
    size_t total = 0;
    while (total < len) {
        size_t n = 0;
        uint8_t *it = (uint8_t *)xRingbufferReceiveUpTo(rb_esp_to_pc, &n, 0, len - total);
        if (!it) break;
        memcpy(buf + total, it, n);
        vRingbufferReturnItem(rb_esp_to_pc, it);
        total += n;
    }
    if (total < len) {                 // empty: re-buffer before playing again
        s_playing = false;
        if (s_tts_active && !s_tts_ended) s_underruns++;
    }
    return ESP_OK;
}

static void uac_mute_cb(uint32_t mute, void *arg) {}
static void uac_vol_cb(uint32_t vol, void *arg) {}

/* ---------------- device protocol: control messages ---------------- */

static void handle_control(const char *js) {
    char type[24];
    if (!json_str(js, "type", type, sizeof(type))) return;
    uint32_t turn = json_u32(js, "turn_id", 0);

    if (strcmp(type, "challenge") == 0) {
        static char hello[512];
        char nonce[80], mac[65];
        if (!json_str(js, "nonce", nonce, sizeof(nonce)) || !device_mac(nonce, mac)) {
            ESP_LOGE(TAG, "cannot answer the challenge (check DEVICE_SECRET_HEX)");
            return;
        }
        snprintf(hello, sizeof(hello),
                 "{\"type\":\"hello\",\"v\":1,\"device_id\":\"%s\",\"firmware\":\"%s\",\"mac\":\"%s\","
                 "\"codecs\":[{\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1}],"
                 "\"playback_buffer_ms\":%d}",
                 DEVICE_ID, FIRMWARE_VERSION, mac, PLAYBACK_BUFFER_MS);
        ws_send_text(hello);
    } else if (strcmp(type, "ready") == 0) {
        uint32_t lead_ms = json_u32(js, "lead_ms", 200);
        s_lead_bytes = lead_ms * BYTES_PER_MS;
        s_turn = 0;                       // turn ids restart with every session
        s_ready = true;
        ESP_LOGI(TAG, "Authenticated as %s (lead %" PRIu32 " ms). Say \"Hi ESP\".", DEVICE_ID, lead_ms);
    } else if (strcmp(type, "audio_start") == 0) {
        s_audio_ok_turn = turn;           // the AFE task may now send this turn's frames
        ESP_LOGI(TAG, "turn %" PRIu32 ": recording", turn);
    } else if (strcmp(type, "stt_result") == 0) {
        char text[200];
        if (json_str(js, "text", text, sizeof(text))) ESP_LOGI(TAG, "heard: %s", text);
    } else if (strcmp(type, "tts_start") == 0) {
        flush_playback();                 // new reply: drop anything left from an older one
        s_play_turn = turn;
        s_tts_ended = false;
        s_tts_active = true;
        s_underruns = 0;
    } else if (strcmp(type, "tts_end") == 0) {
        if (turn == s_play_turn) {
            s_tts_ended = true;
            s_tts_active = false;
            // keep the mic closed until the buffered reply has played on the PC speaker
            s_mute_until_us = esp_timer_get_time() + (int64_t)playback_fill() / BYTES_PER_MS * 1000 + TTS_HOLD_US;
            if (s_underruns) {
                char st[128];
                snprintf(st, sizeof(st), "{\"type\":\"playback_state\",\"turn_id\":%" PRIu32 ",\"state\":\"underrun\",\"buffered_ms\":0,\"underruns\":%" PRIu32 "}",
                         turn, s_underruns);
                ws_send_text(st);
            }
        }
    } else if (strcmp(type, "turn_complete") == 0) {
        ESP_LOGI(TAG, "turn %" PRIu32 " complete", turn);
    } else if (strcmp(type, "error") == 0) {
        char code[32] = "", msg[120] = "";
        json_str(js, "code", code, sizeof(code));
        json_str(js, "message", msg, sizeof(msg));
        ESP_LOGW(TAG, "server error (turn %" PRIu32 "): %s %s", turn, code, msg);
        if (turn != 0 && turn == s_turn) s_streaming = false;   // this turn is over; wait for the next wake word
    }
}

/* ---------------- WebSocket ---------------- */

static void ws_event_handler(void *args, esp_event_base_t base, int32_t id, void *event_data) {
    esp_websocket_event_data_t *d = (esp_websocket_event_data_t *)event_data;
    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "TLS connected; waiting for the challenge");
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
        s_ready = false;
        s_streaming = false;
        s_tts_active = false;
        s_tts_ended = true;               // let any buffered audio play out
        ESP_LOGW(TAG, "disconnected from the assistant; reconnecting");
        break;
    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGE(TAG, "websocket error (tls err 0x%x, cert flags 0x%x, handshake %d)",
                 (unsigned)d->error_handle.esp_tls_last_esp_err, (unsigned)d->error_handle.esp_tls_cert_verify_flags,
                 d->error_handle.esp_ws_handshake_status_code);
        break;
    case WEBSOCKET_EVENT_DATA:
        // Only whole messages that fit the receive buffer are used (all control messages
        // we act on and every audio frame do; long stt_result/metrics may be fragmented).
        if (d->payload_offset != 0 || d->data_len != d->payload_len || d->data_len <= 0) break;
        if (d->op_code == 0x02) {                                         // VAP1 audio
            const uint8_t *b = (const uint8_t *)d->data_ptr;
            if (d->data_len <= VAP1_HEADER || memcmp(b, "VAP1", 4) != 0 || b[4] != 1 || b[5] != KIND_SPK_PCM) break;
            if (get_be32(b + 8) != s_play_turn || !s_tts_active) break;   // stale frame of an older turn
            xRingbufferSend(rb_esp_to_pc, b + VAP1_HEADER, d->data_len - VAP1_HEADER, 0);
        } else if (d->op_code == 0x01) {                                  // JSON control
            static char msg[1024];                                        // websocket task only
            if (d->data_len >= (int)sizeof(msg)) break;
            memcpy(msg, d->data_ptr, d->data_len);
            msg[d->data_len] = 0;
            handle_control(msg);
        }
        break;
    default:
        break;
    }
}

/* ---------------- AFE: feed + detect + stream ---------------- */

static void afe_feed_task(void *arg) {
    int chunk = afe_handle->get_feed_chunksize(afe_data);
    int nch   = afe_handle->get_channel_num(afe_data);
    size_t chunk_bytes = chunk * nch * sizeof(int16_t);
    uint8_t *buf = heap_caps_malloc(chunk_bytes, MALLOC_CAP_SPIRAM);
    if (!buf) { ESP_LOGE(TAG, "feed buf alloc failed"); vTaskDelete(NULL); }

    while (1) {
        size_t got = 0;
        while (got < chunk_bytes) {
            size_t n = 0;
            uint8_t *it = (uint8_t *)xRingbufferReceiveUpTo(rb_pc_to_esp, &n, pdMS_TO_TICKS(50), chunk_bytes - got);
            if (it) {
                memcpy(buf + got, it, n);
                got += n;
                vRingbufferReturnItem(rb_pc_to_esp, it);
            }
        }
        afe_handle->feed(afe_data, (int16_t *)buf);
    }
}

static void end_utterance(const char *why) {
    char e[96];
    if (s_seq == 0)   // nothing reached the server: cancel the turn instead of sending an empty one
        snprintf(e, sizeof(e), "{\"type\":\"abort\",\"turn_id\":%" PRIu32 "}", s_turn);
    else
        snprintf(e, sizeof(e), "{\"type\":\"utterance_end\",\"turn_id\":%" PRIu32 ",\"frames\":%" PRIu32 "}", s_turn, s_seq);
    ws_send_text(e);
    s_streaming = false;
    ESP_LOGI(TAG, "turn %" PRIu32 ": %" PRIu32 " frames sent (%s)", s_turn, s_seq, why);
}

static void afe_detect_task(void *arg) {
    static uint8_t frame[VAP1_HEADER + MAX_FRAME_BYTES];
    memcpy(frame, "VAP1", 4);
    frame[4] = 1;                       // version
    frame[5] = KIND_MIC_PCM;
    put_be16(frame + 6, 0);             // flags
    int silence_frames = 0;
    uint8_t *pending = heap_caps_malloc((size_t)MAX_PENDING * PENDING_FRAME_MAX, MALLOC_CAP_SPIRAM);
    int pending_len[MAX_PENDING];
    int n_pending = 0;
    if (!pending) { ESP_LOGE(TAG, "pending buffer alloc failed"); vTaskDelete(NULL); }

    while (1) {
        afe_fetch_result_t *res = afe_handle->fetch(afe_data);
        if (!res || res->ret_value == ESP_FAIL) continue;

        bool muted = s_tts_active || esp_timer_get_time() < s_mute_until_us;
        if (muted) {                    // the PC mic hears the reply: ignore it
            if (s_streaming) end_utterance("reply started");
            continue;
        }
        if (!s_ready) { s_streaming = false; continue; }

        if (res->wakeup_state == WAKENET_DETECTED && !s_streaming) {
            s_turn++;
            s_seq = 0;
            n_pending = 0;
            silence_frames = 0;
            s_turn_started_us = esp_timer_get_time();
            char s[220];
            snprintf(s, sizeof(s),
                     "{\"type\":\"utterance_start\",\"turn_id\":%" PRIu32 ",\"codec\":{\"format\":\"pcm_s16le\","
                     "\"sample_rate\":16000,\"channels\":1},\"language\":\"%s\",\"mode\":\"%s\"}",
                     s_turn, DEVICE_LANGUAGE, DEVICE_MODE);
            ws_send_text(s);
            s_streaming = true;
            ESP_LOGI(TAG, "Wake word: turn %" PRIu32 " started", s_turn);
            continue;
        }

        if (s_streaming) {
            int len = res->data_size;
            if (len <= 0 || len > PENDING_FRAME_MAX || (len & 1)) continue;
            // Contract: stream only after audio_start. Frames captured while waiting
            // (one network round trip, usually 1-3 frames) are queued, not lost.
            if (n_pending < MAX_PENDING) {
                memcpy(pending + (size_t)n_pending * PENDING_FRAME_MAX, res->data, len);
                pending_len[n_pending++] = len;
            } else {
                ESP_LOGW(TAG, "turn %" PRIu32 ": no audio_start from the server; abandoned", s_turn);
                end_utterance("no audio_start");
                continue;
            }
            if (s_audio_ok_turn == s_turn) {
                for (int i = 0; i < n_pending && s_streaming; i++) {
                    put_be32(frame + 8, s_turn);
                    put_be32(frame + 12, s_seq);
                    memcpy(frame + VAP1_HEADER, pending + (size_t)i * PENDING_FRAME_MAX, pending_len[i]);
                    if (esp_websocket_client_send_bin(ws_client, (const char *)frame, VAP1_HEADER + pending_len[i], pdMS_TO_TICKS(100)) < 0) {
                        ESP_LOGW(TAG, "audio frame not sent; turn %" PRIu32 " abandoned", s_turn);
                        s_streaming = false;    // the server reports "frames lost" or a timeout
                        break;
                    }
                    s_seq++;
                }
                n_pending = 0;
                if (!s_streaming) continue;
            }
            if (res->vad_state == AFE_VAD_SILENCE) {
                if (++silence_frames > MAX_SILENCE_FRAMES) end_utterance("end of speech");
            } else {
                silence_frames = 0;
            }
            if (s_streaming && esp_timer_get_time() - s_turn_started_us > MAX_UTTERANCE_US) end_utterance("maximum length");
        }
    }
}

/* ---------------- Wi-Fi ---------------- */

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *ev = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "Wi-Fi up, IP " IPSTR "; connecting to %s", IP2STR(&ev->ip_info.ip), SERVER_URI);
        if (!s_ws_started) { esp_websocket_client_start(ws_client); s_ws_started = true; }
    }
}

static void init_wifi_and_ws(void) {
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    esp_websocket_client_config_t ws_cfg = {
        .uri = SERVER_URI,                       // wss://<server LAN IP>:8443/device
        .cert_pem = ca_crt_start,                // trust only the assistant's local CA
        .cert_common_name = SERVER_CERT_NAME,    // must be one of the devicectl server-cert --host names
        .buffer_size = 4096,
        .reconnect_timeout_ms = 3000,
        .network_timeout_ms = 10000,
        .ping_interval_sec = 10,
        .pingpong_timeout_sec = 30,
        .task_stack = 8 * 1024,                  // TLS + HMAC + JSON in the event handler
    };
    ws_client = esp_websocket_client_init(&ws_cfg);
    esp_websocket_register_events(ws_client, WEBSOCKET_EVENT_ANY, ws_event_handler, NULL);

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL));

    wifi_config_t wc = { 0 };
    strlcpy((char *)wc.sta.ssid, WIFI_SSID, sizeof(wc.sta.ssid));
    strlcpy((char *)wc.sta.password, WIFI_PASS, sizeof(wc.sta.password));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());
    esp_wifi_set_ps(WIFI_PS_NONE);
}

/* ---------------- main ---------------- */

void app_main(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    rb_pc_to_esp = xRingbufferCreateWithCaps(RB_SIZE, RINGBUF_TYPE_BYTEBUF, MALLOC_CAP_SPIRAM);
    rb_esp_to_pc = xRingbufferCreateWithCaps(RB_SIZE, RINGBUF_TYPE_BYTEBUF, MALLOC_CAP_SPIRAM);
    if (!rb_pc_to_esp || !rb_esp_to_pc) { ESP_LOGE(TAG, "ringbuf alloc failed (PSRAM?)"); return; }

    uac_device_config_t uac_cfg = {
        .output_cb = uac_out_cb,
        .input_cb = uac_in_cb,
        .set_mute_cb = uac_mute_cb,
        .set_volume_cb = uac_vol_cb,
        .cb_ctx = NULL,
    };
    ESP_ERROR_CHECK(uac_device_init(&uac_cfg));

#if BRINGUP_USB_LOOPBACK
    ESP_LOGI(TAG, "USB loopback mode: PC mic is played back on the PC speaker");
    return;
#endif

    srmodel_list_t *models = esp_srmodel_init("model");
    if (!models || models->num == 0) { ESP_LOGE(TAG, "No models in 'model' partition"); return; }

    afe_handle = (esp_afe_sr_iface_t *)&ESP_AFE_SR_HANDLE;
    afe_config_t afe_cfg = AFE_CONFIG_DEFAULT();
    afe_cfg.wakenet_model_name = esp_srmodel_filter(models, ESP_WN_PREFIX, NULL);
    if (!afe_cfg.wakenet_model_name) { ESP_LOGE(TAG, "WakeNet model not found"); return; }
    afe_cfg.aec_init = false;
    afe_cfg.pcm_config.total_ch_num = 1;
    afe_cfg.pcm_config.mic_num = 1;
    afe_cfg.pcm_config.ref_num = 0;
    afe_cfg.memory_alloc_mode = AFE_MEMORY_ALLOC_MORE_PSRAM;
    afe_data = afe_handle->create_from_config(&afe_cfg);

    if (strncmp(ca_crt_start, "-----BEGIN CERTIFICATE-----", 27) != 0) {
        ESP_LOGE(TAG, "main/certs/ca.crt is missing: copy data/device-tls/ca.crt from the server and rebuild");
        return;
    }
    init_wifi_and_ws();

    xTaskCreatePinnedToCore(afe_feed_task,   "afe_feed",   8 * 1024, NULL, 5, NULL, 0);
    xTaskCreatePinnedToCore(afe_detect_task, "afe_detect", 8 * 1024, NULL, 5, NULL, 1);
}
