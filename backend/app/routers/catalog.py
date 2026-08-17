"""图鉴、历史对局、用户记录路由（/api/catalog*、/api/games、/api/records）。"""
from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request

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
            "SELECT id, name, grid_cells, value, current_value FROM catalog_items ORDER BY grid_cells, value DESC"
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
        # 别名：full_value 即实际全场价，便于复盘页统一使用 actual_full 字段
        d["actual_full"] = d.get("full_value")
        out.append(d)
    return {"games": out}


@router.get("/api/games/accuracy")
def game_accuracy() -> dict[str, Any]:
    """估值准确率回测：每局用「平均格数 + 随机一件红品」构造输入走规则引擎，
    预测×校准系数后 / 实际 = 准确率（ratio%）。红品随机以局号为种子保证可复现。
    校准系数由 compute_calibration 基于全部历史对局计算（中位数比值，按均格分桶），
    与估值引擎 estimate 应用同一套系数，保证回测与真实估值口径一致。"""
    with db(readonly=True) as conn:
        calib, detail = estimator.compute_calibration(conn)
    buckets = calib.get("avg_buckets") or {}
    global_k = float(calib.get("k_full", 1.0))
    out: list[dict[str, Any]] = []
    for d in detail:
        bk = estimator._avg_bucket(float(d["red_avg"]))
        k = float(buckets.get(bk, global_k))
        pred = d["rule_full"] * k
        actual = d["actual_full"]
        if actual > 0:
            out.append({
                "game_no": d["game_no"],
                "red_avg": d["red_avg"],
                "item": d["item"],
                "pred": pred,
                "actual": actual,
                "ratio": round(actual / pred * 100, 1),
            })
    return {
        "accuracy": out,
        "calibration": {k: round(float(v), 4) for k, v in calib.items() if k in ("k_red", "k_full")},
        "n": calib.get("n", 0),
    }


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


@router.put("/api/games/{game_no}/items")
def game_items_update(game_no: int, body: schemas.ItemsUpdateInput) -> dict[str, Any]:
    """整单红品列表更新（对某局红品增删改查）。

    接收完整红品列表（name/grid_cells/value），替换 items_json 并重算
    red_count / red_grids / red_avg / grid_combo / red_value，重新核验收益。
    """
    with db() as conn:
        row = conn.execute(
            "SELECT full_value, deal_price, profit FROM game_records WHERE game_no=?",
            (game_no,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="对局不存在")
        saved = [{
            "name": it.name,
            "grid_cells": int(it.grid_cells or 0),
            "trade_price": float(it.value or 0),
        } for it in body.items]
        cells = [it["grid_cells"] for it in saved]
        red_count = len(saved)
        red_grids = sum(cells)
        red_avg = math.floor(red_grids / red_count * 10) / 10 if red_count else None
        combo = "+".join(str(c) for c in sorted(cells)) if cells else None
        red_value = round(sum(it["trade_price"] for it in saved), 0)
        profit_ok = ocr_mod._check_profit_ok(row["full_value"], row["deal_price"], row["profit"])
        conn.execute(
            """UPDATE game_records SET items_json=?, red_count=?, red_grids=?,
               red_avg=?, grid_combo=?, red_value=?, profit_ok=? WHERE game_no=?""",
            (json_dumps(saved), red_count or None, red_grids or None, red_avg,
             combo, red_value or None, profit_ok, game_no),
        )
    cache.invalidate_games()
    return {
        "ok": True,
        "game_no": game_no,
        "red_count": red_count,
        "red_grids": red_grids,
        "red_avg": red_avg,
        "grid_combo": combo,
        "red_value": red_value,
        "profit_ok": profit_ok,
    }


@router.post("/api/quick-archive")
async def quick_archive(request: Request) -> dict[str, Any]:
    """一键归档：把一次估值结果保存为对局记录（数据采集效率优化）。

    兼容两种请求结构：
      A. 前端向导：{ input: {red_avg, red_count, total_grids, known_items}, result: {red/full/bid} }
      B. 平铺：    { red_avg, known_items, estimate_result, actual_full, actual_red }（QuickArchiveInput）

    提供 actual_full 视为已结算（status=settled）；未提供则标记
    status=pending_settlement（红品/全场默认取估值），待结算局不进模型训练，
    由 POST /api/settle/{game_no} 补充实际值后进入训练集。
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="请求体不是合法 JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="请求体应为 JSON 对象")
    # 兼容嵌套 {input, result} 与平铺结构
    inp = body.get("input") if isinstance(body.get("input"), dict) else body
    result = body.get("result") if isinstance(body.get("result"), dict) else body.get("estimate_result") or {}

    raw_items = inp.get("known_items") or []
    items = [
        {
            "name": str((it.get("name") if isinstance(it, dict) else "") or ""),
            "grid_cells": int(it.get("grid_cells") or it.get("size") or 0),
            "trade_price": float(it.get("value") or 0),
        }
        for it in raw_items
        if isinstance(it, dict)
    ]
    est_red = float((result.get("red") or {}).get("ev") or 0)
    est_full = float((result.get("full") or {}).get("ev") or 0)
    actual_full = inp.get("actual_full")
    actual_red = inp.get("actual_red")
    red_value = float(actual_red) if actual_red is not None else est_red
    full_value = float(actual_full) if actual_full is not None else est_full
    # 锁定候选优先；其次手填；再退 items 求和
    if items:
        cells = [it["grid_cells"] for it in items]
        grid_total = int(inp.get("selected_red_grids") or inp.get("total_grids") or inp.get("red_grids") or sum(cells))
        red_count = int(inp.get("selected_red_count") or inp.get("red_count") or len(items))
        red_avg = round(grid_total / red_count, 1) if red_count else None
        combo = "+".join(str(c) for c in sorted(cells)) if cells else None
    else:
        grid_total = int(inp.get("selected_red_grids") or inp.get("total_grids") or inp.get("red_grids") or 0)
        red_count = int(inp.get("selected_red_count") or inp.get("red_count") or 0)
        red_avg = round(float(inp.get("red_avg") or 0), 1) if inp.get("red_avg") else None
        combo = None
    status = "settled" if actual_full is not None else "pending_settlement"
    now = datetime.now().isoformat(timespec="seconds")
    with db() as conn:
        game_no = conn.execute(
            "SELECT COALESCE(MAX(game_no),0)+1 m FROM game_records"
        ).fetchone()["m"]
        conn.execute(
            """INSERT INTO game_records
               (game_no, grid_combo, red_count, red_grids, red_avg, red_value,
                full_value, predicted_full, predicted_red, deal_price, profit,
                items_json, won, profit_ok, status)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (game_no, combo, red_count or None, grid_total or None, red_avg,
             red_value or None, full_value or None, est_full or None, est_red or None,
             None, None, json_dumps(items), 0, 1, status),
        )
    cache.invalidate_games()
    return {"ok": True, "game_no": game_no, "status": status, "saved_at": now}


@router.post("/api/settle/{game_no}")
def settle_game(game_no: int, body: schemas.SettleInput) -> dict[str, Any]:
    """补充结算：待结算对局回填实际总价值/红品价值，进入训练集。"""
    with db() as conn:
        row = conn.execute(
            "SELECT full_value, deal_price, profit FROM game_records WHERE game_no=?",
            (game_no,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="对局不存在")
        if body.actual_full is not None:
            conn.execute(
                "UPDATE game_records SET full_value=? WHERE game_no=?",
                (body.actual_full, game_no),
            )
        if body.actual_red is not None:
            conn.execute(
                "UPDATE game_records SET red_value=? WHERE game_no=?",
                (body.actual_red, game_no),
            )
        new_full = body.actual_full if body.actual_full is not None else row["full_value"]
        profit_ok = ocr_mod._check_profit_ok(new_full, row["deal_price"], row["profit"])
        conn.execute(
            "UPDATE game_records SET status='settled', profit_ok=? WHERE game_no=?",
            (profit_ok, game_no),
        )
    cache.invalidate_games()
    if body.actual_full is not None or body.actual_red is not None:
        bg.start("train", estimator.retrain_all, force=True)
    return {"ok": True, "game_no": game_no, "status": "settled"}


@router.get("/api/pending-settlement")
def pending_settlement() -> dict[str, Any]:
    """待结算对局列表（供前端 Dashboard/TopBar 提醒）。"""
    with db(readonly=True) as conn:
        rows = conn.execute(
            """SELECT game_no, red_avg, red_count, red_grids, red_value, full_value, won
               FROM game_records WHERE status='pending_settlement' ORDER BY game_no"""
        ).fetchall()
    return {"items": [dict(r) for r in rows], "count": len(rows)}


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
