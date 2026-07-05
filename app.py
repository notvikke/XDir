import sys
import os
import time
import threading
import ctypes
import requests
import uvicorn
import webview

# Fix for pythonw where stdout/stderr are None
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w')

from backend.main import app as fastapi_app
from backend.database import init_db, SessionLocal
from backend.ingest import run_ingestion, deduplicate_games
from backend.config import get_settings
from backend.runtime import get_app_root, get_bundle_root

PORT = 8765
SERVER_URL = f"http://127.0.0.1:{PORT}/"
APP_USER_MODEL_ID = "XDir.Library"
APP_ICON_RELATIVE_PATH = os.path.join("extension", "icon128.png")
APP_ROOT = get_app_root()
BUNDLE_ROOT = get_bundle_root()
APP_ICON_PATH = os.path.join(BUNDLE_ROOT, APP_ICON_RELATIVE_PATH)

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

def start_server():
    init_db()
    maintenance_db = SessionLocal()
    try:
        deduplicate_games(maintenance_db)
    except Exception:
        maintenance_db.rollback()
    finally:
        maintenance_db.close()
    settings = get_settings()
    if settings.get('startup_scan', True):
        def bg_ingest():
            time.sleep(1.0) # Allow HTTP server and UI window to initialize first
            try:
                run_ingestion()
            except Exception:
                pass
        threading.Thread(target=bg_ingest, daemon=True).start()
    uvicorn.run(fastapi_app, host="127.0.0.1", port=PORT, log_level="warning")

def main():
    configure_windows_shell_identity()

    # Start FastAPI server in background daemon thread
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()
    
    # Check if user passed --server-only
    if "--server-only" in sys.argv:
        print(f"Running XDir Library server in background on {SERVER_URL}")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("Shutting down.")
            sys.exit(0)
            
    # Wait for server to be ready before opening window
    for _ in range(50):
        try:
            r = requests.get(f"http://127.0.0.1:{PORT}/api/stats", timeout=0.2)
            if r.status_code == 200:
                break
        except Exception:
            time.sleep(0.1)
            
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

    # Create native Microsoft Edge WebView2 frameless high-performance DirectX window
    window = webview.create_window(
        title="XDir - Offline Game Manager",
        url=SERVER_URL + "?v=11",
        width=1400,
        height=900,
        min_size=(1000, 600),
        background_color="#0b0c10",
        frameless=True,
        hidden=True,
        easy_drag=True,
        js_api=WindowApi()
    )
    
    def on_loaded():
        time.sleep(0.15)
        apply_native_window_icon(window)
        window.show()
        
    window.events.loaded += on_loaded
    
    # Store all webview cache/data locally in the app directory so it doesn't touch the C drive
    local_cache_dir = os.path.join(APP_ROOT, "cache")
    os.makedirs(local_cache_dir, exist_ok=True)
    
    webview.start(private_mode=False, storage_path=local_cache_dir)

if __name__ == "__main__":
    main()
