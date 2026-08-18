"""FastAPI 应用装配：创建 app、挂中间件、注册路由、启动时初始化。

业务逻辑已按领域拆到 routers/（HTTP 层）与 services/（业务层），
本文件只保留装配职责。
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import ml  # cnn 惰性导入（冷启动优化），仅在启动自检需要时加载
from .config import BASE_DIR
from .core.bg import bg
from .db import db, init_db
from .importers import import_all_if_empty, import_extra_games
from .routers import catalog, estimate, health, ocr, vision
from .services import estimator

app = FastAPI(title="竞拍之王估值助手", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def no_cache_html(request, call_next):
    """HTML 不缓存，保证前端每次更新后浏览器都能拿到最新构建产物。"""
    response = await call_next(request)
    if "text/html" in response.headers.get("content-type", ""):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.on_event("startup")
def _startup() -> None:
    try:
        import ctypes

        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:  # noqa: BLE001
        pass
    init_db()
    import_all_if_empty()
    import_extra_games()
    with db() as conn:
        n_games = conn.execute("SELECT COUNT(*) c FROM game_records").fetchone()["c"]
        n_cat = conn.execute("SELECT COUNT(*) c FROM catalog_items").fetchone()["c"]
        ml_stat = ml.model_status(conn)
    if n_games >= ml.MIN_SAMPLES and not ml_stat.get("trained"):
        bg.start("ml", estimator.retrain_ml)
    if n_games > 0:
        # 预热校准系数（含全场 LOESS 曲线）：不预热则估值读不到 calib 缓存，
        # 全程按未校准口径输出。约 20s，放后台不阻塞冷启动。
        bg.start("calib", estimator.warm_calibration)
    if n_cat > 0:
        from . import cnn as cnn_mod  # 惰性导入（冷启动优化）
        if not cnn_mod.status().get("trained"):
            bg.start("cnn", estimator.retrain_cnn)


app.include_router(health.router)
app.include_router(catalog.router)
app.include_router(estimate.router)
app.include_router(ocr.router)
app.include_router(vision.router)


# 前端静态资源（构建产物存在时伺服）
DIST = BASE_DIR / "frontend" / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=str(DIST), html=True), name="frontend")


def run() -> None:
    import threading
    import time
    import webbrowser

    import uvicorn

    def _open() -> None:
        time.sleep(1.6)
        try:
            webbrowser.open("http://127.0.0.1:8000")
        except Exception:  # noqa: BLE001
            pass

    threading.Thread(target=_open, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
