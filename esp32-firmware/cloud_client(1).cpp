#include "cloud_client.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <esp_task_wdt.h>

static const unsigned long POLL_INTERVAL_MS = 3000;
static const size_t CHUNK_SIZE = 4096;

CloudClient::CloudClient(UsbPrinter& printer)
  : _printer(printer), _lastPollMs(0), _configured(false) {}

void CloudClient::begin(const char* serverUrl, const char* token) {
  _serverUrl = String(serverUrl);
  while (_serverUrl.endsWith("/")) {
    _serverUrl.remove(_serverUrl.length() - 1);
  }
  _token = String(token);
  _configured = (_serverUrl.length() > 0 && _token.length() > 0);
  if (_configured) {
    Serial.printf("[Cloud] Enabled -> %s\n", _serverUrl.c_str());
  }
}

void CloudClient::task() {
  if (!_configured || WiFi.status() != WL_CONNECTED) return;

  unsigned long now = millis();
  if (now - _lastPollMs < POLL_INTERVAL_MS) return;
  _lastPollMs = now;

  _pollAndPrint();
}

void CloudClient::_pollAndPrint() {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String statusStr = _printer.isReady() ? "Ready" : "Disconnected";
  String url = _serverUrl + "/api/esp/poll?status=" + statusStr;

  if (!http.begin(client, url)) return;
  http.addHeader("x-print-token", _token);
  http.setTimeout(5000);

  int code = http.GET();
  if (code == 200) {
    String payload = http.getString();
    http.end();

    // Parse {"id":"...","size":12345,...}
    int idIdx = payload.indexOf("\"id\":\"");
    if (idIdx >= 0) {
      int idStart = idIdx + 6;
      int idEnd = payload.indexOf("\"", idStart);
      String jobId = payload.substring(idStart, idEnd);

      size_t expectedSize = 0;
      int sizeIdx = payload.indexOf("\"size\":");
      if (sizeIdx >= 0) {
        expectedSize = payload.substring(sizeIdx + 7).toInt();
      }

      if (_printer.isReady()) {
        Serial.printf("[Cloud] Printing job %s (%u bytes)...\n", jobId.c_str(), (unsigned)expectedSize);
        bool ok = _streamJob(jobId, expectedSize);
        _reportDone(jobId, ok);
      } else {
        Serial.println("[Cloud] Job available but printer is not ready");
        _reportDone(jobId, false);
      }
    }
  } else {
    http.end();
  }
}

bool CloudClient::_streamJob(const String& jobId, size_t expectedSize) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = _serverUrl + "/api/esp/job/" + jobId;
  if (!http.begin(client, url)) return false;
  http.addHeader("x-print-token", _token);
  http.setTimeout(15000);

  int code = http.GET();
  if (code != 200) {
    http.end();
    return false;
  }

  WiFiClient* stream = http.getStreamPtr();
  uint8_t* buf = (uint8_t*)malloc(CHUNK_SIZE);
  if (!buf) {
    http.end();
    return false;
  }

  size_t totalSent = 0;
  unsigned long lastDataMs = millis();
  bool ok = true;

  while (http.connected() && (expectedSize == 0 || totalSent < expectedSize)) {
    esp_task_wdt_reset();
    size_t avail = stream->available();
    if (avail > 0) {
      size_t toRead = min(avail, CHUNK_SIZE);
      int n = stream->readBytes(buf, toRead);
      if (n > 0) {
        int sent = _printer.sendData(buf, n);
        if (sent <= 0) {
          Serial.println("[Cloud] USB sendData failed");
          ok = false;
          break;
        }
        totalSent += sent;
        lastDataMs = millis();
      }
    } else {
      if (millis() - lastDataMs > 15000) {
        Serial.println("[Cloud] Stream timeout");
        ok = false;
        break;
      }
      delay(5);
    }
  }

  free(buf);
  http.end();
  Serial.printf("[Cloud] Job %s finished: %u bytes sent\n", jobId.c_str(), (unsigned)totalSent);
  return ok && (totalSent > 0);
}

void CloudClient::_reportDone(const String& jobId, bool ok) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = _serverUrl + "/api/esp/job/" + jobId + "/done";
  if (!http.begin(client, url)) return;
  http.addHeader("x-print-token", _token);
  http.addHeader("Content-Type", "application/json");
  http.POST(ok ? "{\"ok\":true}" : "{\"ok\":false}");
  http.end();
}
