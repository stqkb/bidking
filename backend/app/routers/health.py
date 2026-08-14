"""健康检查与系统状态路由。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ..core.bg import bg
from ..db import db

router = APIRouter()


@router.get("/api/health")
def health() -> dict[str, Any]:
    with db() as conn:
        n_cat = conn.execute("SELECT COUNT(*) c FROM catalog_items").fetchone()["c"]
        n_games = conn.execute("SELECT COUNT(*) c FROM game_records").fetchone()["c"]
    return {
        "ok": True,
        "catalog": n_cat,
        "games": n_games,
        "ml_bg": bg.status("ml"),
        "cnn_bg": bg.status("cnn"),
    }
