"""估值编排服务：规则引擎 + ML 融合 + CNN 融合 + 后台重训回调。

把原本硬编码在 main.py 路由文件里的 _merge_ml / _merge_cnn / estimate 编排
抽为可独立单测的纯函数；融合权重提为模块常量（原硬编码 0.5）。
"""
from __future__ import annotations

from typing import Any

from .. import cnn as cnn_mod, engine, ml
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
    """估值编排：规则引擎 → ML 融合 → CNN 融合。

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
    return rule


# ---- 后台重训回调（供 core.bg 注册）----


def retrain_ml() -> None:
    """后台线程执行 ML 重训，完成后标记状态。"""
    with db() as conn:
        ml.retrain(conn)
    bg.mark_done("ml")


def retrain_cnn() -> None:
    """后台线程执行 CNN 重训，完成后标记状态。"""
    with db() as conn:
        cnn_mod.train(conn)
    bg.mark_done("cnn")
