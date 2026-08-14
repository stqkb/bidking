"""FastAPI 入口与业务编排。"""
from __future__ import annotations

import threading
import math
import os
import time
import uuid
import io
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi import File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import cnn as cnn_mod
from . import engine, ml, ocr as ocr_mod, schemas, vision
from .config import BASE_DIR, DATA_DIR, XLSX_SOURCE
from .db import db, init_db, json_dumps
from .importers import import_all_if_empty, import_catalog, identify_item, import_extra_games

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


_bg_lock = threading.Lock()
_bg_tasks: dict[str, bool] = {}


def _catalog_value(name: str) -> float | None:
    """按名称查图鉴当前值（交易行价 current_value，否则系统价 value）。"""
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT value, current_value FROM catalog_items WHERE name=?", (name,)
            ).fetchone()
        if row is None:
            return None
        return float(row["current_value"] or row["value"] or 0)
    except Exception:  # noqa: BLE001
        return None


def _bg_retrain() -> None:
    with db() as conn:
        result = ml.retrain(conn)
    with _bg_lock:
        _bg_tasks["ml"] = True


def _bg_cnn() -> None:
    with db() as conn:
        result = cnn_mod.train(conn)
    with _bg_lock:
        _bg_tasks["cnn"] = True


def _start_bg(name: str, fn, force: bool = False) -> None:
    with _bg_lock:
        if not force and _bg_tasks.get(name) is not None:
            return
        _bg_tasks[name] = False
    threading.Thread(target=fn, daemon=True).start()


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
        _start_bg("ml", _bg_retrain)
    if n_cat > 0 and not cnn_mod.status().get("trained"):
        _start_bg("cnn", _bg_cnn)


@app.get("/api/health")
def health() -> dict[str, Any]:
    with db() as conn:
        n_cat = conn.execute("SELECT COUNT(*) c FROM catalog_items").fetchone()["c"]
        n_games = conn.execute("SELECT COUNT(*) c FROM game_records").fetchone()["c"]
    return {
        "ok": True,
        "catalog": n_cat,
        "games": n_games,
        "ml_bg": _bg_tasks.get("ml"),
        "cnn_bg": _bg_tasks.get("cnn"),
    }


@app.get("/api/catalog")
def catalog() -> dict[str, Any]:
    with db() as conn:
        stats = engine.get_catalog_stats(conn)
        total = conn.execute("SELECT COUNT(*) c FROM catalog_items").fetchone()["c"]
    out = {
        "total": total,
        "grids": [
            {
                "grid_cells": g,
                "count": s["count"],
                "mean": round(s["mean"], 0),
                "median": round(s["median"], 0),
                "p10": round(s["p10"], 0),
                "p90": round(s["p90"], 0),
                "min": round(s["min"], 0),
                "max": round(s["max"], 0),
            }
            for g, s in sorted(stats.items())
        ],
    }
    return out


@app.get("/api/catalog/items")
def catalog_items() -> dict[str, Any]:
    with db() as conn:
        rows = conn.execute(
            "SELECT id, name, grid_cells, value FROM catalog_items ORDER BY grid_cells, value DESC"
        ).fetchall()
    return {"items": [dict(r) for r in rows]}


class IdentifyInput(BaseModel):
    grid_cells: int
    price: Optional[float] = None


@app.post("/api/catalog/identify")
def catalog_identify(body: IdentifyInput) -> dict[str, Any]:
    with db() as conn:
        matches = identify_item(conn, body.grid_cells, body.price)
    return {"matches": matches}


class ImportBody(BaseModel):
    path: str | None = None


@app.post("/api/catalog/import")
def catalog_import(body: ImportBody) -> dict[str, Any]:
    path = Path(body.path) if body.path else XLSX_SOURCE
    n = import_catalog(path)
    if n == 0:
        raise HTTPException(status_code=400, detail="未读取到图鉴数据，请检查文件路径")
    return {"imported": n}


@app.get("/api/games")
def games() -> dict[str, Any]:
    with db() as conn:
        rows = conn.execute("SELECT * FROM game_records ORDER BY game_no").fetchall()
    import json
    out = []
    for r in rows:
        d = dict(r)
        d["items"] = json.loads(d.pop("items_json") or "[]")
        out.append(d)
    return {"games": out}


@app.get("/api/records")
def records() -> dict[str, Any]:
    import json
    with db() as conn:
        rows = conn.execute("SELECT * FROM user_records ORDER BY created_at DESC").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["inputs"] = json.loads(d.pop("inputs_json") or "{}")
        d["prediction"] = json.loads(d.pop("prediction_json") or "null")
        d["actual"] = json.loads(d.pop("actual_json") or "null")
        out.append(d)
    return {"records": out}


@app.post("/api/records")
def record_create(body: schemas.RecordCreate) -> dict[str, Any]:
    rid = uuid.uuid4().hex[:12]
    now = datetime.now().isoformat(timespec="seconds")
    with db() as conn:
        conn.execute(
            """INSERT INTO user_records
               (id, game_no, created_at, updated_at, inputs_json, prediction_json,
                bid, actual_json, status, note)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (rid, body.game_no, now, now, json_dumps(body.inputs),
             json_dumps(body.prediction), body.bid,
             json_dumps(body.actual if body.status == "completed" else None),
             body.status, body.note),
        )
    return {"id": rid}


@app.patch("/api/records/{rid}")
def record_update(rid: str, body: schemas.RecordUpdate) -> dict[str, Any]:
    now = datetime.now().isoformat(timespec="seconds")
    with db() as conn:
        row = conn.execute("SELECT * FROM user_records WHERE id=?", (rid,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="记录不存在")
        cur = dict(row)
        status = body.status or cur["status"]
        actual = json_dumps(body.actual) if body.actual is not None else cur["actual_json"]
        conn.execute(
            """UPDATE user_records SET bid=?, status=?, note=?, actual_json=?, updated_at=?
               WHERE id=?""",
            (body.bid if body.bid is not None else cur["bid"],
             status, body.note if body.note is not None else cur["note"],
             actual, now, rid),
        )
    if status == "completed":
        _start_bg("ml", _bg_retrain)
    return {"id": rid, "status": status}


@app.delete("/api/records/{rid}")
def record_delete(rid: str) -> dict[str, Any]:
    with db() as conn:
        conn.execute("DELETE FROM user_records WHERE id=?", (rid,))
    return {"ok": True}


def _merge_ml(rule: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """ML 可用时覆盖红品/全场估值与出价。"""
    with db() as conn:
        m = ml.predict(conn, inputs, rule)
    if not m.get("available"):
        rule["ml"] = {"available": False}
        return rule
    margin = float(inputs.get("margin") or 0.84)
    red = m["red"]
    full = m["full"]
    rule["ml"] = m

    known_total = 0.0
    known_items_raw = inputs.get("known_items") or []
    if known_items_raw:
        for it in known_items_raw:
            if isinstance(it, dict) and it.get("value"):
                known_total += float(it["value"])
    elif inputs.get("known_value"):
        known_total = float(inputs["known_value"])

    if known_total > 0:
        # 有已知藏品实际价值时，ML 与规则各半融合：
        # 避免旧样本训练的 ML 把按 Excel 图鉴价算出的期望压得过低。
        r, f = rule["red"], rule["full"]
        for k in ("ev", "p10", "p50", "p90"):
            rule["red"][k] = 0.5 * r[k] + 0.5 * red[k]
            rule["full"][k] = 0.5 * f[k] + 0.5 * full[k]
        rule["ml"]["blended"] = True
    else:
        rule["red"]["ev"] = red["ev"]
        rule["red"]["p10"] = red["p10"]
        rule["red"]["p50"] = red["p50"]
        rule["red"]["p90"] = red["p90"]
        rule["full"]["ev"] = full["ev"]
        rule["full"]["p10"] = full["p10"]
        rule["full"]["p50"] = full["p50"]
        rule["full"]["p90"] = full["p90"]
    risk, risk_score = engine.risk_level(rule["full"])
    min_bid_input = inputs.get("min_bid")
    margin = float(inputs.get("margin") or 0.85)
    rule["bid"] = engine.compute_bid(
        rule["full"], margin,
        float(min_bid_input) if min_bid_input else None,
    )
    return rule


def _merge_cnn(rule: dict[str, Any], board: list[list[int]]) -> dict[str, Any]:
    res = cnn_mod.predict_board(board)
    rule["cnn"] = res
    if not res.get("ok"):
        return rule
    margin = float(rule["bid"]["margin"])
    # 50/50 融合：CNN 与当前红品期望
    red = rule["red"]
    cnn_v = float(res["value"])
    ratio = rule["full"]["ev"] / red["ev"] if red["ev"] > 0 else None
    if ratio is None:
        with db() as conn:
            ratio = engine.get_full_ratio(conn)
    red["ev"] = 0.5 * red["ev"] + 0.5 * cnn_v
    red["p10"] = 0.5 * red["p10"] + 0.5 * cnn_v * 0.8
    red["p90"] = 0.5 * red["p90"] + 0.5 * cnn_v * 1.2
    red["p50"] = 0.5 * red["p50"] + 0.5 * cnn_v
    full = rule["full"]
    full["ev"] = red["ev"] * ratio
    full["p10"] = red["p10"] * ratio
    full["p50"] = red["p50"] * ratio
    full["p90"] = red["p90"] * ratio
    risk, risk_score = engine.risk_level(full)
    margin = float(rule["bid"]["margin"])
    rule["bid"] = engine.compute_bid(full, margin)
    return rule


@app.post("/api/estimate")
def estimate(body: schemas.EstimateInput) -> dict[str, Any]:
    inputs = body.model_dump()
    with db() as conn:
        rule = engine.run_estimate(conn, inputs)
    if "error" in rule:
        raise HTTPException(status_code=400, detail=rule["error"])
    sel = rule.get("selected") or {}
    if sel.get("applied"):
        # ML 特征按锁定候选的格数/件数计算，避免与锁定后的规则估值错位。
        inputs["red_grids"] = sel["red_grids"]
        inputs["red_count"] = sel["red_count"]
    rule = _merge_ml(rule, inputs)
    if body.board is not None:
        rule = _merge_cnn(rule, body.board)
    return rule


@app.post("/api/model/retrain")
def model_retrain() -> dict[str, Any]:
    _start_bg("ml", _bg_retrain, force=True)
    return {"started": True}


@app.get("/api/model/status")
def model_status() -> dict[str, Any]:
    with db() as conn:
        return ml.model_status(conn)


@app.post("/api/cnn/train")
def cnn_train() -> dict[str, Any]:
    _start_bg("cnn", _bg_cnn, force=True)
    return {"started": True}


@app.get("/api/cnn/status")
def cnn_status() -> dict[str, Any]:
    return cnn_mod.status()


@app.post("/api/cnn/predict")
def cnn_predict(body: schemas.CnnPredictInput) -> dict[str, Any]:
    return cnn_mod.predict_board(body.board)


class OcrConfirmInput(BaseModel):
    items: list[dict[str, Any]] = []
    settlement: dict[str, Any] = {}


@app.get("/api/ocr/status")
def ocr_status() -> dict[str, Any]:
    return {"tasks": ocr_mod.list_tasks()}


@app.post("/api/ocr/scan")
def ocr_scan() -> dict[str, Any]:
    g = ocr_mod.scan_folder()
    a = ocr_mod.scan_auction_folder()
    return {**g, "auction_added": a.get("added", 0)}


class OcrProcessCaptureInput(BaseModel):
    path: str


class OcrRecognizeMultiInput(BaseModel):
    paths: list[str]


class SummaryItemInput(BaseModel):
    name: str
    grid_cells: int = 0
    value: float = 0


class SaveSummaryInput(BaseModel):
    items: list[SummaryItemInput] = []
    settlement: dict[str, Any] = {}


@app.post("/api/ocr/process_capture")
def ocr_process_capture(body: OcrProcessCaptureInput) -> dict[str, Any]:
    with db() as conn:
        return ocr_mod.process_capture(conn, body.path)


@app.post("/api/ocr/recognize")
def ocr_recognize(body: OcrProcessCaptureInput) -> dict[str, Any]:
    with db() as conn:
        return ocr_mod.recognize_single(conn, body.path)


@app.post("/api/ocr/recognize_multi")
def ocr_recognize_multi(body: OcrRecognizeMultiInput) -> dict[str, Any]:
    with db() as conn:
        return ocr_mod.recognize_multi(conn, body.paths)


@app.post("/api/ocr/save_multi")
def ocr_save_multi(body: OcrRecognizeMultiInput) -> dict[str, Any]:
    """多图（分割图）识别并保存为一条历史对局记录，触发模型重训。"""
    with db() as conn:
        res = ocr_mod.save_multi_record(conn, body.paths)
    if res.get("saved"):
        _start_bg("ml", _bg_retrain, force=True)
        _start_bg("cnn", _bg_cnn, force=True)
    return res


@app.post("/api/ocr/save_summary")
def ocr_save_summary(body: SaveSummaryInput) -> dict[str, Any]:
    """将人工勾选确认后的红品汇总 + 结算保存为一局历史记录（供训练）。
    items 为跨图合并去重后的红品清单（name/grid_cells/value）。"""
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
        saved_items = [{
            "name": it.get("name"),
            "grid_cells": it.get("grid_cells"),
            "trade_price": float(it.get("value") or 0),
        } for it in items]
        conn.execute(
            """INSERT INTO game_records
               (game_no, grid_combo, red_count, red_grids, red_avg, red_value,
                full_value, deal_price, profit, items_json)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (game_no, combo, red_count if red_count else None, red_grids or None,
             red_avg, red_value or None, full_value, deal_price, profit,
             json_dumps(saved_items)),
        )
    if red_count > 0:
        _start_bg("ml", _bg_retrain, force=True)
        _start_bg("cnn", _bg_cnn, force=True)
    return {
        "ok": True,
        "game_no": game_no,
        "red_count": red_count,
        "total_cells": red_grids,
        "red_avg": red_avg,
        "red_value": red_value,
        "settlement": settlement,
        "saved_at": now,
    }


@app.post("/api/ocr/confirm/{task_id}")
def ocr_confirm(task_id: int, body: OcrConfirmInput) -> dict[str, Any]:
    res = ocr_mod.confirm_task(task_id, body.items, body.settlement)
    if res.get("ok"):
        _start_bg("ml", _bg_retrain, force=True)
        _start_bg("cnn", _bg_cnn, force=True)
    return res


@app.delete("/api/ocr/task/{task_id}")
def ocr_delete(task_id: int) -> dict[str, Any]:
    return ocr_mod.delete_task(task_id)


@app.get("/api/ocr/image/{task_id}")
def ocr_image(task_id: int) -> FileResponse:
    from pathlib import Path

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


@app.get("/api/vision/gallery")
def vision_gallery() -> dict[str, Any]:
    with db() as conn:
        return vision.gallery(conn)


@app.get("/api/vision/model_status")
def vision_model_status() -> dict[str, Any]:
    """红品识别模型状态：特征库样本、GPU、区分度。"""
    return vision.recognition_status()


@app.post("/api/vision/model_rebuild")
def vision_model_rebuild() -> dict[str, Any]:
    """重建红品识别特征库（GPU 加速）。"""
    return vision.rebuild_features()


@app.get("/api/vision/image/{crop_id}")
def vision_image(crop_id: int) -> FileResponse:
    manifest = vision._load_manifest()
    if crop_id < 0 or crop_id >= len(manifest):
        raise HTTPException(status_code=404, detail="图像不存在")
    p = manifest[crop_id]["path"]
    from pathlib import Path
    if not Path(p).exists():
        raise HTTPException(status_code=404, detail="图像不存在")
    return FileResponse(p)


class CatalogDeleteInput(BaseModel):
    ids: list[int] = []


@app.post("/api/catalog/delete")
def catalog_delete(body: CatalogDeleteInput) -> dict[str, Any]:
    if not body.ids:
        return {"ok": False, "error": "未选择任何藏品"}
    names: list[str] = []
    with db() as conn:
        names = [r["name"] for r in conn.execute(
            f"SELECT name FROM catalog_items WHERE id IN ({','.join('?' * len(body.ids))})",
            body.ids,
        ).fetchall()]
        cur = conn.execute(
            f"DELETE FROM catalog_items WHERE id IN ({','.join('?' * len(body.ids))})",
            body.ids,
        )
        deleted = cur.rowcount
    if names:
        vision.delete_crops_for_names(names)
    if deleted > 0:
        _start_bg("ml", _bg_retrain, force=True)
        _start_bg("cnn", _bg_cnn, force=True)
    return {"ok": True, "deleted": deleted}


class LearnInput(BaseModel):
    image_path: str
    box: list[int]
    name: str
    grid_cells: int = 0


@app.post("/api/vision/learn")
def vision_learn(body: LearnInput) -> dict[str, Any]:
    from pathlib import Path
    from PIL import Image

    if body.image_path.startswith("task:"):
        tid = int(body.image_path.split(":", 1)[1])
        with db() as conn:
            row = conn.execute("SELECT path, shape FROM ocr_tasks WHERE id=?", (tid,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        p = Path(row["path"])
        if not p.exists() and row["shape"]:
            p = ocr_mod.OCR_PROCESSED_DIR / row["shape"] / p.name
    else:
        p = Path(body.image_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="请填写藏品名称")
    im = Image.open(p).convert("RGB")
    x0, y0, x1, y1 = body.box
    x0, x1 = sorted((max(0, min(x0, im.width)), max(0, min(x1, im.width))))
    y0, y1 = sorted((max(0, min(y0, im.height)), max(0, min(y1, im.height))))
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise HTTPException(status_code=400, detail="框选区域太小，请重新框选")
    crop = im.crop((x0, y0, x1, y1))
    vision.add_crop(name, body.grid_cells, crop, source="learn")
    return {"ok": True, "name": name, "grid_cells": body.grid_cells}


class AnnotateInput(BaseModel):
    image_path: str
    box: list[int]
    kind: str  # "red" | "total" | "deal" | "profit"
    name: str = ""
    grid_cells: int = 0
    value: float | None = None


class OcrBoxInput(BaseModel):
    image_path: str
    box: list[int]


class ImagePathInput(BaseModel):
    image_path: str


@app.post("/api/vision/annotate")
def vision_annotate(body: AnnotateInput) -> dict[str, Any]:
    """人工标注校准：框选红品（入库学习）或结算字段（总价值/成交价/收益）。"""
    from pathlib import Path
    from PIL import Image

    if not body.box or len(body.box) != 4:
        raise HTTPException(status_code=400, detail="请先框选区域")
    p = Path(body.image_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    x0, y0, x1, y1 = body.box
    x0, x1 = sorted((max(0, min(x0, 100000)), max(0, min(x1, 100000))))
    y0, y1 = sorted((max(0, min(y0, 100000)), max(0, min(y1, 100000))))
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise HTTPException(status_code=400, detail="框选区域太小")
    im = Image.open(p).convert("RGB")
    crop = im.crop((x0, y0, x1, y1))
    now = datetime.now().isoformat(timespec="seconds")
    if body.kind == "red":
        if not body.name.strip():
            raise HTTPException(status_code=400, detail="请填写红品名称")
        vision.add_crop(body.name.strip(), body.grid_cells or 0, crop, source="learn")
        with db() as conn:
            conn.execute(
                """INSERT INTO vision_annotations(image_path, box, kind, name, grid_cells, value, created_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (str(p), str(body.box), "red", body.name.strip(), body.grid_cells or 0, body.value, now),
            )
        return {"ok": True, "kind": "red", "name": body.name.strip()}
    with db() as conn:
        conn.execute(
            """INSERT INTO vision_annotations(image_path, box, kind, name, grid_cells, value, created_at)
               VALUES (?,?,?,?,?,?,?)""",
            (str(p), str(body.box), body.kind, body.name, body.grid_cells or 0, body.value, now),
        )
    return {"ok": True, "kind": body.kind, "value": body.value}


@app.post("/api/vision/ocr_box")
def vision_ocr_box(body: OcrBoxInput) -> dict[str, Any]:
    """对框选区域做 OCR，返回文字与数字（用于结算字段标注辅助）。"""
    from pathlib import Path
    from PIL import Image, ImageOps, ImageEnhance

    p = Path(body.image_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    x0, y0, x1, y1 = body.box
    im = Image.open(p).convert("RGB").crop((x0, y0, x1, y1))
    im = ImageOps.autocontrast(ImageEnhance.Contrast(im).enhance(2.0))
    tmp = str(Path(os.environ.get("TEMP", ".")) / f"_ocrbox_{int(time.time()*1000)}.png")
    im.save(tmp)
    try:
        boxes = ocr_mod._ocr_run(tmp)
    finally:
        Path(tmp).unlink(missing_ok=True)
    texts = [b["text"] for b in boxes]
    return {"ok": True, "texts": texts, "ocr": boxes}


@app.post("/api/vision/auto_detect")
def vision_auto_detect(body: ImagePathInput) -> dict[str, Any]:
    """自动检测图片中的红品格子，返回每个格子的裁剪图与视觉候选，供人工勾选标注。"""
    from pathlib import Path
    from PIL import Image

    p = Path(body.image_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    pil = Image.open(p).convert("RGB")
    a = np.asarray(pil).astype(int)
    H, W, _ = a.shape
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    # 统一红底判定：兼容旧版亮红(≈101,66,79)与新版深红(≈60,30,28)。
    # 核心特征：R-G≥30（红色主导；金色 R-G≈10-15、棕色图标 R-G≈16-18 均排除）、
    # R≥B+6、G≈B（|G-B|≤16，金色 G-B≈20 排除）。
    red_bg = (
        (R - G >= 30) & (R >= B + 6) & (np.abs(G - B) <= 16)
        & (R >= 35) & (R <= 150) & (G >= 15) & (G <= 90) & (B >= 15) & (B <= 95)
    )
    mask = red_bg.astype(np.uint8) * 255
    import cv2

    k = np.ones((3, 3), np.uint8)
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)
    n, labels, stats, cents = cv2.connectedComponentsWithStats(closed, connectivity=8)
    cells = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if y > H * 0.84:
            continue
        if w < 26 or h < 26 or area < 600:
            continue
        sub = a[y:y + h, x:x + w]
        rR, rG, rB = sub[..., 0], sub[..., 1], sub[..., 2]
        # 格内红底填充检测：比连通域掩码略宽松（处理抗锯齿），但仍排除金/棕
        is_red = (
            (rR - rG >= 24) & (rR >= rB + 4) & (np.abs(rG - rB) <= 20)
            & (rR >= 28) & (rR <= 170) & (rG >= 10) & (rG <= 105) & (rB >= 10) & (rB <= 110)
        )
        fill = is_red.mean()
        if fill < 0.30:
            continue
        # 背景主色校验：格子四周边缘背景必须满足红底判定（排除金底与棕褐图标）
        border = np.concatenate([
            sub[: max(3, h // 12)].reshape(-1, 3),
            sub[-max(3, h // 12):].reshape(-1, 3),
            sub[:, : max(3, w // 12)].reshape(-1, 3),
            sub[:, -max(3, w // 12):].reshape(-1, 3),
        ])
        lum = border.mean(axis=1)
        border = border[(lum > 25) & (lum < 240)]
        if len(border) >= 30:
            bg = np.median(border, axis=0)
            br, bgr, bb = float(bg[0]), float(bg[1]), float(bg[2])
            ok_border = (
                (br - bgr >= 24) & (br >= bb + 4) & (abs(bgr - bb) <= 20)
                & (28 <= br <= 170) & (10 <= bgr <= 105) & (10 <= bb <= 110)
            )
            if not ok_border:
                continue
        # 图标 = 非红色、有足够饱和度的彩色像素（排除白字/灰白描边/纯黑）
        mx = np.maximum(np.maximum(rR, rG), rB)
        mn = np.minimum(np.minimum(rR, rG), rB)
        sat = mx - mn
        icon = ~is_red & (sat >= 30) & ~((rR < 40) & (rG < 40) & (rB < 40))
        # 真正的红品格子：内部必须有足够多的彩色图标像素
        if icon.mean() < 0.06:
            continue
        imask = icon.astype(np.uint8) * 255
        # 先腐蚀去掉红背景边缘渗入的像素，再闭运算连接图标内部
        erode_k = np.ones((2, 2), np.uint8)
        imask = cv2.erode(imask, erode_k)
        ik = np.ones((4, 4), np.uint8)
        iclosed = cv2.morphologyEx(imask, cv2.MORPH_CLOSE, ik)
        ret, ilab, ist, icen = cv2.connectedComponentsWithStats(iclosed, connectivity=8)
        best = None
        for j in range(1, ret):
            ix, iy, iw, ih, ia = ist[j]
            if 20 <= iw <= 260 and 20 <= ih <= 260 and ia >= 200:
                if best is None or ia > best[4]:
                    best = (ix, iy, iw, ih, ia)
        if best:
            ix, iy, iw, ih, ia = best
            # 红品图标应接近方形或竖直：宽高比 0.45~2.2（排除扁条/细线碎片）
            ratio = iw / max(ih, 1)
            if ratio < 0.45 or ratio > 2.2:
                continue
            if iw < 30 or ih < 30:
                continue
            cells.append({
                "cell": [int(x), int(y), int(x + w), int(y + h)],
                "icon": [int(x + ix), int(y + iy), int(x + ix + iw), int(y + iy + ih)],
            })
    # 对每个格子图标做视觉匹配：整批一次编码（单次 GPU forward），不再逐格落盘
    crops = []
    for c in cells:
        ix0, iy0, ix1, iy1 = c["icon"]
        pad = 4
        crops.append(pil.crop((max(0, ix0 - pad), max(0, iy0 - pad), min(W, ix1 + pad), min(H, iy1 + pad))))
    out = []
    if crops:
        vs = vision.match_crops(crops, topk=5)
        for c, v in zip(cells, vs):
            matches = [
                {
                    "name": m["name"],
                    "grid_cells": m["grid_cells"],
                    "score": m["score"],
                    "value": _catalog_value(m["name"]),
                }
                for m in v.get("matches", [])[:5]
            ]
            out.append({"cell": c["cell"], "icon": c["icon"], "crop_path": None, "matches": matches})
    if not out:
        # 场景1：单件红品截图（红底/金底/深底均可）——整图直配。
        # 判定"单件"：最大彩色区域占图面积 >= 35% 且明显大于次大区域。
        mx2 = np.maximum(np.maximum(R, G), B)
        mn2 = np.minimum(np.minimum(R, G), B)
        sat2 = (mx2 - mn2 >= 22) & (mx2 >= 35)
        sclosed = cv2.morphologyEx(sat2.astype(np.uint8) * 255, cv2.MORPH_CLOSE, k)
        sn2, sl2, sst2, sc2 = cv2.connectedComponentsWithStats(sclosed, connectivity=8)
        comps2 = sorted((s for s in sst2[1:]), key=lambda s: -s[4])
        if comps2:
            top_area = float(comps2[0][4])
            second_area = float(comps2[1][4]) if len(comps2) > 1 else 0.0
            total_area = float(H * W)
            if top_area >= total_area * 0.35 and top_area >= 3.0 * max(second_area, 1.0):
                tmp = str(Path(os.environ.get("TEMP", ".")) / f"_detect_single_{int(time.time()*1000)}.png")
                pil.save(tmp)
                try:
                    v = vision.match_crop(tmp, topk=5)
                    matches = [
                        {
                            "name": m["name"],
                            "grid_cells": m["grid_cells"],
                            "score": m["score"],
                            "value": _catalog_value(m["name"]),
                        }
                        for m in v.get("matches", [])[:5]
                    ]
                    if matches and matches[0]["score"] >= 0.80:
                        out.append({"cell": [0, 0, W, H], "icon": [0, 0, W, H], "crop_path": tmp, "matches": matches})
                finally:
                    Path(tmp).unlink(missing_ok=True)
        # 场景2：整图以红底为主（旧回退）
        if not out:
            red_ratio = float(red_bg.mean())
            if red_ratio >= 0.03:
                tmp = str(Path(os.environ.get("TEMP", ".")) / f"_detect_single_{int(time.time()*1000)}.png")
                pil.save(tmp)
                try:
                    v = vision.match_crop(tmp, topk=5)
                    matches = [
                        {
                            "name": m["name"],
                            "grid_cells": m["grid_cells"],
                            "score": m["score"],
                            "value": _catalog_value(m["name"]),
                        }
                        for m in v.get("matches", [])[:5]
                    ]
                finally:
                    Path(tmp).unlink(missing_ok=True)
                out.append({"cell": [0, 0, W, H], "icon": [0, 0, W, H], "crop_path": tmp, "matches": matches})
    return {"ok": True, "cells": out}


@app.get("/api/vision/crop_box")
def vision_crop_box(image_path: str, box: str) -> FileResponse:
    """按原始坐标裁剪图片区域（用于标注记录缩略图）。box = "x0,y0,x1,y1"。"""
    from pathlib import Path
    from PIL import Image

    p = Path(image_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    try:
        x0, y0, x1, y1 = [int(v) for v in box.split(",")]
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="box 格式错误")
    im = Image.open(p).convert("RGB").crop((x0, y0, x1, y1))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    buf.seek(0)
    return Response(content=buf.read(), media_type="image/png")


@app.get("/api/vision/annotations")
def vision_annotations(image_path: str = "") -> dict[str, Any]:
    """列出标注记录，可按图片路径过滤。"""
    with db() as conn:
        if image_path:
            rows = conn.execute(
                "SELECT * FROM vision_annotations WHERE image_path=? ORDER BY id", (image_path,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM vision_annotations ORDER BY id DESC LIMIT 200").fetchall()
    return {"annotations": [dict(r) for r in rows]}


class LearnDeleteInput(BaseModel):
    names: list[str] = []


@app.post("/api/vision/delete_learn")
def vision_delete_learn(body: LearnDeleteInput) -> dict[str, Any]:
    return vision.delete_learn_samples(body.names)


class ImageDeleteInput(BaseModel):
    paths: list[str] = []


@app.post("/api/vision/delete_images")
def vision_delete_images(body: ImageDeleteInput) -> dict[str, Any]:
    return vision.delete_manifest_entries(body.paths)


@app.post("/api/vision/cleanup")
def vision_cleanup() -> dict[str, Any]:
    return vision.cleanup_orphans()


class TrimInput(BaseModel):
    max_per_name: int = 5


@app.post("/api/vision/trim")
def vision_trim(body: TrimInput) -> dict[str, Any]:
    return vision.trim_gallery(max(1, body.max_per_name))


@app.get("/api/vision/uploaded")
def vision_uploaded(path: str) -> FileResponse:
    from pathlib import Path

    # 容错：Windows 下路径可能混用反斜杠，统一转正斜杠再解析
    p = Path(path.replace("\\", "/"))
    if not p.exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    return FileResponse(str(p))


@app.post("/api/capture")
def capture_screen() -> dict[str, Any]:
    """截取《竞拍之王》游戏窗口（找不到则截全屏），返回图片路径供图像学习框选。"""
    import ctypes
    import ctypes.wintypes
    import time
    from datetime import datetime
    from uuid import uuid4

    from PIL import Image, ImageGrab

    cap_dir = DATA_DIR / "captures"
    cap_dir.mkdir(parents=True, exist_ok=True)
    window = None
    window_title = ""

    def _find_game_window():
        user32 = ctypes.windll.user32
        result = []
        # 保证坐标与截取一致（物理像素）
        try:
            user32.SetProcessDPIAware()
        except Exception:  # noqa: BLE001
            pass

        def _cb(hwnd, _lparam):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buf = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buf, length + 1)
                title = buf.value
                if any(x in title for x in ("估值助手", "Edge", "Chrome", "Firefox", "浏览器", "360")):
                    return True
                if ("竞拍" in title) or ("BidKing" in title) or ("拍卖" in title):
                    if user32.IsWindowVisible(hwnd):
                        rect = ctypes.wintypes.RECT()
                        user32.GetWindowRect(hwnd, ctypes.byref(rect))
                        w = rect.right - rect.left
                        h = rect.bottom - rect.top
                        if w > 200 and h > 200:
                            result.append((title, (rect.left, rect.top, rect.right, rect.bottom), hwnd))
            return True

        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        user32.EnumWindows(WNDENUMPROC(_cb), 0)
        return result

    try:
        wins = _find_game_window()
        if wins:
            wins.sort(key=lambda x: (x[1][2] - x[1][0]) * (x[1][3] - x[1][1]), reverse=True)
            title, rect, hwnd = wins[0]
            window_title = title
            user32 = ctypes.windll.user32
            # 还原最小化窗口并调到前台，避免截到被遮挡内容
            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.4)
            r2 = ctypes.wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r2))
            window = (r2.left, r2.top, r2.right, r2.bottom)
    except Exception:  # noqa: BLE001
        window = None

    try:
        if window:
            # 裁剪到虚拟屏幕范围内
            vx = ctypes.windll.user32.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
            vy = ctypes.windll.user32.GetSystemMetrics(77)
            vw = ctypes.windll.user32.GetSystemMetrics(78)
            vh = ctypes.windll.user32.GetSystemMetrics(79)
            bbox = (
                max(window[0], vx),
                max(window[1], vy),
                min(window[2], vx + vw),
                min(window[3], vy + vh),
            )
            if bbox[2] - bbox[0] > 0 and bbox[3] - bbox[1] > 0:
                img = ImageGrab.grab(bbox=bbox)
            else:
                img = ImageGrab.grab(all_screens=True)
        else:
            img = ImageGrab.grab(all_screens=True)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"截屏失败：{e}"}

    p = cap_dir / f"{datetime.now().strftime('%H%M%S')}_{uuid4().hex[:6]}.png"
    img.convert("RGB").save(p)
    return {
        "ok": True,
        "path": str(p),
        "source": "game_window" if window else "fullscreen",
        "window_title": window_title,
    }


@app.post("/api/clipboard")
def clipboard_snip() -> dict[str, Any]:
    """读取剪贴板中的截图（Win+Shift+S 后自动在剪贴板），保存为图片供学习。"""
    import hashlib
    from datetime import datetime
    from uuid import uuid4

    from PIL import Image, ImageGrab

    cap_dir = DATA_DIR / "captures"
    cap_dir.mkdir(parents=True, exist_ok=True)
    img = None
    try:
        data = ImageGrab.grabclipboard()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"读取剪贴板失败：{e}"}
    if isinstance(data, list):
        for p in data:
            if str(p).lower().endswith((".png", ".jpg", ".jpeg", ".bmp")):
                try:
                    img = Image.open(p).convert("RGB")
                    break
                except Exception:  # noqa: BLE001
                    continue
    elif isinstance(data, Image.Image):
        img = data.convert("RGB")
    if img is None:
        return {"ok": False, "error": "剪贴板中没有图片，请先按 Win+Shift+S 截图"}
    p = cap_dir / f"clip_{datetime.now().strftime('%H%M%S')}_{uuid4().hex[:6]}.png"
    img.save(p)
    h = hashlib.md5(open(p, "rb").read()).hexdigest()
    return {"ok": True, "path": str(p), "hash": h}


@app.post("/api/vision/upload")
async def vision_upload(file: UploadFile = File(...)) -> dict[str, Any]:
    import io
    from uuid import uuid4

    from PIL import Image

    data = await file.read()
    up = DATA_DIR / "uploads"
    up.mkdir(parents=True, exist_ok=True)
    p = up / f"{uuid4().hex}.png"
    Image.open(io.BytesIO(data)).convert("RGB").save(p)
    return {"path": str(p)}


@app.post("/api/vision/upload_multi")
async def vision_upload_multi(files: list[UploadFile] = File(...)) -> dict[str, Any]:
    import io
    from uuid import uuid4

    from PIL import Image

    up = DATA_DIR / "uploads"
    up.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    for f in files:
        data = await f.read()
        p = up / f"{uuid4().hex}.png"
        try:
            Image.open(io.BytesIO(data)).convert("RGB").save(p)
            paths.append(str(p))
        except Exception:  # noqa: BLE001
            continue
    return {"paths": paths}


# 前端静态资源（构建产物存在时伺服）
DIST = BASE_DIR / "frontend" / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=str(DIST), html=True), name="frontend")


def run() -> None:
    import threading
    import time
    import uvicorn
    import webbrowser

    def _open() -> None:
        time.sleep(1.6)
        try:
            webbrowser.open("http://127.0.0.1:8000")
        except Exception:
            pass

    threading.Thread(target=_open, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
