import sys
import os
import time
import json
import threading
import ctypes
import urllib.request
import uvicorn
import webview

# Fix for pythonw where stdout/stderr are None
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w')

from backend.main import app as fastapi_app
from backend.database import SessionLocal
from backend.ingest import run_ingestion, deduplicate_games
from backend.config import get_settings
from backend.runtime import get_app_root, get_bundle_root

PORT = 8765
SERVER_URL = f"http://127.0.0.1:{PORT}/"
APP_URL = SERVER_URL + "?v=12"
APP_USER_MODEL_ID = "XDir.Library"
APP_ICON_RELATIVE_PATH = os.path.join("extension", "icon128.png")
APP_ROOT = get_app_root()
BUNDLE_ROOT = get_bundle_root()
APP_ICON_PATH = os.path.join(BUNDLE_ROOT, APP_ICON_RELATIVE_PATH)
SERVER_READY_TIMEOUT_SECONDS = 45.0

STARTUP_SPLASH_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>XDir</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0c10;
      --panel: rgba(17, 24, 39, 0.9);
      --line: rgba(96, 165, 250, 0.22);
      --text: #f8fafc;
      --muted: #94a3b8;
      --blue: #3b82f6;
      --cyan: #06b6d4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background:
        radial-gradient(circle at top, rgba(59, 130, 246, 0.18), transparent 48%),
        linear-gradient(160deg, #0b0c10 0%, #111827 55%, #0f172a 100%);
      color: var(--text);
      font-family: "Segoe UI", "Inter", sans-serif;
    }
    .boot-shell {
      width: min(560px, calc(100vw - 48px));
      padding: 28px 28px 24px;
      border-radius: 24px;
      border: 1px solid var(--line);
      background: var(--panel);
      box-shadow: 0 28px 80px rgba(2, 8, 23, 0.55);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .logo {
      width: 56px;
      height: 56px;
      border-radius: 16px;
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.95), rgba(6, 182, 212, 0.95));
      display: grid;
      place-items: center;
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.04em;
      box-shadow: 0 14px 32px rgba(59, 130, 246, 0.28);
    }
    .title {
      margin: 0;
      font-size: 32px;
      font-weight: 800;
      letter-spacing: -0.04em;
    }
    .subtitle {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 14px;
    }
    .status {
      margin: 24px 0 8px;
      font-size: 15px;
      font-weight: 600;
    }
    .detail {
      margin: 0 0 18px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .loader {
      position: relative;
      height: 6px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.14);
      overflow: hidden;
    }
    .loader::after {
      content: "";
      position: absolute;
      inset: 0 auto 0 -42%;
      width: 42%;
      border-radius: inherit;
      background: linear-gradient(90deg, transparent, var(--blue), var(--cyan), transparent);
      animation: pulse 1.2s ease-in-out infinite;
    }
    .footnote {
      margin: 16px 0 0;
      color: var(--muted);
      font-size: 12px;
    }
    @keyframes pulse {
      0% { transform: translateX(0); }
      100% { transform: translateX(320%); }
    }
  </style>
</head>
<body>
  <main class="boot-shell">
    <div class="brand">
      <div class="logo">X</div>
      <div>
        <h1 class="title">XDir</h1>
        <p class="subtitle">Local game library manager</p>
      </div>
    </div>
    <p class="status" id="boot-status">Opening XDir...</p>
    <p class="detail" id="boot-detail">Preparing the local library engine and window shell.</p>
    <div class="loader"></div>
    <p class="footnote">First launch can take a bit longer while Windows warms up WebView2 and local storage.</p>
  </main>
</body>
</html>
"""

def configure_windows_shell_identity():
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
    except Exception:
        pass

def apply_native_window_icon(window):
    if not os.path.exists(APP_ICON_PATH):
        return
    try:
        import clr
        clr.AddReference('System.Drawing')
        import System.Drawing as Drawing
        bitmap = Drawing.Bitmap(APP_ICON_PATH)
        try:
            icon_handle = bitmap.GetHicon()
            icon_obj = Drawing.Icon.FromHandle(icon_handle)
            if getattr(window, 'gui', None):
                window.gui.Icon = icon_obj
        finally:
            bitmap.Dispose()
    except Exception:
        pass

def set_startup_status(window, status_text: str, detail_text: str):
    try:
        status_json = json.dumps(status_text)
        detail_json = json.dumps(detail_text)
        window.evaluate_js(
            f"""
            (function () {{
              const statusEl = document.getElementById('boot-status');
              const detailEl = document.getElementById('boot-detail');
              if (statusEl) statusEl.textContent = {status_json};
              if (detailEl) detailEl.textContent = {detail_json};
            }})();
            """
        )
    except Exception:
        pass


def wait_for_server_ready(timeout_seconds: float = 10.0) -> bool:
    deadline = time.time() + timeout_seconds
    stats_url = f"http://127.0.0.1:{PORT}/api/stats"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(stats_url, timeout=0.25) as response:
                if response.status == 200:
                    return True
        except Exception:
            time.sleep(0.1)
    return False


def schedule_library_maintenance():
    settings = get_settings()

    def bg_maintenance():
        time.sleep(1.0)
        maintenance_db = SessionLocal()
        try:
            deduplicate_games(maintenance_db)
        except Exception:
            maintenance_db.rollback()
        finally:
            maintenance_db.close()

        if settings.get('startup_scan', True):
            try:
                run_ingestion()
            except Exception:
                pass

    threading.Thread(target=bg_maintenance, daemon=True).start()


def start_server():
    uvicorn.run(fastapi_app, host="127.0.0.1", port=PORT, log_level="warning")


def bootstrap_window(window):
    apply_native_window_icon(window)
    set_startup_status(window, "Starting local engine...", "Bringing the local API online before loading your library.")

    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()

    if not wait_for_server_ready(timeout_seconds=12.0):
        set_startup_status(window, "Still starting...", "First launch can be slower while Windows initializes the embedded browser runtime.")

    if not wait_for_server_ready(timeout_seconds=SERVER_READY_TIMEOUT_SECONDS - 12.0):
        set_startup_status(window, "Startup is taking longer than expected", "The app is still waiting for the local engine. If this repeats every launch, restart XDir.")
        return

    set_startup_status(window, "Loading library...", "The window is ready. Finalizing the game list and startup maintenance in the background.")
    schedule_library_maintenance()
    try:
        window.load_url(APP_URL)
    except Exception:
        pass


def main():
    configure_windows_shell_identity()
    
    # Check if user passed --server-only
    if "--server-only" in sys.argv:
        server_thread = threading.Thread(target=start_server, daemon=True)
        server_thread.start()
        print(f"Running XDir Library server in background on {SERVER_URL}")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("Shutting down.")
            sys.exit(0)
            
    class WindowApi:
        def minimize(self):
            if len(webview.windows) > 0:
                webview.windows[0].minimize()
        def maximize(self):
            if len(webview.windows) > 0:
                w = webview.windows[0]
                try:
                    import clr
                    clr.AddReference('System.Windows.Forms')
                    import System.Windows.Forms as WinForms
                    if getattr(w, 'gui', None) and getattr(w.gui, 'WindowState', None) == WinForms.FormWindowState.Maximized:
                        w.restore()
                        return
                except Exception:
                    pass
                try:
                    if getattr(w, '_is_max', False):
                        w.restore()
                        w._is_max = False
                        return
                except Exception:
                    pass
                w.maximize()
                w._is_max = True
        def close(self):
            if len(webview.windows) > 0:
                webview.windows[0].destroy()
        def browse_folder(self, initial_dir=None):
            if len(webview.windows) > 0:
                res = webview.windows[0].create_file_dialog(webview.FOLDER_DIALOG, directory=initial_dir or "")
                if res and len(res) > 0:
                    return res[0]
            return None
        def start_drag(self):
            import ctypes
            if len(webview.windows) > 0:
                w = webview.windows[0]
                try:
                    import clr
                    from System import Action
                    def _drag():
                        try:
                            hwnd = w.gui.Handle.ToInt32()
                            ctypes.windll.user32.ReleaseCapture()
                            ctypes.windll.user32.SendMessageW(hwnd, 0x00A1, 2, 0)
                        except Exception:
                            pass
                    if getattr(w, 'gui', None):
                        w.gui.Invoke(Action(_drag))
                        return
                except Exception:
                    pass
            try:
                hwnd = ctypes.windll.user32.GetForegroundWindow()
                if not hwnd:
                    hwnd = ctypes.windll.user32.FindWindowW(None, "XDir - Offline Game Manager")
                if hwnd:
                    ctypes.windll.user32.ReleaseCapture()
                    ctypes.windll.user32.SendMessageW(hwnd, 0x00A1, 2, 0)
            except Exception:
                pass

    # Create native Microsoft Edge WebView2 frameless window with an immediate local splash shell
    window = webview.create_window(
        title="XDir - Offline Game Manager",
        html=STARTUP_SPLASH_HTML,
        width=1400,
        height=900,
        min_size=(1000, 600),
        background_color="#0b0c10",
        frameless=True,
        easy_drag=True,
        js_api=WindowApi()
    )
    
    def on_loaded():
        apply_native_window_icon(window)
        
    window.events.loaded += on_loaded
    
    # Store all webview cache/data locally in the app directory so it doesn't touch the C drive
    local_cache_dir = os.path.join(APP_ROOT, "cache")
    os.makedirs(local_cache_dir, exist_ok=True)
    
    webview.start(bootstrap_window, window, private_mode=False, storage_path=local_cache_dir)

if __name__ == "__main__":
    main()
