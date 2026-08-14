"""图鉴匹配统一服务。

收敛了三处高度相似但不一致的实现：
- ocr._match_by_name / ocr._match_catalog（名称模糊匹配）
- importers.identify_item（按格数/价格识别）
- main._catalog_value（按名查图鉴当前值）

匹配规则以 ocr._match_catalog 的完整版为准，名称归一化统一走 core.norm.norm_name。
"""
from __future__ import annotations

import json
from typing import Any

from ..core import cache
from ..core.norm import norm_name


def _get_catalog_rows(conn) -> list[dict[str, Any]]:
    """catalog_items 全表（name/grid_cells/value/current_value），内存缓存。

    写操作（导入 Excel / 删除藏品 / OCR 确认新增或覆盖价格）后需调
    cache.invalidate_catalog() 失效，见 core/cache.py 约定。
    """
    def _load() -> list[dict[str, Any]]:
        return [dict(r) for r in conn.execute(
            "SELECT name, grid_cells, value, current_value FROM catalog_items"
        ).fetchall()]

    return cache._cache.get(cache.KEY_CATALOG_ROWS, _load)


def _get_catalog_index(conn) -> dict[str, list[dict[str, Any]]]:
    """catalog_items 按归一化名称索引（norm_name -> 条目列表）。

    构建一次后，匹配时按名称哈希查找，避免对每条候选反复执行 norm_name。
    与 KEY_CATALOG_ROWS 同生命周期，写操作后一并失效。
    """
    def _load() -> dict[str, list[dict[str, Any]]]:
        idx: dict[str, list[dict[str, Any]]] = {}
        for r in _get_catalog_rows(conn):
            idx.setdefault(norm_name(r["name"]), []).append(r)
        return idx

    return cache._cache.get(cache.KEY_CATALOG_INDEX, _load)


def _base_score(nn: str, rn: str, alias_rn: str | None) -> float:
    """名称三级打分的公共核心（exact / alias / 前缀包含）。返回 0 表示不匹配。

    match_by_name 与 match_catalog 共用，保证两条路径的命名口径完全一致。
    """
    if not nn:
        return 0
    exact = nn == rn
    alias_hit = alias_rn is not None and rn == alias_rn
    ocr_prefix = len(nn) >= 2 and nn in rn and nn != rn  # OCR 截断（名短于图鉴）
    cat_prefix = len(rn) >= 2 and rn in nn and nn != rn  # OCR 名比图鉴多字
    prefix = len(nn) >= 3 and len(rn) >= 3 and nn[:3] == rn[:3]
    if exact or alias_hit:
        return 100
    if ocr_prefix:
        return 62 + 8 * len(nn) / max(len(rn), 1)
    if cat_prefix:
        return 42  # 如「非洲之心」之于「非洲之心碎料」，弱化
    if prefix:
        return 46
    return 0


def _base_candidate(r: dict[str, Any], score: float) -> dict[str, Any]:
    """公共候选结构（match_by_name / match_catalog 的名称命中部分）。"""
    return {
        "name": r["name"],
        "grid_cells": r["grid_cells"],
        "value": r["value"],
        "current_value": r["current_value"],
        "score": round(score, 1),
    }


def match_by_name(conn, name: str) -> list[dict[str, Any]]:
    """按名称模糊匹配图鉴（exact/alias/前缀三级打分），返回前 4 候选。

    原名 ocr._match_by_name。供 OCR 板面识别、图鉴联想使用。
    """
    nn = norm_name(name)
    if not nn:
        return []
    idx = _get_catalog_index(conn)
    alias_target = _build_alias_map(conn).get(nn)
    alias_rn = norm_name(alias_target) if alias_target else None
    cands: list[dict[str, Any]] = []
    for rn, rows in idx.items():
        score = _base_score(nn, rn, alias_rn)
        if score <= 0:
            continue
        for r in rows:
            c = _base_candidate(r, score)
            c["price_ok"] = True
            c["by_price"] = False
            cands.append(c)
    cands = [c for c in cands if c["score"] >= 50]
    cands.sort(key=lambda c: -c["score"])
    return cands[:4]


def match_catalog(conn, name: str, price: float, cells: int) -> list[dict[str, Any]]:
    """名称 + 格数 + 价格三重匹配图鉴，返回前 6 候选。

    原名 ocr._match_catalog。基于 match_by_name 的名称评分核心，叠加格数惩罚
    与价格加分，且带「纯价格兜底」回退分支。
    """
    rows = _get_catalog_rows(conn)
    nn = norm_name(name)
    if not nn:
        return []
    alias_target = _build_alias_map(conn).get(nn)
    alias_rn = norm_name(alias_target) if alias_target else None
    candidates: list[dict[str, Any]] = []
    for r in rows:
        score = _base_score(nn, norm_name(r["name"]), alias_rn)
        if score <= 0:
            continue
        if cells and r["grid_cells"] != cells:
            score -= 25
        rel = min(
            abs(r["value"] - price) / max(price, 1),
            abs((r["current_value"] or r["value"]) - price) / max(price, 1),
        )
        price_ok = rel <= 0.02
        if price_ok:
            score += 15
        elif rel <= 0.05:
            score += 5
        c = _base_candidate(r, score)
        c["price_rel"] = round(rel, 3)
        c["price_ok"] = bool(price_ok)
        c["by_price"] = False
        candidates.append(c)
    candidates = [c for c in candidates if c["score"] >= 50]
    if not candidates:
        # 兜底：名称对不上时，按 格数 + 价格精确命中 推荐候选
        for r in rows:
            if cells and r["grid_cells"] != cells:
                continue
            for v in (r["value"], r["current_value"] or r["value"]):
                if abs(v - price) / max(price, 1) <= 0.02:
                    candidates.append({
                        "name": r["name"],
                        "grid_cells": r["grid_cells"],
                        "value": r["value"],
                        "current_value": r["current_value"],
                        "score": 42.0,
                        "price_rel": round(abs(v - price) / max(price, 1), 3),
                        "price_ok": True,
                        "by_price": True,
                    })
                    break
        if not candidates:
            return []
    candidates.sort(key=lambda c: (-c["score"], c["price_rel"]))
    best = candidates[0]["score"]
    threshold = max(50, best - 15)
    if not any(not c["by_price"] for c in candidates):
        threshold = 42  # 纯按价格兜底命中的候选直接返回
    return [c for c in candidates if c["score"] >= threshold][:6]


def _build_alias_map(conn) -> dict[str, str]:
    """历史对局里的「游戏显示名/对应文档名 -> 图鉴名」别名映射。

    依赖 game_records（items_json），缓存后随 invalidate_games() 失效。
    """
    def _load() -> dict[str, str]:
        cat: dict[str, str] = {}
        for r in conn.execute("SELECT name FROM catalog_items").fetchall():
            cat.setdefault(norm_name(r["name"]), r["name"])
        alias: dict[str, str] = {}
        for r in conn.execute("SELECT items_json FROM game_records").fetchall():
            for it in json.loads(r["items_json"] or "[]"):
                nm = it.get("name")
                doc = it.get("doc_name")
                target = None
                for key in (doc, nm):
                    nk = norm_name(key)
                    if nk and nk in cat:
                        target = cat[nk]
                        break
                if target:
                    if nm:
                        alias.setdefault(norm_name(nm), target)
                    if doc:
                        alias.setdefault(norm_name(doc), target)
        return alias

    return cache._cache.get(cache.KEY_ALIAS_MAP, _load)


def match_by_name(conn, name: str) -> list[dict[str, Any]]:
    """按名称模糊匹配图鉴（exact/alias/前缀三级打分），返回前 4 候选。

    原名 ocr._match_by_name。供 OCR 板面识别、图鉴联想使用。
    """
    rows = _get_catalog_rows(conn)
    nn = norm_name(name)
    alias_target = _build_alias_map(conn).get(nn)
    cands: list[dict[str, Any]] = []
    for r in rows:
        rn = norm_name(r["name"])
        exact = len(nn) > 0 and nn == rn
        alias_hit = alias_target is not None and rn == norm_name(alias_target)
        ocr_prefix = len(nn) >= 2 and nn in rn and nn != rn  # OCR 截断（名短于图鉴）
        cat_prefix = len(rn) >= 2 and rn in nn and nn != rn  # OCR 名比图鉴多字
        prefix = len(nn) >= 3 and len(rn) >= 3 and nn[:3] == rn[:3]
        if exact or alias_hit:
            score = 100
        elif ocr_prefix:
            score = 62 + 8 * len(nn) / max(len(rn), 1)
        elif cat_prefix:
            score = 42
        elif prefix:
            score = 46
        else:
            continue
        cands.append({
            "name": r["name"],
            "grid_cells": r["grid_cells"],
            "value": r["value"],
            "current_value": r["current_value"],
            "score": round(score, 1),
            "price_ok": True,
            "by_price": False,
        })
    cands = [c for c in cands if c["score"] >= 50]
    cands.sort(key=lambda c: -c["score"])
    return cands[:4]


def match_catalog(conn, name: str, price: float, cells: int) -> list[dict[str, Any]]:
    """名称 + 格数 + 价格三重匹配图鉴，返回前 6 候选。

    原名 ocr._match_catalog。规则是 match_by_name 的超集：叠加格数惩罚与价格加分，
    且带「纯价格兜底」回退分支。
    """
    rows = _get_catalog_rows(conn)
    nn = norm_name(name)
    alias_target = _build_alias_map(conn).get(nn)
    candidates: list[dict[str, Any]] = []
    for r in rows:
        rn = norm_name(r["name"])
        exact = len(nn) > 0 and nn == rn
        alias_hit = alias_target is not None and rn == norm_name(alias_target)
        ocr_prefix = len(nn) >= 2 and nn in rn and nn != rn
        cat_prefix = len(rn) >= 2 and rn in nn and nn != rn
        prefix = len(nn) >= 3 and len(rn) >= 3 and nn[:3] == rn[:3]
        if exact or alias_hit:
            score = 100
        elif ocr_prefix:
            score = 62 + 8 * len(nn) / max(len(rn), 1)
        elif cat_prefix:
            score = 42  # 如「非洲之心」之于「非洲之心碎料」，弱化
        elif prefix:
            score = 46
        else:
            continue
        if cells and r["grid_cells"] != cells:
            score -= 25
        rel = min(
            abs(r["value"] - price) / max(price, 1),
            abs((r["current_value"] or r["value"]) - price) / max(price, 1),
        )
        price_ok = rel <= 0.02
        if price_ok:
            score += 15
        elif rel <= 0.05:
            score += 5
        candidates.append({
            "name": r["name"],
            "grid_cells": r["grid_cells"],
            "value": r["value"],
            "current_value": r["current_value"],
            "score": round(score, 1),
            "price_rel": round(rel, 3),
            "price_ok": bool(price_ok),
            "by_price": False,
        })
    candidates = [c for c in candidates if c["score"] >= 50]
    if not candidates:
        # 兜底：名称对不上时，按 格数 + 价格精确命中 推荐候选
        for r in rows:
            if cells and r["grid_cells"] != cells:
                continue
            for v in (r["value"], r["current_value"] or r["value"]):
                if abs(v - price) / max(price, 1) <= 0.02:
                    candidates.append({
                        "name": r["name"],
                        "grid_cells": r["grid_cells"],
                        "value": r["value"],
                        "current_value": r["current_value"],
                        "score": 42.0,
                        "price_rel": round(abs(v - price) / max(price, 1), 3),
                        "price_ok": True,
                        "by_price": True,
                    })
                    break
        if not candidates:
            return []
    candidates.sort(key=lambda c: (-c["score"], c["price_rel"]))
    best = candidates[0]["score"]
    threshold = max(50, best - 15)
    if not any(not c["by_price"] for c in candidates):
        threshold = 42  # 纯按价格兜底命中的候选直接返回
    return [c for c in candidates if c["score"] >= threshold][:6]


def identify_by_grid(
    conn,
    grid_cells: int,
    price: float | None = None,
    limit: int = 30,
) -> list[dict]:
    """按格数识别红色藏品（原名 importers.identify_item）。

    - 只填格数：返回该格数全部图鉴藏品，按价值从低到高展示；
    - 填了价格：返回该格数全部图鉴藏品，按 |价格差| 从小到大优先展示。
    """
    results: list[dict] = []
    seen: set[tuple] = set()

    def add(name: str, grid: int, val: float | None, cur: float | None,
            source: str, match: str) -> None:
        if val is None:
            return
        key = (name, grid, round(val, 0))
        if key in seen:
            return
        seen.add(key)
        results.append({
            "name": name, "grid_cells": grid,
            "value": val, "current_value": cur,
            "source": source, "match": match,
            "diff": abs(val - price) if price is not None else 0.0,
        })

    for r in conn.execute(
        "SELECT name, grid_cells, value, current_value FROM catalog_items WHERE grid_cells=?"
    , (int(grid_cells),)).fetchall():
        v = r["value"]
        if v is None:
            continue
        if price is None:
            add(r["name"], r["grid_cells"], v, None, "图鉴", "")
        else:
            diff = abs(v - float(price))
            pct = diff / max(float(price), 1.0) * 100
            add(
                r["name"], r["grid_cells"], v, None,
                "图鉴", f"差 {diff:,.0f}（{pct:.1f}%）",
            )

    if price is not None:
        results.sort(key=lambda d: d["diff"])
    else:
        results.sort(key=lambda d: d["value"])
    return results[:limit]


def catalog_value(conn, name: str) -> float | None:
    """按名称查图鉴当前值（交易行价 current_value，否则系统价 value）。

    原名 main._catalog_value；调用方需自行持有 conn。基于内存缓存的行过滤，
    不重复查库。
    """
    rows = _get_catalog_rows(conn)
    for r in rows:
        if r["name"] == name:
            return float(r["current_value"] or r["value"] or 0)
    return None
