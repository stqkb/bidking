"""图鉴、历史对局、用户记录路由（/api/catalog*、/api/games、/api/records）。"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException

from .. import engine, schemas, vision
from ..config import XLSX_SOURCE
from ..core.bg import bg
from ..db import db, json_dumps
from ..importers import import_catalog
from ..services import estimator, matching

router = APIRouter()


@router.get("/api/catalog")
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


@router.get("/api/catalog/items")
def catalog_items() -> dict[str, Any]:
    with db() as conn:
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
        bg.start("ml", estimator.retrain_ml, force=True)
        bg.start("cnn", estimator.retrain_cnn, force=True)
    return {"ok": True, "deleted": deleted}


@router.get("/api/games")
def games() -> dict[str, Any]:
    with db() as conn:
        rows = conn.execute("SELECT * FROM game_records ORDER BY game_no").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["items"] = json.loads(d.pop("items_json") or "[]")
        out.append(d)
    return {"games": out}


@router.get("/api/records")
def records() -> dict[str, Any]:
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
