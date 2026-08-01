#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <DFRobotDFPlayerMini.h>

// =====================================================
// WiFi 設定
// =====================================================
const char* ssid     = "CBN-B4640-2.4G";
const char* password = "110106291208";

// =====================================================
// MQTT Broker
// =====================================================
const char* mqtt_host = "192.168.0.171";
const int   mqtt_port = 1883;

// =====================================================
// 訂閱主題與曲目對照
// =====================================================
//  Topic        Payload    DFPlayer 動作
//  quiz/sound   TRACK_1   play(1)  → 答對音效（連對未達門檻）
//  quiz/sound   TRACK_2   play(2)  → 答錯音效（連錯未達門檻）
//  quiz/sound   TRACK_3   play(3)  → 連對達門檻，播放一次
//  quiz/sound   TRACK_4   play(4)  → 連錯達門檻，播放一次
//  quiz/sound   TRACK_5   play(5)  → 結算：正確率 ≤ 50%
//  quiz/sound   TRACK_6   play(6)  → 結算：正確率 > 50%
//  quiz/sound   TRACK_7   play(7)  → 搶答蜂鳴（玩家按下搶答鍵瞬間）
//
// SD 卡：音樂檔案命名為 0001.mp3 ~ 0010.mp3，放入 SD 卡的 /MP3/ 子資料夾

// =====================================================
// GPIO — DFPlayer Mini（UART2）
// =====================================================
//   DFPlayer TX  →  ESP32 GPIO 16 (RX2)
//   DFPlayer RX  →  1kΩ → ESP32 GPIO 17 (TX2)
//   DFPlayer VCC →  5 V
//   DFPlayer GND →  GND

#define DFPLAYER_RX     16    // ESP32 UART2 RX ← DFPlayer TX
#define DFPLAYER_TX     17    // ESP32 UART2 TX → DFPlayer RX（串 1kΩ）
#define DFPLAYER_VOLUME 25    // 音量 0 ~ 30

// =====================================================
// 物件
// =====================================================
WiFiClient          espClient;
PubSubClient        mqttClient(espClient);
DFRobotDFPlayerMini dfPlayer;
HardwareSerial      dfSerial(2);   // UART2
bool                dfPlayerReady = false;

#define STATUS_TOPIC   "home/quiz_sound/status"
#define HEARTBEAT_MS   30000UL   // 心跳間隔（毫秒）
unsigned long lastHeartbeat = 0;

// =====================================================
// 輔助：MQTT 發布
// =====================================================
void pub(const char* topic, const char* payload, bool retain = false) {
  mqttClient.publish(topic, payload, retain);
  Serial.printf("[MQTT] Published → %-20s : %s%s\n", topic, payload, retain ? " [retained]" : "");
}

// =====================================================
// MQTT callback — 接收 quiz/sound 指令
// =====================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];
  Serial.printf("[MQTT] Received  ← %-20s : %s\n", topic, msg.c_str());

  if (String(topic) == "quiz/sound") {
    if (!dfPlayerReady) { Serial.println("[DFPlayer] 未就緒，略過指令"); return; }
    if      (msg == "TRACK_1") { dfPlayer.playMp3Folder(1); Serial.println("[DFPlayer] ▶ MP3/0001.mp3 — 答對"); }
    else if (msg == "TRACK_2") { dfPlayer.playMp3Folder(2); Serial.println("[DFPlayer] ▶ MP3/0002.mp3 — 答錯"); }
    else if (msg == "TRACK_3") { dfPlayer.playMp3Folder(3); Serial.println("[DFPlayer] ▶ MP3/0003.mp3 — 連對達門檻"); }
    else if (msg == "TRACK_4") { dfPlayer.playMp3Folder(4); Serial.println("[DFPlayer] ▶ MP3/0004.mp3 — 連錯達門檻"); }
    else if (msg == "TRACK_5") { dfPlayer.playMp3Folder(5); Serial.println("[DFPlayer] ▶ MP3/0005.mp3 — 結算失敗"); }
    else if (msg == "TRACK_6") { dfPlayer.playMp3Folder(6); Serial.println("[DFPlayer] ▶ MP3/0006.mp3 — 結算通過"); }
    else if (msg == "TRACK_7") { dfPlayer.playMp3Folder(7); Serial.println("[DFPlayer] ▶ MP3/0007.mp3 — 搶答蜂鳴"); }
    else { Serial.printf("[DFPlayer] 未知指令: %s\n", msg.c_str()); }
  }
}

// =====================================================
// MQTT reconnect + 重新訂閱
// =====================================================
void mqttReconnect() {
  while (!mqttClient.connected()) {
    Serial.print("Connecting MQTT... ");
    // LWT：非正常斷線時 Broker 自動發布 "offline"（retained）
    if (mqttClient.connect("ESP32_QUIZ_SOUND", nullptr, nullptr,
                            STATUS_TOPIC, 0, true, "offline")) {
      Serial.println("OK");
      mqttClient.subscribe("quiz/sound");
      Serial.println("Subscribed: quiz/sound");
      pub(STATUS_TOPIC, "online", true);  // retained：新訂閱者立刻收到
    } else {
      Serial.printf("failed rc=%d  retry 1.5s\n", mqttClient.state());
      delay(1500);
    }
  }
}

// =====================================================
// Setup
// =====================================================
void setup() {
  Serial.begin(115200);

  // DFPlayer Mini
  dfSerial.begin(9600, SERIAL_8N1, DFPLAYER_RX, DFPLAYER_TX);
  delay(500);
  if (!dfPlayer.begin(dfSerial)) {
    Serial.println("[DFPlayer] ✗ 初始化失敗，請確認接線與 SD 卡（後續音效指令將被略過）");
  } else {
    dfPlayerReady = true;
    dfPlayer.volume(DFPLAYER_VOLUME);
    dfPlayer.EQ(DFPLAYER_EQ_NORMAL);
    Serial.printf("[DFPlayer] ✓ 初始化完成  volume=%d\n", DFPLAYER_VOLUME);
    delay(800);                   // 等待 DFPlayer 內部穩定後再下指令
    dfPlayer.playMp3Folder(10);   // 啟動確認音：只播一次，確認 DFPlayer 與 SD 卡就緒
    Serial.println("[DFPlayer] ▶ MP3/0010.mp3 — 啟動確認音");
  }

  // WiFi
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(ssid, password);
  Serial.print("WiFi connecting");
  while (WiFi.status() != WL_CONNECTED) { delay(300); Serial.print("."); }
  Serial.printf("\nWiFi connected  IP: %s\n", WiFi.localIP().toString().c_str());

  // MQTT
  mqttClient.setServer(mqtt_host, mqtt_port);
  mqttClient.setCallback(mqttCallback);
}

// =====================================================
// Loop
// =====================================================
void loop() {
  if (!mqttClient.connected()) mqttReconnect();
  mqttClient.loop();

  // 定期心跳：重發 retained "online"，確保 HTML 狀態即時準確
  unsigned long now = millis();
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    pub(STATUS_TOPIC, "online", true);
  }
}
