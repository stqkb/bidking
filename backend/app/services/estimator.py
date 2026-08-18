"""估值编排服务：规则引擎 + ML 融合 + CNN 融合 + 后台重训回调。

把原本硬编码在 main.py 路由文件里的 _merge_ml / _merge_cnn / estimate 编排
抽为可独立单测的纯函数；融合权重提为模块常量（原硬编码 0.5）。
"""
from __future__ import annotations

import json
import os
from typing import Any

import numpy as np

from .. import engine, ml  # cnn 惰性导入（冷启动优化：import torch ~2s，仅 CNN 训练/融合时加载）
from ..core import cache
from ..core.bg import bg
from ..db import db

# 融合权重：与规则估值的 50/50 融合比例（原 hardcode 0.5）
ML_BLEND_WEIGHT = 0.5
# CNN 与当前红品期望的融合比例（原 hardcode 0.5）
CNN_BLEND_WEIGHT = 0.5

# ---- 估值结果 LRU 缓存（runbook 任务14：推理加速）----
# 相同输入（含模型版本）直接返回，避免重复跑规则引擎蒙特卡洛（~1s）。
_EST_CACHE: dict[str, Any] = {}
_EST_CACHE_ORDER: list[str] = []
_EST_CACHE_MAX = 64


def _est_key(inputs: dict[str, Any]) -> str:
    try:
        body = json.dumps(inputs, sort_keys=True, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001
        return ""
    try:
        mt = os.path.getmtime(ml.MODELS_DIR / "ml_full.joblib")
    except Exception:  # noqa: BLE001
        mt = 0.0
    # 校准版本也纳入 key：否则校准预热完成后，预热前落库的未校准结果
    # 仍会被命中返回（同一输入前后差异可达 1.7 倍）。
    calib = cache._cache._slots.get(cache.KEY_CALIB) or {}
    cv = f"{calib.get('n', 0)}:{calib.get('k_red', 0):.4f}" if calib else "0"
    return f"{body}|{mt:.0f}|{cv}"


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
    from .. import cnn as cnn_mod
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
    相同输入（board=None，含模型版本）走 LRU 缓存，避免重复蒙特卡洛（~1s）。
    """
    key = "" if board is not None else _est_key(inputs)
    if key:
        hit = _EST_CACHE.get(key)
        if hit is not None:
            if key in _EST_CACHE_ORDER:
                _EST_CACHE_ORDER.remove(key)
            _EST_CACHE_ORDER.append(key)
            return hit
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
    _annotate_bid(rule)
    if key:
        _EST_CACHE[key] = rule
        _EST_CACHE_ORDER.append(key)
        if len(_EST_CACHE_ORDER) > _EST_CACHE_MAX:
            old = _EST_CACHE_ORDER.pop(0)
            _EST_CACHE.pop(old, None)
    return rule


def _annotate_bid(rule: dict[str, Any]) -> None:
    """把区间方法与置信度补到 bid（前端 IntervalBar 展示）。"""
    bid = rule.get("bid")
    if not isinstance(bid, dict):
        return
    ml_info = rule.get("ml") or {}
    bid["interval_method"] = ml_info.get("interval_method", "rule_mc")
    conf = ml_info.get("confidence")
    if conf is None:
        # fallback：用区间相对宽度估算置信度（越窄越可信）
        f = rule.get("full") or {}
        ev = float(f.get("ev") or 0)
        w = (float(f.get("p90") or 0) - float(f.get("p10") or 0)) / ev if ev else 1.0
        conf = round(min(1.0, (1.0 / (w + 0.05)) / 4.0), 3)
    bid["confidence"] = conf

    # 收益（利润）计算：全场估值 vs 推荐出价
    # 与前端展示的「全场估值 EV」同源（_apply_calibration 之后 rule.full 已是最终值）
    full = rule.get("full") or {}
    rec = bid.get("recommended")
    if isinstance(rec, (int, float)) and rec > 0:
        ev = float(full.get("ev") or 0)
        p10 = float(full.get("p10") or 0)
        p90 = float(full.get("p90") or 0)
        profit = ev - rec
        bid["profit"] = round(profit, 0)
        # 利润率，百分比数值（如 11.11 表示 11.11%）
        bid["profit_rate"] = round(profit / rec * 100, 2)
        bid["profit_p10"] = round(p10 - rec, 0)   # 最坏情况收益（全场景下限）
        bid["profit_p90"] = round(p90 - rec, 0)   # 最好情况收益（全场景上限）


def _apply_calibration(rule: dict[str, Any], inputs: dict[str, Any]) -> None:
    """应用历史校准系数（规则预测系统性偏高，用「实际/预测」中位数修正）。

    全场按均格分桶校准（不同格数区间偏差不同），红品用全局系数。
    """
    calib = cache._cache._slots.get(cache.KEY_CALIB)
    if not calib:
        return
    # 全场：优先 LOESS 曲线（局部偏差修正），无则回退 4 桶 median
    loess = calib.get("loess_full")
    if isinstance(loess, dict) and loess.get("x") and loess.get("y"):
        fx = np.asarray(loess["x"], dtype=float)
        fy = np.asarray(loess["y"], dtype=float)
        d = rule.get("full")
        if d and isinstance(d.get("ev"), (int, float)) and d["ev"] > 0:
            xq = float(np.log(d["ev"]))
            kf = float(np.clip(np.interp(xq, fx, fy), 0.2, 3.0))
            for key in ("ev", "p10", "p50", "p90"):
                v = d.get(key)
                if isinstance(v, (int, float)):
                    d[key] = v * kf
    else:
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


def loess_fit(
    x: Any, y: Any, frac: float = 0.4, robust_it: int = 3
) -> tuple[Any, Any]:
    """LOESS（局部加权线性回归）拟合，纯 numpy 实现。

    等价于 statsmodels lowess(frac=frac, it=robust_it)，但不引入 statsmodels
    依赖（它未在 requirements.txt 声明，缺失时会让 LOESS 校准静默失效）。

    tricube 核加权 + Tukey biweight robust 迭代抑制离群点（拍卖数据尾部很重，
    单局 54 倍偏差的样本若不降权会把整条曲线拽偏）。

    返回 (x_sorted, y_fitted)。
    """
    xa = np.asarray(x, dtype=float)
    ya = np.asarray(y, dtype=float)
    order = np.argsort(xa, kind="stable")
    xs = xa[order]
    ys = ya[order]
    n = xs.size
    if n < 3:
        return xs, ys
    # 局部窗口样本数：frac 比例，至少 3 个点才能定出斜率
    r = int(np.ceil(frac * n))
    r = max(3, min(n, r))
    yfit = np.zeros(n)
    delta = np.ones(n)  # robust 权重
    for _ in range(max(0, robust_it) + 1):
        for i in range(n):
            dist = np.abs(xs - xs[i])
            idx = np.argpartition(dist, r - 1)[:r]
            dmax = dist[idx].max()
            w = np.zeros(n)
            if dmax <= 0:
                w[idx] = 1.0
            else:
                u = dist[idx] / dmax
                w[idx] = (1.0 - u ** 3) ** 3
            w *= delta
            sw = w.sum()
            if sw <= 1e-12:
                yfit[i] = ys[i]
                continue
            xm = float((w * xs).sum() / sw)
            ym = float((w * ys).sum() / sw)
            dx = xs - xm
            sxx = float((w * dx * dx).sum())
            sxy = float((w * dx * (ys - ym)).sum())
            slope = sxy / sxx if sxx > 1e-12 else 0.0
            yfit[i] = ym + slope * (xs[i] - xm)
        res = ys - yfit
        s = float(np.median(np.abs(res)))
        if s <= 1e-12:
            break
        u = np.clip(res / (6.0 * s), -1.0, 1.0)
        delta = (1.0 - u * u) ** 2
    return xs, yfit


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
    chosen: dict[int, dict[str, Any]] = {}  # game_no -> 已选中藏品（供 LOESS 复用，避免二次 re-query）
    for r in rows:
        if not r["red_avg"] or not r["red_value"] or not r["full_value"]:
            continue
        items = json.loads(r["items_json"] or "[]")
        if not items:
            continue
        rng = random.Random(int(r["game_no"]))
        it = rng.choice(items)
        chosen[int(r["game_no"])] = it
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
    # ---- 全场 LOESS 校准曲线（替代 4 桶 median 的局部偏差修正）----
    # 250 样本下局部窗口密度足够；以规则+ML 的全场预测对数为自变量，
    # 拟合 actual/pred 比值的 lowess 曲线，捕捉随预测量级漂移的系统偏差
    # （4 桶中位数无法刻画这种连续漂移，导致全场偏差常年 ~0.91）。
    # 红品偏差近常数（medratio≈1.0），仍用中位数（更稳定）。
    try:
        import math as _math

        xs, ys = [], []
        for d in detail:
            gn = d["game_no"]
            it = chosen.get(gn)  # 复用第一轮已选中藏品，避免重复 re-query
            if not it:
                continue
            inp = {
                "red_avg": d["red_avg"],
                "red_count": None,
                "known_items": [{
                    "name": it.get("name", ""),
                    "grid_cells": int(it.get("grid_cells") or 0),
                    "value": float(it.get("trade_price") or it.get("sys_price") or 0),
                }],
            }
            try:
                rule_i = engine.run_estimate(conn, inp)
                m = ml.predict(conn, inp, rule_i)
            except Exception:  # noqa: BLE001
                continue
            if not m.get("available"):
                continue
            rev = rule_i.get("red", {}).get("ev")
            fev = rule_i.get("full", {}).get("ev")
            if not rev or not fev:
                continue
            pred_f = 0.5 * fev + 0.5 * m["full"]["ev"]
            actual = d["actual_full"]
            if pred_f > 0:
                xs.append(_math.log(pred_f))
                ys.append(actual / pred_f)
        if len(xs) >= 10:
            fx, fy = loess_fit(xs, ys, frac=0.4)
            calib["loess_full"] = {
                "x": [float(v) for v in fx],
                "y": [float(v) for v in fy],
            }
    except Exception as _e:  # noqa: BLE001
        import logging as _logging
        _logging.getLogger("bidking").warning("loess_full 拟合失败: %r", _e)
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
    from .. import cnn as cnn_mod
    if conn is not None:
        cnn_mod.train(conn)
    else:
        with db() as c:
            cnn_mod.train(c)
    bg.mark_done("cnn")


def warm_calibration(conn=None) -> None:
    """后台预热历史校准系数（含全场 LOESS 曲线）。

    校准原先只在 /api/games/accuracy 里被动计算，若用户不打开准确率页面，
    estimate 全程读不到 calib 缓存 → 完全不做校准（全场高估约 1.7 倍、
    红品高估约 2.5 倍）。启动时后台预热，保证估值一上线就是校准后的口径。
    单次耗时约 20s（每局重跑规则引擎 + ML），故必须放后台线程。
    """
    try:
        if conn is not None:
            compute_calibration(conn)
        else:
            with db() as c:
                compute_calibration(c)
    finally:
        bg.mark_done("calib")


def retrain_all() -> None:
    """顺序执行 ML → CNN 重训（单个后台线程，复用 DB 连接）。

    原实现对局确认后同时 start ml 与 cnn 两个后台线程，会竞争 CPU 与
    数据库连接；改为按序执行并复用同一连接，由调用方注册为单一任务「train」。
    """
    from .. import cnn as cnn_mod
    with db() as conn:
        ml.retrain(conn)
        cnn_mod.train(conn)
    bg.mark_done("ml")
    bg.mark_done("cnn")
