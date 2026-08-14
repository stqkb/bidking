"""估值编排服务：规则引擎 + ML 融合 + CNN 融合 + 后台重训回调。

把原本硬编码在 main.py 路由文件里的 _merge_ml / _merge_cnn / estimate 编排
抽为可独立单测的纯函数；融合权重提为模块常量（原硬编码 0.5）。
"""
from __future__ import annotations

from typing import Any

from .. import cnn as cnn_mod, engine, ml
from ..core import cache
from ..core.bg import bg
from ..db import db

# 融合权重：与规则估值的 50/50 融合比例（原 hardcode 0.5）
ML_BLEND_WEIGHT = 0.5
# CNN 与当前红品期望的融合比例（原 hardcode 0.5）
CNN_BLEND_WEIGHT = 0.5


def merge_ml(rule: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """ML 可用时覆盖红品/全场估值与出价（原名 main._merge_ml）。"""
    with db() as conn:
        m = ml.predict(conn, inputs, rule)
    if not m.get("available"):
        rule["ml"] = {"available": False}
        return rule
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
            rule["red"][k] = ML_BLEND_WEIGHT * r[k] + ML_BLEND_WEIGHT * red[k]
            rule["full"][k] = ML_BLEND_WEIGHT * f[k] + ML_BLEND_WEIGHT * full[k]
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
    min_bid_input = inputs.get("min_bid")
    margin = float(inputs.get("margin") or 0.85)
    rule["bid"] = engine.compute_bid(
        rule["full"], margin,
        float(min_bid_input) if min_bid_input else None,
    )
    return rule


def merge_cnn(rule: dict[str, Any], board: list[list[int]]) -> dict[str, Any]:
    """CNN 可用时与当前红品期望 50/50 融合（原名 main._merge_cnn）。"""
    res = cnn_mod.predict_board(board)
    rule["cnn"] = res
    if not res.get("ok"):
        return rule
    # CNN 与当前红品期望 50/50 融合
    red = rule["red"]
    cnn_v = float(res["value"])
    ratio = rule["full"]["ev"] / red["ev"] if red["ev"] > 0 else None
    if ratio is None:
        with db() as conn:
            ratio = engine.get_full_ratio(conn)
    red["ev"] = CNN_BLEND_WEIGHT * red["ev"] + CNN_BLEND_WEIGHT * cnn_v
    red["p10"] = CNN_BLEND_WEIGHT * red["p10"] + CNN_BLEND_WEIGHT * cnn_v * 0.8
    red["p90"] = CNN_BLEND_WEIGHT * red["p90"] + CNN_BLEND_WEIGHT * cnn_v * 1.2
    red["p50"] = CNN_BLEND_WEIGHT * red["p50"] + CNN_BLEND_WEIGHT * cnn_v
    full = rule["full"]
    full["ev"] = red["ev"] * ratio
    full["p10"] = red["p10"] * ratio
    full["p50"] = red["p50"] * ratio
    full["p90"] = red["p90"] * ratio
    margin = float(rule["bid"]["margin"])
    rule["bid"] = engine.compute_bid(full, margin)
    return rule


def estimate(inputs: dict[str, Any], board: list[list[int]] | None = None) -> dict[str, Any]:
    """估值编排：规则引擎 → ML 融合 → CNN 融合 → 历史校准。

    纯函数，不抛 HTTP 异常；路由层负责把返回中的 "error" 转成 400。
    """
    with db() as conn:
        rule = engine.run_estimate(conn, inputs)
    if "error" in rule:
        return rule
    sel = rule.get("selected") or {}
    if sel.get("applied"):
        # ML 特征按锁定候选的格数/件数计算，避免与锁定后的规则估值错位。
        inputs["red_grids"] = sel["red_grids"]
        inputs["red_count"] = sel["red_count"]
    rule = merge_ml(rule, inputs)
    if board is not None:
        rule = merge_cnn(rule, board)
    _apply_calibration(rule, inputs)
    return rule


def _apply_calibration(rule: dict[str, Any], inputs: dict[str, Any]) -> None:
    """应用历史校准系数（规则预测系统性偏高，用「实际/预测」中位数修正）。

    全场按均格分桶校准（不同格数区间偏差不同），红品用全局系数。
    """
    calib = cache._cache._slots.get(cache.KEY_CALIB)
    if not calib:
        return
    kf = calib.get("k_full")
    if not isinstance(kf, (int, float)):
        kf = None
    buckets = calib.get("avg_buckets") or {}
    avg = float(inputs.get("red_avg") or 0)
    bucket_k = buckets.get(_avg_bucket(avg))
    if isinstance(bucket_k, (int, float)):
        kf = bucket_k
    if isinstance(kf, (int, float)):
        kf = min(max(float(kf), 0.2), 3.0)
        d = rule.get("full")
        if d:
            for key in ("ev", "p10", "p50", "p90"):
                v = d.get(key)
                if isinstance(v, (int, float)):
                    d[key] = v * kf
    kr = calib.get("k_red")
    if isinstance(kr, (int, float)):
        kr = min(max(float(kr), 0.2), 3.0)
        d = rule.get("red")
        if d:
            for key in ("ev", "p10", "p50", "p90"):
                v = d.get(key)
                if isinstance(v, (int, float)):
                    d[key] = v * kr


def _avg_bucket(avg: float) -> str:
    if avg < 2:
        return "lt2"
    if avg < 3:
        return "2-3"
    if avg < 4:
        return "3-4"
    return "gt4"


def compute_calibration(conn) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """用历史对局计算红品/全场校准系数（规则预测 vs 实际 的中位数比值）。

    全场系数按均格分桶（avg_buckets），不同格数区间的系统偏差不同。
    返回 (calib, detail)：calib 写入缓存供 estimate 应用；detail 为每局
    规则预测与实际的明细，供准确率回测直接复用（避免重复计算）。
    """
    import json
    import random

    import numpy as np

    rows = conn.execute(
        "SELECT game_no, red_avg, red_count, red_value, full_value, items_json "
        "FROM game_records ORDER BY game_no"
    ).fetchall()
    red_rs: list[float] = []
    full_rs: list[float] = []
    buckets: dict[str, list[float]] = {}
    detail: list[dict[str, Any]] = []
    for r in rows:
        if not r["red_avg"] or not r["red_value"] or not r["full_value"]:
            continue
        items = json.loads(r["items_json"] or "[]")
        if not items:
            continue
        rng = random.Random(int(r["game_no"]))
        it = rng.choice(items)
        inputs = {
            "red_avg": float(r["red_avg"]),
            "red_count": int(r["red_count"]) if r["red_count"] else None,
            "known_items": [{
                "name": it.get("name", ""),
                "grid_cells": int(it.get("grid_cells") or 0),
                "value": float(it.get("trade_price") or it.get("sys_price") or 0),
            }],
        }
        try:
            rule = engine.run_estimate(conn, inputs)
        except Exception:  # noqa: BLE001
            continue
        rev = rule.get("red", {}).get("ev")
        fev = rule.get("full", {}).get("ev")
        if not rev or not fev:
            continue
        red_rs.append(float(r["red_value"]) / rev)
        full_rs.append(float(r["full_value"]) / fev)
        bk = _avg_bucket(float(r["red_avg"]))
        buckets.setdefault(bk, []).append(float(r["full_value"]) / fev)
        detail.append({
            "game_no": int(r["game_no"]),
            "red_avg": float(r["red_avg"]),
            "item": it.get("name", ""),
            "rule_red": rev,
            "rule_full": fev,
            "actual_red": float(r["red_value"]),
            "actual_full": float(r["full_value"]),
        })
    calib = {
        "k_red": float(np.median(red_rs)) if red_rs else 1.0,
        "k_full": float(np.median(full_rs)) if full_rs else 1.0,
        "avg_buckets": {k: float(np.median(v)) for k, v in buckets.items()},
        "n": len(full_rs),
    }
    cache._cache.set(cache.KEY_CALIB, calib)
    return calib, detail


# ---- 后台重训回调（供 core.bg 注册）----


def retrain_ml(conn=None) -> None:
    """后台线程执行 ML 重训，完成后标记状态。conn 非空时复用调用方连接。"""
    if conn is not None:
        ml.retrain(conn)
    else:
        with db() as c:
            ml.retrain(c)
    bg.mark_done("ml")


def retrain_cnn(conn=None) -> None:
    """后台线程执行 CNN 重训，完成后标记状态。conn 非空时复用调用方连接。"""
    if conn is not None:
        cnn_mod.train(conn)
    else:
        with db() as c:
            cnn_mod.train(c)
    bg.mark_done("cnn")


def retrain_all() -> None:
    """顺序执行 ML → CNN 重训（单个后台线程，复用 DB 连接）。

    原实现对局确认后同时 start ml 与 cnn 两个后台线程，会竞争 CPU 与
    数据库连接；改为按序执行并复用同一连接，由调用方注册为单一任务「train」。
    """
    with db() as conn:
        ml.retrain(conn)
        cnn_mod.train(conn)
    bg.mark_done("ml")
    bg.mark_done("cnn")
