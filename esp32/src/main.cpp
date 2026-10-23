#include <WiFi.h>
#include <DNSServer.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <LittleFS.h>
#include <esp_partition.h>
#include <esp_task_wdt.h>

// --- Configuration ---
#define WDT_TIMEOUT_SECONDS 15
#define MIN_FREE_HEAP 30000 // 30KB safety margin

const byte DNS_PORT = 53;
IPAddress apIP(192, 168, 4, 1);
DNSServer dnsServer;
const char* UI_VERSION = "1.0.0"; // Increment this to force a cache refresh
AsyncWebServer server(80);

// --- WiFi Config (flashed with the firmware, then overridden by /config.txt) ---
String cfgSSID = "";
String cfgPassword = "lithic123";
// The text the launcher wrote into the `cfg` partition while it flashed this board.
String flashedConfig = "";

// One `key=value` line, shared by the flashed block and /config.txt so the two
// cannot disagree about what a setting is called.
void applyConfigLine(const String &rawLine) {
    String line = rawLine;
    line.trim();
    if (line.length() == 0 || line.startsWith("#")) return; // skip blanks & comments
    int sep = line.indexOf('=');
    if (sep < 0) return;
    String key = line.substring(0, sep);
    String val = line.substring(sep + 1);
    key.trim();
    val.trim();
    if (key == "ssid" && val.length() > 0) {
        cfgSSID = val;
        Serial.printf("[CONFIG] SSID override: %s\n", cfgSSID.c_str());
    } else if (key == "pass" && val.length() > 0) {
        cfgPassword = val;
        Serial.println("[CONFIG] Password override loaded.");
    }
}

// --- Dynamic SSID Generation ---
String getDynamicSSID() {
    uint64_t chipid = ESP.getEfuseMac();
    uint16_t chip = (uint16_t)(chipid >> 32);
    char ssid[25];
    snprintf(ssid, 25, "Lithic_%04X", chip);
    return String(ssid);
}

// --- Settings the launcher flashed, read from the `cfg` partition ---
// `partitions.csv` keeps 64 KB at the end of the flash for it, outside the
// filesystem, because the launcher cannot write a file: it hands the loader a
// block of bytes and the loader writes them at an address.
void loadFlashedConfig() {
    const esp_partition_t *part = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "cfg");
    if (!part) {
        Serial.println("[CONFIG] No cfg partition on this build.");
        return;
    }
    static uint8_t buf[512];
    size_t len = part->size < sizeof(buf) - 1 ? part->size : sizeof(buf) - 1;
    if (esp_partition_read(part, 0, buf, len) != ESP_OK) {
        Serial.println("[CONFIG] The cfg partition could not be read.");
        return;
    }
    // Erased flash is 0xFF, and an older, longer block can leave bytes behind the
    // new one. Either way the settings end at the first byte that is not text.
    String text;
    for (size_t i = 0; i < len; i++) {
        if (buf[i] == 0xFF || buf[i] == 0) break;
        text += (char)buf[i];
    }
    if (text.length() == 0) return;
    int start = 0;
    while (start < (int)text.length()) {
        int nl = text.indexOf('\n', start);
        if (nl < 0) {
            applyConfigLine(text.substring(start));
            break;
        }
        applyConfigLine(text.substring(start, nl));
        start = nl + 1;
    }
    flashedConfig = text;
    Serial.println("[CONFIG] Read the settings the launcher flashed.");
}

// The flashed block becomes an editable file on the first boot, so the documented
// /config.txt exists from the start and stays the thing that wins over it.
void seedConfigFile() {
    if (flashedConfig.length() == 0) return;
    if (LittleFS.exists("/config.txt")) return;
    File f = LittleFS.open("/config.txt", "w");
    if (!f) {
        Serial.println("[CONFIG] /config.txt could not be created.");
        return;
    }
    f.print(flashedConfig);
    if (!flashedConfig.endsWith("\n")) f.print("\n");
    f.close();
    Serial.println("[CONFIG] Wrote /config.txt from the flashed settings.");
}

// --- Load WiFi Config from LittleFS ---
void loadConfig() {
    File f = LittleFS.open("/config.txt", "r");
    if (!f) {
        Serial.println("[CONFIG] No /config.txt found, using defaults.");
        return;
    }
    Serial.println("[CONFIG] Reading /config.txt...");
    while (f.available()) {
        applyConfigLine(f.readStringUntil('\n'));
    }
    f.close();
}

// --- CORS Helper ---
void addCorsHeaders(AsyncWebServerResponse *response) {
    response->addHeader("Access-Control-Allow-Origin", "*");
    response->addHeader("Access-Control-Allow-Methods", "PROPFIND, GET, PUT, DELETE, OPTIONS");
    response->addHeader("Access-Control-Allow-Headers", "Content-Type, Depth, User-Agent, X-File-Size, X-Requested-With, If-Modified-Since, X-File-Name, Cache-Control");
    response->addHeader("DAV", "1");
}

// --- Captive Portal Interceptor ---
class CaptiveRequestHandler : public AsyncWebHandler {
public:
  CaptiveRequestHandler() {}
  virtual ~CaptiveRequestHandler() {}

  bool canHandle(AsyncWebServerRequest *request) {
    if (request->host() != WiFi.softAPIP().toString() && !request->url().startsWith("/src/") && !request->url().startsWith("/sync")) {
      return true;
    }
    return false;
  }

  void handleRequest(AsyncWebServerRequest *request) {
    AsyncWebServerResponse *response = request->beginResponse(302, "text/plain", "");
    response->addHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/");
    response->addHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    response->addHeader("Pragma", "no-cache");
    response->addHeader("Expires", "-1");
    request->send(response);
  }
};

// --- Dynamic WebDAV Payload Handler ---
// This safely handles the .lith payloads without bloating the binary with regex
class SyncFileHandler : public AsyncWebHandler {
public:
    SyncFileHandler() {}
    virtual ~SyncFileHandler() {}

    // Tell the server this handler is NOT trivial so it doesn't try to optimize away the body
    bool isRequestHandlerTrivial() const override { return false; }

    bool canHandle(AsyncWebServerRequest *request) const override {
        if (request->url().startsWith("/sync/") && request->url().endsWith(".lith")) return true;
        if (request->method() == HTTP_PUT) {
            if (request->url() == "/src/launcher.html" || request->url() == "/src/lithic.html" || request->url() == "/src/vollkorn.css") return true;
            if (request->url() == "/offline-service-worker.js") return true;
        }
        return false;
    }


    void handleRequest(AsyncWebServerRequest *request) override {
        String filename = request->url();
        
        if (request->method() == HTTP_OPTIONS) {
            AsyncWebServerResponse *response = request->beginResponse(200);
            addCorsHeaders(response);
            request->send(response);
            return;
        }

        if (request->method() == HTTP_GET) {
            Serial.printf("[GET] Opening: %s\n", filename.c_str());
            if (LittleFS.exists(filename)) {
                AsyncWebServerResponse *response = request->beginResponse(LittleFS, filename, "text/html");
                addCorsHeaders(response);
                request->send(response);
            } else {
                Serial.printf("[GET] Error: %s not found\n", filename.c_str());
                AsyncWebServerResponse *response = request->beginResponse(404, "text/plain", "Not Found");
                addCorsHeaders(response);
                request->send(response);
            }
            return;
        }

        if (request->method() == HTTP_DELETE) {
            // Only allow deleting .lith files, not assets
            if (!filename.endsWith(".lith")) {
                request->send(403, "text/plain", "Forbidden");
                return;
            }
            Serial.printf("[DELETE] Removing: %s\n", filename.c_str());
            if (LittleFS.remove(filename)) {
                AsyncWebServerResponse *response = request->beginResponse(204);
                addCorsHeaders(response);
                request->send(response);
            } else {
                AsyncWebServerResponse *response = request->beginResponse(404, "text/plain", "Not Found");
                addCorsHeaders(response);
                request->send(response);
            }
            return;
        }

        if (request->method() == HTTP_PUT) {
            Serial.printf("[PUT] Receiving asset update: %s\n", filename.c_str());
            return;
        }

        request->send(405, "text/plain", "Method Not Allowed");
    }


    void handleBody(AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) override {
        if (request->method() == HTTP_PUT) {
            String filename = request->url();
            File file;
            if (!index) {
                file = LittleFS.open(filename, FILE_WRITE);
            } else {
                file = LittleFS.open(filename, FILE_APPEND);
            }
            
            if (file) {
                file.write(data, len);
                file.close();
            }

            // Only send the response once we have the entire file
            if (index + len >= total) {
                Serial.printf("[PUT] Success: %s (%u bytes)\n", filename.c_str(), (uint32_t)total);
                AsyncWebServerResponse *response = request->beginResponse(201, "text/plain", "Created");
                addCorsHeaders(response);
                request->send(response);
            }
        }
    }
};

// Serves a staged .gz page with Content-Encoding: gzip. The browser inflates it, the device never does.
void sendGzippedPage(AsyncWebServerRequest *request, const char* path, const char* type) {
    String gzPath = String(path) + ".gz";
    if (!LittleFS.exists(gzPath)) {
        request->send(404, "text/plain", "Not Found");
        return;
    }
    AsyncWebServerResponse *response = request->beginResponse(LittleFS, gzPath, type);
    response->addHeader("Content-Encoding", "gzip");
    response->addHeader("Cache-Control", "public, max-age=31536000");
    request->send(response);
}

void setup() {
    Serial.begin(115200);

    if (!LittleFS.begin(true)) {
        Serial.println("LittleFS Mount Failed!");
        return;
    }
    LittleFS.mkdir("/sync");
    LittleFS.mkdir("/src");


    loadFlashedConfig();
    seedConfigFile();
    loadConfig();

    String currentSSID = cfgSSID.length() > 0 ? cfgSSID : getDynamicSSID();
    WiFi.mode(WIFI_AP);
    WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
    WiFi.softAP(currentSSID.c_str(), cfgPassword.c_str());
    Serial.printf("[WIFI] AP started: %s\n", currentSSID.c_str());
    
    dnsServer.setErrorReplyCode(DNSReplyCode::NoError);
    dnsServer.start(DNS_PORT, "*", apIP);

    server.addHandler(new CaptiveRequestHandler()).setFilter(ON_AP_FILTER);
    server.addHandler(new SyncFileHandler());

    // --- Task Watchdog (Legacy API) ---
    esp_task_wdt_init(WDT_TIMEOUT_SECONDS, true);
    esp_task_wdt_add(NULL); 



    // --- Core UI Routes ---
    server.on("/", HTTP_GET, [](AsyncWebServerRequest *request){
        request->redirect("/src/launcher.html?v=" + String(UI_VERSION));
    });
    server.on("/src/launcher.html", HTTP_GET, [](AsyncWebServerRequest *request){
        sendGzippedPage(request, "/src/launcher.html", "text/html");
    });
    server.on("/src/lithic.html", HTTP_GET, [](AsyncWebServerRequest *request){
        sendGzippedPage(request, "/src/lithic.html", "text/html");
    });
    server.on("/src/vollkorn.css", HTTP_GET, [](AsyncWebServerRequest *request){
        AsyncWebServerResponse *response = request->beginResponse(LittleFS, "/src/vollkorn.css", "text/css");
        response->addHeader("Cache-Control", "public, max-age=31536000");
        request->send(response);
    });



    // --- Captive Portal Traps (Android, Windows, Apple) ---
    server.on("/generate_204", HTTP_GET, [](AsyncWebServerRequest *request){ request->redirect("http://192.168.4.1/"); }); // Android
    server.on("/redirect", HTTP_GET, [](AsyncWebServerRequest *request){ request->redirect("http://192.168.4.1/"); });      // Android
    server.on("/connecttest.txt", HTTP_GET, [](AsyncWebServerRequest *request){ request->redirect("http://192.168.4.1/"); }); // Windows 10/11
    server.on("/ncsi.txt", HTTP_GET, [](AsyncWebServerRequest *request){ request->redirect("http://192.168.4.1/"); });        // Windows
    server.on("/hotspot-detect.html", HTTP_GET, [](AsyncWebServerRequest *request){ request->redirect("http://192.168.4.1/"); }); // Apple
    server.on("/library/test/success.html", HTTP_GET, [](AsyncWebServerRequest *request){ request->redirect("http://192.168.4.1/"); }); // Apple
    server.on("/success.txt", HTTP_GET, [](AsyncWebServerRequest *request){ request->redirect("http://192.168.4.1/"); }); // Generic

    // --- Lithic "Phantom" Mocking ---
    server.on("/api/github/status", HTTP_GET, [](AsyncWebServerRequest *request){
        AsyncWebServerResponse *response = request->beginResponse(200, "application/json", "{\"connected\":false}");
        addCorsHeaders(response);
        request->send(response);
    });

    // --- PWA / Cache Assets ---

    server.on("/offline-service-worker.js", HTTP_GET, [](AsyncWebServerRequest *request){
        request->send(LittleFS, "/offline-service-worker.js", "application/javascript");
    });

    server.on("/favicon.ico", HTTP_GET, [](AsyncWebServerRequest *request){ request->send(204); });

    server.on("/mstile-150x150.png", HTTP_GET, [](AsyncWebServerRequest *request){ request->send(204); });

    // --- WEBDAV DIRECTORY LISTING (Manual PROPFIND Fallback) ---
    // A listing belongs to a WebDAV client, and PROPFIND is the only verb that asks for one.
    // This route used to answer every method, so a browser that landed here (a bookmark, a
    // typed address, the old `/sync` redirect) was handed `application/xml` and drew the
    // multistatus tree as a page, on top of whatever it had painted before. GET and HEAD are
    // what a browser sends for a page, so this address now answers them as one.
    server.on("/sync/", HTTP_ANY, [](AsyncWebServerRequest *request){
        if (request->method() == HTTP_OPTIONS) {
            AsyncWebServerResponse *response = request->beginResponse(200);
            addCorsHeaders(response);
            request->send(response);
            return;
        }

        // The matcher reads a trailing slash as a prefix, so this route also sees every
        // path beneath it. Only the collection itself is a page: a file nobody has is a
        // 404, because a client reading a missing file has to be told it is missing. That
        // redirect used to answer the launcher's own icon probe with the launcher page,
        // which is how the page's source ended up drawn as the instance's icon.
        if (request->method() == HTTP_GET || request->method() == HTTP_HEAD) {
            if (request->url() == "/sync/") {
                request->redirect("/");
            } else {
                request->send(404, "text/plain", "Not Found");
            }
            return;
        }

        if (request->method() != HTTP_PROPFIND) {
            request->send(405, "text/plain", "Method Not Allowed");
            return;
        }

        String xml = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<D:multistatus xmlns:D=\"DAV:\">\n";
        
        // Correctly open the /sync directory to see files inside it
        File syncDir = LittleFS.open("/sync");
        if (syncDir && syncDir.isDirectory()) {
            File file = syncDir.openNextFile();
            while(file) {
                if (!file.isDirectory()) {
                    String fn = String(file.name());
                    // In LittleFS, file.name() is usually just the filename (e.g., "Welcome.lith")
                    if (fn.endsWith(".lith")) {
                        xml += "<D:response>\n  <D:href>/sync/" + fn + "</D:href>\n  <D:propstat>\n    <D:prop>\n";
                        xml += "      <D:getlastmodified>Tue, 12 May 2026 12:00:00 GMT</D:getlastmodified>\n";
                        xml += "    </D:prop>\n    <D:status>HTTP/1.1 200 OK</D:status>\n  </D:propstat>\n</D:response>\n";
                    }
                }
                file = syncDir.openNextFile();
            }
        }
        xml += "</D:multistatus>";
        
        AsyncWebServerResponse *response = request->beginResponse(207, "application/xml", xml);
        // A directory read is worth nothing once it is stale, and a replayed listing is a
        // page describing files the store may no longer hold.
        response->addHeader("Cache-Control", "no-store");
        addCorsHeaders(response);
        request->send(response);
    });

    server.on("/sync", HTTP_ANY, [](AsyncWebServerRequest *request){
        // Without its slash this is either someone typing the store's address or a client
        // that wants the collection listed: a browser gets the launcher, a client the listing.
        if (request->method() == HTTP_GET || request->method() == HTTP_HEAD) {
            request->redirect("/");
        } else {
            request->redirect("/sync/");
        }
    });

    // --- WEBDAV .LOCK FILES AND CATCH-ALL ---
    server.onNotFound([](AsyncWebServerRequest *request) {
        if (request->method() == HTTP_OPTIONS) {
            AsyncWebServerResponse *response = request->beginResponse(200);
            addCorsHeaders(response);
            request->send(response);
            return;
        }

        if (request->url().startsWith("/sync/") && request->url().endsWith(".lock")) {
            if (request->method() == HTTP_GET) {
                AsyncWebServerResponse *response = request->beginResponse(404, "text/plain", "No lock");
                addCorsHeaders(response);
                request->send(response);
            } else {
                AsyncWebServerResponse *response = request->beginResponse(204);
                addCorsHeaders(response);
                request->send(response);
            }
            return;
        }

        request->send(404, "text/plain", "Not Found");
    });

    server.begin();
}

void loop() {
    dnsServer.processNextRequest();
    esp_task_wdt_reset(); // "Kick the dog" to prevent reboot

    // --- Self-Healing: Memory Check ---
    static unsigned long lastMemCheck = 0;
    if (millis() - lastMemCheck > 5000) {
        lastMemCheck = millis();
        uint32_t freeHeap = ESP.getFreeHeap();
        if (freeHeap < MIN_FREE_HEAP) {
            Serial.printf("CRITICAL: Low Memory (%u). Rebooting for stability...\n", freeHeap);
            delay(500);
            ESP.restart();
        }
    }
}