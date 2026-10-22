import os
import urllib.request
import sys
import re

# PlatformIO SCons environment
try:
    from SCons.Script import Import
    Import("env")
    PROJECT_DIR = env.subst("$PROJECT_DIR")
    RUNNING_IN_PIO = True
except Exception:
    PROJECT_DIR = os.getcwd()
    RUNNING_IN_PIO = False

# Configuration
ASSETS = {
    "src/launcher.html": "https://raw.githubusercontent.com/Xyvir/Lithic-UK/refs/heads/main/src/launcher.html",
    "src/lithic.html": "https://raw.githubusercontent.com/Xyvir/Lithic-UK/refs/heads/main/src/lithic-light.html",
    "offline-service-worker.js": "https://raw.githubusercontent.com/Xyvir/Lithic-UK/refs/heads/main/offline-service-worker.js"
}

DATA_DIR = os.path.join(PROJECT_DIR, "data")

def patch_launcher(file_path):
    print(f"--- Lithic Patch: Localizing fonts in {os.path.basename(file_path)} ---")
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        # 1. Remove Google Fonts preconnects and stylesheets
        # Matches: <link rel="preconnect" ...> and <link rel="stylesheet" ... fonts.googleapis.com ...>
        content = re.sub(r'<link rel="preconnect" href="https://fonts\.(googleapis|gstatic)\.com".*?>', '', content)
        content = re.sub(r'<link rel="stylesheet"\s+href="https://fonts\.googleapis\.com/css2\?family=Vollkorn.*?>', '', content)
        
        # 2. Remove noscript fallback for Google Fonts
        content = re.sub(r'<noscript>.*?fonts\.googleapis\.com.*?</noscript>', '', content, flags=re.DOTALL)

        # 3. Inject local font link and styling fixes
        local_font_link = '<link rel="stylesheet" href="/src/vollkorn.css">'
        style_fixes = """
  <style>
    /* Lithic ESP32 UI Fixes */
    h1 { font-weight: 400 !important; } 
    h1 div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @media (max-width: 600px) { h1 { font-size: 1.25rem !important; } }
"""
        if local_font_link not in content:
            # We replace the first <style> tag with our link and our custom fixes
            content = content.replace('<style>', f'{local_font_link}\n{style_fixes}', 1)



        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        print("Successfully patched launcher.html for offline fonts.")
    except Exception as e:
        print(f"Warning: Failed to patch {file_path}: {e}")

def download_file(url, dest_path):
    print(f"--- Lithic Asset Sync: Downloading {os.path.basename(dest_path)} ---")
    sys.stdout.flush()
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)

    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=60) as response:
            content = response.read()
            with open(dest_path, "wb") as f:
                f.write(content)
        print(f"Successfully updated {dest_path}")
        
        # If we just downloaded the launcher, patch it immediately
        if dest_path.endswith("launcher.html"):
            patch_launcher(dest_path)

    except Exception as e:
        print(f"\n!!! LITHIC ERROR: Failed to download {url}: {e} !!!")
        sys.stdout.flush()
        sys.exit(1)

def main():
    for rel_path, url in ASSETS.items():
        dest_path = os.path.join(DATA_DIR, rel_path)
        download_file(url, dest_path)

if __name__ == "__main__" or RUNNING_IN_PIO:
    main()
