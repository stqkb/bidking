"""图鉴、历史对局、用户记录路由（/api/catalog*、/api/games、/api/records）。"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException

from .. import engine, ocr as ocr_mod, schemas, vision
from ..config import XLSX_SOURCE
from ..core import cache
from ..core.bg import bg
from ..db import db, json_dumps
from ..importers import import_catalog
from ..services import estimator, matching

router = APIRouter()


@router.get("/api/catalog")
def catalog() -> dict[str, Any]:
    with db(readonly=True) as conn:
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


@router.get("/api/catalog/items")
def catalog_items() -> dict[str, Any]:
    with db(readonly=True) as conn:
        rows = conn.execute(
            "SELECT id, name, grid_cells, value FROM catalog_items ORDER BY grid_cells, value DESC"
        ).fetchall()
    return {"items": [dict(r) for r in rows]}


@router.post("/api/catalog/identify")
def catalog_identify(body: schemas.IdentifyInput) -> dict[str, Any]:
    with db() as conn:
        matches = matching.identify_by_grid(conn, body.grid_cells, body.price)
    return {"matches": matches}


@router.post("/api/catalog/import")
def catalog_import(body: schemas.ImportBody) -> dict[str, Any]:
    path = Path(body.path) if body.path else XLSX_SOURCE
    n = import_catalog(path)
    if n == 0:
        raise HTTPException(status_code=400, detail="未读取到图鉴数据，请检查文件路径")
    return {"imported": n}


@router.post("/api/catalog/delete")
def catalog_delete(body: schemas.CatalogDeleteInput) -> dict[str, Any]:
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
        cache.invalidate_catalog()
        bg.start("train", estimator.retrain_all, force=True)
    return {"ok": True, "deleted": deleted}


@router.get("/api/games")
def games() -> dict[str, Any]:
    with db(readonly=True) as conn:
        rows = conn.execute("SELECT * FROM game_records ORDER BY game_no").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["items"] = json.loads(d.pop("items_json") or "[]")
        out.append(d)
    return {"games": out}


@router.get("/api/games/accuracy")
def game_accuracy() -> dict[str, Any]:
    """估值准确率回测：每局用「平均格数 + 随机一件红品」构造输入走估值引擎，
    预测全场 / 实际全场 = 准确率（ratio%）。红品随机选择以局号为种子，保证可复现。"""
    import random

    with db(readonly=True) as conn:
        rows = conn.execute(
            "SELECT game_no, red_avg, red_count, full_value, items_json "
            "FROM game_records ORDER BY game_no"
        ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        if not r["red_avg"] or not r["full_value"]:
            continue
        items = json.loads(r["items_json"] or "[]")
        if not items:
            continue
        rng = random.Random(int(r["game_no"]))
        it = rng.choice(items)
        known = {
            "name": it.get("name", ""),
            "grid_cells": int(it.get("grid_cells") or 0),
            "value": float(it.get("trade_price") or it.get("sys_price") or 0),
        }
        try:
            est = estimator.estimate({
                "red_avg": float(r["red_avg"]),
                "red_count": int(r["red_count"]) if r["red_count"] else None,
                "known_items": [known],
            })
            pred = est.get("full", {}).get("ev")
        except Exception:  # noqa: BLE001
            continue
        actual = float(r["full_value"])
        if pred and actual > 0:
            out.append({
                "game_no": int(r["game_no"]),
                "red_avg": float(r["red_avg"]),
                "item": known["name"],
                "pred": float(pred),
                "actual": actual,
                "ratio": round(float(pred) / actual * 100, 1),
            })
    return {"accuracy": out}


@router.patch("/api/games/{game_no}")
def game_update(game_no: int, body: schemas.GamePatchInput) -> dict[str, Any]:
    """更新对局：本人竞拍成功标记（won）与/或价格字段（总价值/成交价/收益）。
    价格字段更新后自动重算收益核验（profit_ok），核验不通过的对局不进模型训练。"""
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM game_records WHERE game_no=?", (game_no,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="对局不存在")
        full_value = row["full_value"] if body.total_value is None else body.total_value
        deal_price = row["deal_price"] if body.deal_price is None else body.deal_price
        profit = row["profit"] if body.profit is None else body.profit
        won = row["won"]
        if body.won is not None:
            won = 1 if body.won else 0
        price_changed = (
            body.total_value is not None or body.deal_price is not None or body.profit is not None
        )
        profit_ok = row["profit_ok"]
        if price_changed:
            profit_ok = ocr_mod._check_profit_ok(full_value, deal_price, profit)
        conn.execute(
            """UPDATE game_records
               SET full_value=?, deal_price=?, profit=?, won=?, profit_ok=?
               WHERE game_no=?""",
            (full_value, deal_price, profit, won, profit_ok, game_no),
        )
    cache.invalidate_games()
    return {"ok": True, "game_no": game_no, "won": won, "profit_ok": profit_ok}


@router.delete("/api/games/{game_no}")
def game_delete(game_no: int) -> dict[str, Any]:
    """删除一条历史对局，并把剩余对局重排为连续 1..N（避免局号断档）。"""
    with db() as conn:
        cur = conn.execute("DELETE FROM game_records WHERE game_no=?", (game_no,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="对局不存在")
        # 两阶段 UPDATE：先映射到负数，再回填 1..N，避免主键冲突
        rows = [r[0] for r in conn.execute(
            "SELECT game_no FROM game_records ORDER BY game_no"
        ).fetchall()]
        for i, g in enumerate(rows):
            conn.execute(
                "UPDATE game_records SET game_no=? WHERE game_no=?", (-(i + 1), g)
            )
        for i in range(len(rows)):
            conn.execute(
                "UPDATE game_records SET game_no=? WHERE game_no=?", (i + 1, -(i + 1))
            )
        try:
            conn.execute(
                "UPDATE sqlite_sequence SET seq=? WHERE name='game_records'",
                (len(rows),),
            )
        except Exception:  # noqa: BLE001
            pass
        n = len(rows)
    cache.invalidate_games()
    return {"ok": True, "deleted": game_no, "games": n}


@router.get("/api/records")
def records() -> dict[str, Any]:
    with db(readonly=True) as conn:
        rows = conn.execute("SELECT * FROM user_records ORDER BY created_at DESC").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["inputs"] = json.loads(d.pop("inputs_json") or "{}")
        d["prediction"] = json.loads(d.pop("prediction_json") or "null")
        d["actual"] = json.loads(d.pop("actual_json") or "null")
        out.append(d)
    return {"records": out}


@router.post("/api/records")
def record_create(body: schemas.RecordCreate) -> dict[str, Any]:
    rid = uuid4().hex[:12]
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


@router.patch("/api/records/{rid}")
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
        bg.start("ml", estimator.retrain_ml)
    return {"id": rid, "status": status}


@router.delete("/api/records/{rid}")
def record_delete(rid: str) -> dict[str, Any]:
    with db() as conn:
        conn.execute("DELETE FROM user_records WHERE id=?", (rid,))
    return {"ok": True}
