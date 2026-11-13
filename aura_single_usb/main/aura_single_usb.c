#include <stdio.h>
#include <string.h>
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

#include "usb_device_uac.h"
#include "esp_websocket_client.h"
#include "esp_wn_iface.h"
#include "esp_wn_models.h"
#include "esp_afe_sr_iface.h"
#include "esp_afe_sr_models.h"
#include "model_path.h"

static const char *TAG = "AURA";

// ============ CHANGE THESE ============
#define WIFI_SSID  "YOUR_WIFI_SSID"
#define WIFI_PASS  "YOUR_WIFI_PASSWORD"
#define GO_WS_URI  "ws://192.168.1.100:8080/ws/audio"
// 1 = PC mic -> ESP -> PC speaker loopback, no Wi-Fi/AFE (Stage 1 test)
#define BRINGUP_USB_LOOPBACK 0
// ======================================

#define RB_SIZE          (128 * 1024)
#define PREBUFFER_BYTES  (16000 * 2 * 80 / 1000)   // 80 ms
#define TTS_HOLD_US      (600 * 1000)

static RingbufHandle_t rb_pc_to_esp = NULL;   // PC mic  -> ESP
static RingbufHandle_t rb_esp_to_pc = NULL;   // Server  -> ESP -> PC speaker

static esp_afe_sr_iface_t *afe_handle = NULL;
static esp_afe_sr_data_t  *afe_data   = NULL;
static esp_websocket_client_handle_t ws_client = NULL;

static volatile bool    is_streaming_to_go = false;
static volatile bool    s_tts_active = false;
static volatile int64_t s_tts_mute_until_us = 0;
static bool s_playing = false;
static bool s_ws_started = false;

/* ---------------- USB audio callbacks ---------------- */

// Host -> device: PC mic audio arrives here (USB "speaker" endpoint)
static esp_err_t uac_out_cb(uint8_t *buf, size_t len, void *arg) {
#if BRINGUP_USB_LOOPBACK
    if (rb_esp_to_pc) xRingbufferSend(rb_esp_to_pc, buf, len, 0);
#else
    if (rb_pc_to_esp) xRingbufferSend(rb_pc_to_esp, buf, len, 0);
#endif
    return ESP_OK;
}

// Device -> host: server audio goes to the PC (USB "mic" endpoint)
static esp_err_t uac_in_cb(uint8_t *buf, size_t len, size_t *bytes_read, void *arg) {
    *bytes_read = len;
    memset(buf, 0, len);
    if (!rb_esp_to_pc) return ESP_OK;

    if (!s_playing) {
        size_t fill = RB_SIZE - xRingbufferGetCurFreeSize(rb_esp_to_pc);
        if (fill < PREBUFFER_BYTES) return ESP_OK;   // silence until cushion exists
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
    if (total < len) s_playing = false;              // underrun: re-buffer
    return ESP_OK;
}

static void uac_mute_cb(uint32_t mute, void *arg) {}
static void uac_vol_cb(uint32_t vol, void *arg) {}

/* ---------------- WebSocket ---------------- */

static void ws_event_handler(void *args, esp_event_base_t base, int32_t id, void *event_data) {
    esp_websocket_event_data_t *d = (esp_websocket_event_data_t *)event_data;
    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "Connected to Go server");
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
        is_streaming_to_go = false;
        s_tts_active = false;
        break;
    case WEBSOCKET_EVENT_DATA:
        if (d->op_code == 0x02 && d->data_len > 0) {              // binary PCM
            xRingbufferSend(rb_esp_to_pc, d->data_ptr, d->data_len, 0);
        } else if (d->op_code == 0x01 && d->data_len > 0) {       // text control
            char msg[64];
            size_t n = d->data_len < 63 ? d->data_len : 63;
            memcpy(msg, d->data_ptr, n);
            msg[n] = 0;
            if (strstr(msg, "tts_start")) {
                s_tts_active = true;
            } else if (strstr(msg, "tts_end")) {
                s_tts_active = false;
                s_tts_mute_until_us = esp_timer_get_time() + TTS_HOLD_US;
            }
        }
        break;
    default:
        break;
    }
}

/* ---------------- AFE: feed + detect ---------------- */

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
            uint8_t *it = (uint8_t *)xRingbufferReceiveUpTo(
                rb_pc_to_esp, &n, pdMS_TO_TICKS(50), chunk_bytes - got);
            if (it) {
                memcpy(buf + got, it, n);
                got += n;
                vRingbufferReturnItem(rb_pc_to_esp, it);
            }
        }
        afe_handle->feed(afe_data, (int16_t *)buf);
    }
}

static void afe_detect_task(void *arg) {
    int silence_frames = 0;
    const int MAX_SILENCE_FRAMES = 45;     // ~1.4 s

    while (1) {
        afe_fetch_result_t *res = afe_handle->fetch(afe_data);
        if (!res || res->ret_value == ESP_FAIL) continue;

        bool muted = s_tts_active || esp_timer_get_time() < s_tts_mute_until_us;
        if (muted) { is_streaming_to_go = false; continue; }   // ignore mic while reply plays

        bool connected = esp_websocket_client_is_connected(ws_client);

        if (res->wakeup_state == WAKENET_DETECTED && connected) {
            ESP_LOGI(TAG, "Wake word detected");
            is_streaming_to_go = true;
            silence_frames = 0;
            const char *s = "{\"event\":\"utterance_start\",\"sample_rate\":16000}";
            esp_websocket_client_send_text(ws_client, s, strlen(s), pdMS_TO_TICKS(100));
        }

        if (is_streaming_to_go && connected) {
            esp_websocket_client_send_bin(ws_client, (const char *)res->data,
                                          res->data_size, pdMS_TO_TICKS(20));
            if (res->vad_state == AFE_VAD_SILENCE) {
                if (++silence_frames > MAX_SILENCE_FRAMES) {
                    is_streaming_to_go = false;
                    const char *e = "{\"event\":\"utterance_end\"}";
                    esp_websocket_client_send_text(ws_client, e, strlen(e), pdMS_TO_TICKS(100));
                }
            } else {
                silence_frames = 0;
            }
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
        if (!s_ws_started) { esp_websocket_client_start(ws_client); s_ws_started = true; }
    }
}

static void init_wifi_and_ws(void) {
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    esp_websocket_client_config_t ws_cfg = {
        .uri = GO_WS_URI,
        .buffer_size = 4096,
        .reconnect_timeout_ms = 2000,
        .ping_interval_sec = 10,
    };
    ws_client = esp_websocket_client_init(&ws_cfg);        // create BEFORE wifi starts
    esp_websocket_register_events(ws_client, WEBSOCKET_EVENT_ANY, ws_event_handler, NULL);

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL));

    wifi_config_t wc = { .sta = { .ssid = WIFI_SSID, .password = WIFI_PASS } };
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());
    esp_wifi_set_ps(WIFI_PS_NONE);
}

/* ---------------- main ---------------- */

void app_main(void) {
    ESP_ERROR_CHECK(nvs_flash_init());

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
    return;   // USB loopback only; callbacks do all the work
#endif

    srmodel_list_t *models = esp_srmodel_init("model");
    if (!models || models->num == 0) { ESP_LOGE(TAG, "No models in 'model' partition"); return; }

    afe_handle = (esp_afe_sr_iface_t *)&ESP_AFE_SR_HANDLE;
    afe_config_t afe_cfg = AFE_CONFIG_DEFAULT();
    afe_cfg.wakenet_model_name = esp_srmodel_filter(models, ESP_WN_PREFIX, NULL);
    if (!afe_cfg.wakenet_model_name) { ESP_LOGE(TAG, "WakeNet model not found"); return; }
    afe_cfg.aec_init = false;
    afe_cfg.pcm_config.total_ch_num = 1;
    afe_cfg.pcm_config.mic_ch_num = 1;
    afe_cfg.pcm_config.ref_ch_num = 0;
    afe_cfg.memory_alloc_mode = AFE_MEMORY_ALLOC_MORE_PSRAM;
    afe_data = afe_handle->create_from_config(&afe_cfg);

    init_wifi_and_ws();

    xTaskCreatePinnedToCore(afe_feed_task,   "afe_feed",   8 * 1024, NULL, 5, NULL, 0);
    xTaskCreatePinnedToCore(afe_detect_task, "afe_detect", 8 * 1024, NULL, 5, NULL, 1);
}