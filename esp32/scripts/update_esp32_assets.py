import os
import urllib.request

# Configuration
ESP32_IP = "192.168.4.1"
# Files to upload (relative to DATA_DIR)
ASSETS = [
    "src/launcher.html", 
    "src/lithic.html",
    "src/vollkorn.css",
    "offline-service-worker.js"
]
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(PROJECT_DIR, "data")

def upload_file(rel_path):
    local_path = os.path.join(DATA_DIR, rel_path)
    # The URL on the ESP32 server
    url = f"http://{ESP32_IP}/{rel_path}"
    
    if not os.path.exists(local_path):
        print(f"Error: {local_path} not found. Run a PIO build first to download assets.")
        return

    print(f"Uploading {rel_path} to {url}...")
    try:
        with open(local_path, "rb") as f:
            data = f.read()
            req = urllib.request.Request(url, data=data, method="PUT")
            with urllib.request.urlopen(req, timeout=60) as response:
                if response.status in [200, 201, 204]:
                    print(f"Successfully uploaded {rel_path}")
                else:
                    print(f"Failed to upload {rel_path}: Status {response.status}")
    except Exception as e:
        print(f"Failed to upload {rel_path}: {e}")

def main():
    for asset in ASSETS:
        upload_file(asset)

if __name__ == "__main__":
    main()
