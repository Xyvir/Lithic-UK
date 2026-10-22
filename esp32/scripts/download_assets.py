import os
import subprocess
import sys

# PlatformIO SCons environment
try:
    from SCons.Script import Import
    Import("env")
    PROJECT_DIR = env.subst("$PROJECT_DIR")
    RUNNING_IN_PIO = True
except Exception:
    PROJECT_DIR = os.getcwd()
    RUNNING_IN_PIO = False


def main():
    # The pages come from this repository and are gzipped by the shared staging script.
    # Nothing is downloaded at build time, so the filesystem image builds offline.
    repo_root = os.path.abspath(os.path.join(PROJECT_DIR, ".."))
    script = os.path.join(repo_root, "scripts", "stage-esp32.mjs")
    result = subprocess.run(["node", script], cwd=repo_root)
    if result.returncode != 0:
        print("!!! LITHIC ERROR: staging the ESP32 filesystem failed !!!")
        sys.exit(result.returncode)


if __name__ == "__main__" or RUNNING_IN_PIO:
    main()
