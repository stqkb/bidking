"""本地启动脚本：python backend/run.py"""
from __future__ import annotations

import socket
import threading
import time
import traceback
import urllib.request
import webbrowser

from app.config import BASE_DIR, DATA_DIR

HOST = "127.0.0.1"
PORT = 8000
URL = f"http://{HOST}:{PORT}"


def _port_in_use() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((HOST, PORT))
            return False
        except OSError:
            return True


def _is_our_app() -> bool:
    try:
        with urllib.request.urlopen(f"{URL}/api/health", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def _open_browser() -> None:
    time.sleep(1.8)
    try:
        webbrowser.open(URL)
    except Exception:
        pass


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log_path = DATA_DIR / "app.log"
    if _port_in_use():
        if _is_our_app():
            print(f"[i] App is already running at {URL}, opening browser ...")
            webbrowser.open(URL)
            return 0
        print(f"[ERROR] Port {PORT} is occupied by another program.")
        print("        Close that program first, or change PORT in backend/run.py")
        input("Press Enter to exit ...")
        return 1

    from app.main import app
    import uvicorn

    print(f"Server starting at {URL} ...")
    # 预热视觉模型与特征库，避免首次识别等待模型加载
    def _warm_vision() -> None:
        try:
            from app import vision
            vision._get_model()
            vision._ensure_cache()
            print("[i] Vision model & gallery warmed up.")
        except Exception:  # noqa: BLE001
            pass
    threading.Thread(target=_warm_vision, daemon=True).start()
    threading.Thread(target=_open_browser, daemon=True).start()
    try:
        uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
    except Exception:
        traceback.print_exc()
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(traceback.format_exc())
        print(f"\n[ERROR] See {log_path} for details.")
        input("Press Enter to exit ...")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
