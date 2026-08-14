"""OCR 截图识别与对局导入路由（/api/ocr/*）。"""
from __future__ import annotations

import math
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import ocr as ocr_mod, schemas
from ..core import cache
from ..core.bg import bg
from ..db import db, json_dumps
from ..services import estimator

router = APIRouter()


@router.get("/api/ocr/status")
def ocr_status() -> dict[str, Any]:
    return {"tasks": ocr_mod.list_tasks()}


@router.post("/api/ocr/scan")
def ocr_scan() -> dict[str, Any]:
    g = ocr_mod.scan_folder()
    a = ocr_mod.scan_auction_folder()
    return {**g, "auction_added": a.get("added", 0)}


@router.post("/api/ocr/process_capture")
def ocr_process_capture(body: schemas.OcrProcessCaptureInput) -> dict[str, Any]:
    with db() as conn:
        return ocr_mod.process_capture(conn, body.path)


@router.post("/api/ocr/recognize")
def ocr_recognize(body: schemas.OcrProcessCaptureInput) -> dict[str, Any]:
    with db() as conn:
        return ocr_mod.recognize_single(conn, body.path)


@router.post("/api/ocr/recognize_multi")
def ocr_recognize_multi(body: schemas.OcrRecognizeMultiInput) -> dict[str, Any]:
    with db() as conn:
        return ocr_mod.recognize_multi(conn, body.paths)


@router.post("/api/ocr/save_multi")
def ocr_save_multi(body: schemas.OcrRecognizeMultiInput) -> dict[str, Any]:
    """多图（分割图）识别并保存为一条历史对局记录，触发模型重训。"""
    with db() as conn:
        res = ocr_mod.save_multi_record(conn, body.paths)
    if res.get("saved"):
        bg.start("train", estimator.retrain_all, force=True)
    return res


@router.post("/api/ocr/save_summary")
def ocr_save_summary(body: schemas.SaveSummaryInput) -> dict[str, Any]:
    """将人工勾选确认后的红品汇总 + 结算保存为一局历史记录（供训练）。

    items 为跨图合并去重后的红品清单（name/grid_cells/value）。
    """
    items = [it.model_dump() for it in body.items]
    settlement = body.settlement or {}
    now = datetime.now().isoformat(timespec="seconds")
    with db() as conn:
        game_no = conn.execute(
            "SELECT COALESCE(MAX(game_no),0)+1 m FROM game_records"
        ).fetchone()["m"]
        red_count = len(items)
        cells_list = [int(it.get("grid_cells") or 0) for it in items]
        red_grids = sum(cells_list)
        red_avg = math.floor(red_grids / red_count * 10) / 10 if red_count else None
        combo = "+".join(str(c) for c in sorted(cells_list)) if cells_list else None
        red_value = round(sum(float(it.get("value") or 0) for it in items), 0)
        full_value = settlement.get("total_value")
        deal_price = settlement.get("deal_price")
        profit = settlement.get("profit")
        # 收益核验：profit 是否 = 成交价 - 总价值（不符标红且不进模型训练）
        profit_ok = ocr_mod._check_profit_ok(full_value, deal_price, profit)
        saved_items = [{
            "name": it.get("name"),
            "grid_cells": it.get("grid_cells"),
            "trade_price": float(it.get("value") or 0),
        } for it in items]
        conn.execute(
            """INSERT INTO game_records
               (game_no, grid_combo, red_count, red_grids, red_avg, red_value,
                full_value, deal_price, profit, items_json, won, profit_ok)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (game_no, combo, red_count if red_count else None, red_grids or None,
             red_avg, red_value or None, full_value, deal_price, profit,
             json_dumps(saved_items), 1 if body.won else 0, profit_ok),
        )
    if red_count > 0:
        bg.start("train", estimator.retrain_all, force=True)
    cache.invalidate_games()   # 新增了对局记录
    return {
        "ok": True,
        "game_no": game_no,
        "red_count": red_count,
        "total_cells": red_grids,
        "red_avg": red_avg,
        "red_value": red_value,
        "settlement": settlement,
        "profit_ok": profit_ok,
        "saved_at": now,
    }


@router.post("/api/ocr/confirm/{task_id}")
def ocr_confirm(task_id: int, body: schemas.OcrConfirmInput) -> dict[str, Any]:
    res = ocr_mod.confirm_task(task_id, body.items, body.settlement)
    if res.get("ok"):
        bg.start("train", estimator.retrain_all, force=True)
    return res


@router.delete("/api/ocr/task/{task_id}")
def ocr_delete(task_id: int) -> dict[str, Any]:
    return ocr_mod.delete_task(task_id)


@router.get("/api/ocr/image/{task_id}")
def ocr_image(task_id: int) -> FileResponse:
    with db() as conn:
        row = conn.execute("SELECT path, shape, kind FROM ocr_tasks WHERE id=?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if row["kind"] == "auction":
        folder = Path(row["path"])
        if folder.is_dir():
            imgs = [f for f in folder.iterdir()
                    if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".bmp")]
            if imgs:
                return FileResponse(str(imgs[0]))
        raise HTTPException(status_code=404, detail="图片不存在")
    candidates = [row["path"]]
    if row["shape"]:
        candidates.append(str(ocr_mod.OCR_PROCESSED_DIR / row["shape"] / Path(row["path"]).name))
        candidates.append(str(ocr_mod.OCR_FAILED_DIR / Path(row["path"]).name))
    for p in candidates:
        if Path(p).exists():
            return FileResponse(p)
    raise HTTPException(status_code=404, detail="图片不存在")
