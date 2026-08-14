"""表格机器学习：以规则估值为先验的残差回归集成 + 持续重训。"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime
from functools import lru_cache
from typing import Any

import joblib
import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import RBF, WhiteKernel
from sklearn.linear_model import BayesianRidge

from .config import MODELS_DIR
from .db import db, json_dumps
from .engine import estimate_candidate, get_blended_stats, get_full_ratio

MIN_SAMPLES = 6
# 预测区间加宽系数：训练残差区间偏窄，测试集验证后加宽 1.5 倍
INTERVAL_WIDEN = 1.5
FEATURES = [
    "red_avg", "red_count", "red_grids", "known_size", "log_known_value",
    "known_ratio", "game_no_norm", "rule_red_log", "rule_full_log",
]

# 数据指纹缓存：训练/评估只依赖 game_records + catalog_items，
# 用两个表的轻量 hash 作指纹，数据未变时复用 dataset 与 LOOCV/chrono 评估结果，
# 避免每次 OCR 确认触发重训时重复全量计算（LOOCV 的 O(n) 次集成拟合是最大开销）。
_FP_CACHE: dict[str, tuple[list[dict[str, Any]], list[float], list[float]]] = {}
_EVAL_CACHE: dict[str, tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = {}


def _ds_fingerprint(conn) -> str:
    """game_records + catalog_items 的轻量 hash（数据变化即变化）。"""
    h = hashlib.md5()
    for r in conn.execute(
        "SELECT game_no, red_avg, red_count, red_grids, red_value, full_value, items_json "
        "FROM game_records ORDER BY game_no"
    ).fetchall():
        h.update(repr(tuple(r)).encode("utf-8", "ignore"))
    for r in conn.execute(
        "SELECT name, grid_cells, value, current_value FROM catalog_items ORDER BY id"
    ).fetchall():
        h.update(repr(tuple(r)).encode("utf-8", "ignore"))
    return h.hexdigest()


@lru_cache(maxsize=512)
def _quick_rule_ev(a: int, b: int, sizes_key: str, means_key: str) -> float:
    """确定性快速红品期望（用于训练特征，量级与规则引擎一致）。"""
    sizes = tuple(int(x) for x in sizes_key.split(","))
    means = {int(k): float(v) for k, v in (x.split(":") for x in means_key.split(";"))}
    stats = {
        s: {"mean": means[s], "pool": np.array([means[s]])} for s in sizes
    }
    rng = np.random.default_rng(a * 100003 + b * 7)
    est = estimate_candidate(a, b, stats, rng, n_comps=240, mc_draws=1)
    return est["ev"] if est else float(a * (sum(means.values()) / max(len(means), 1)))


def _stats_cache(conn) -> tuple[dict[int, dict[str, Any]], str, str]:
    stats = get_blended_stats(conn)
    sizes_key = ",".join(str(s) for s in sorted(stats))
    means_key = ";".join(f"{s}:{stats[s]['mean']:.6f}" for s in sorted(stats))
    return stats, sizes_key, means_key


def rule_red_ev(conn, a: int, b: int) -> float:
    stats, sizes_key, means_key = _stats_cache(conn)
    if not stats:
        return 0.0
    return _quick_rule_ev(a, b, sizes_key, means_key)


def build_dataset(conn) -> tuple[list[dict[str, Any]], list[float], list[float]]:
    """从 game_records 构造特征与 log 残差目标（指纹缓存：数据未变直接复用）。"""
    fp = _ds_fingerprint(conn)
    cached = _FP_CACHE.get(fp)
    if cached is not None:
        return cached
    stats, sizes_key, means_key = _stats_cache(conn)
    rows = conn.execute(
        """SELECT game_no, red_avg, red_count, red_grids, red_value, full_value, items_json
           FROM game_records
           WHERE red_avg > 0 AND red_value > 0 AND full_value > 0
           ORDER BY game_no"""
    ).fetchall()
    if not stats:
        return [], [], []
    ratio = get_full_ratio(conn)
    feats: list[dict[str, Any]] = []
    y_red: list[float] = []
    y_full: list[float] = []
    n = len(rows)
    for r in rows:
        items = json.loads(r["items_json"] or "[]")
        known_size, known_value = None, None
        if items:
            best = max(
                items,
                key=lambda it: (it.get("trade_price") or it.get("sys_price") or 0),
            )
            known_size = int(best.get("grid_cells") or 0) or None
            known_value = best.get("trade_price") or best.get("sys_price")
        known_ratio = 0.0
        if known_size and known_value and stats.get(known_size, {}).get("mean"):
            known_ratio = float(known_value) / stats[known_size]["mean"]
        a = int(r["red_grids"] or 0)
        b = int(r["red_count"] or 0)
        rule_r = rule_red_ev(conn, a, b) if a and b else float(r["red_value"])
        rule_f = rule_r * ratio
        feat = {
            "game_no": int(r["game_no"]),
            "red_avg": float(r["red_avg"]),
            "red_count": float(b),
            "red_grids": float(a),
            "known_size": float(known_size) if known_size else 0.0,
            "log_known_value": math.log(known_value) if known_value and known_value > 0 else 0.0,
            "known_ratio": known_ratio,
            "game_no_norm": float(r["game_no"]) / max(n, 1),
            "rule_red_log": math.log(rule_r) if rule_r > 0 else 0.0,
            "rule_full_log": math.log(rule_f) if rule_f > 0 else 0.0,
        }
        feats.append(feat)
        y_red.append(math.log(float(r["red_value"])) - feat["rule_red_log"])
        y_full.append(math.log(float(r["full_value"])) - feat["rule_full_log"])
    _FP_CACHE.clear()  # 数据已变，只保留最新一份
    _FP_CACHE[fp] = (feats, y_red, y_full)
    return feats, y_red, y_full


def _impute(feats: list[dict[str, Any]]) -> dict[str, float]:
    med: dict[str, float] = {}
    for f in FEATURES:
        vals = [x[f] for x in feats]
        med[f] = float(np.median(vals)) if vals else 0.0
    return med


def _make_models():
    return {
        "bayes": BayesianRidge(),
        "gp": GaussianProcessRegressor(
            kernel=1.0 * RBF(length_scale=1.0) + WhiteKernel(noise_level=0.1),
            normalize_y=True,
            random_state=0,
        ),
        "hgb": HistGradientBoostingRegressor(
            max_depth=2, max_leaf_nodes=8, max_iter=80, learning_rate=0.05,
            l2_regularization=1.0, random_state=0,
        ),
    }


def _fit_ensemble(X: np.ndarray, y: np.ndarray) -> list[Any]:
    models = []
    for m in _make_models().values():
        try:
            m.fit(X, y)
            models.append(m)
        except Exception:
            continue
    return models


def _predict_ensemble(models: list[Any], X: np.ndarray) -> np.ndarray:
    if not models:
        return np.zeros(len(X))
    preds = []
    for m in models:
        try:
            preds.append(np.asarray(m.predict(X), dtype=float))
        except Exception:
            continue
    return np.mean(preds, axis=0) if preds else np.zeros(len(X))


def _metrics(y_true: np.ndarray, y_pred: np.ndarray, orig_scale: list[float]) -> dict[str, float]:
    res = y_true - y_pred
    mae_log = float(np.mean(np.abs(res)))
    mape = float(np.mean(np.abs(np.exp(res) - 1.0)) * 100)
    ss_res = float(np.sum(res ** 2))
    ss_tot = float(np.sum((y_true - np.mean(y_true)) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    # 原始单位 MAE
    orig_actual = np.asarray(orig_scale, dtype=float)
    orig_pred = orig_actual * np.exp(res)
    mae_orig = float(np.mean(np.abs(orig_actual - orig_pred)))
    return {"mae_log": mae_log, "mape_pct": mape, "r2_log": r2, "mae_orig": mae_orig}


def _evaluate(feats, y_red, y_full, mode: str) -> dict[str, Any]:
    n = len(feats)
    med = _impute(feats)
    X = np.asarray([[f[k] if f[k] == f[k] else med[k] for k in FEATURES] for f in feats])
    YR = np.asarray(y_red)
    YF = np.asarray(y_full)
    pred_r = np.zeros(n)
    pred_f = np.zeros(n)
    if mode == "loocv":
        for i in range(n):
            idx = [j for j in range(n) if j != i]
            models_r = _fit_ensemble(X[idx], YR[idx])
            models_f = _fit_ensemble(X[idx], YF[idx])
            pred_r[i] = _predict_ensemble(models_r, X[i:i + 1])[0]
            pred_f[i] = _predict_ensemble(models_f, X[i:i + 1])[0]
    else:  # 时间序切分
        cut = max(1, int(n * 0.7))
        tr, te = list(range(cut)), list(range(cut, n))
        if len(te) < 2:
            te = [n - 1]
            tr = list(range(n - 1))
        models_r = _fit_ensemble(X[tr], YR[tr])
        models_f = _fit_ensemble(X[tr], YF[tr])
        pred_r[te] = _predict_ensemble(models_r, X[te])
        pred_f[te] = _predict_ensemble(models_f, X[te])

    # 残差分位（用于区间）
    q10 = float(np.percentile(YF - pred_f, 10))
    q90 = float(np.percentile(YF - pred_f, 90))
    in_lo = YF - pred_f >= q10
    in_hi = YF - pred_f <= q90
    coverage = float(np.mean(in_lo & in_hi))
    orig = [float(feats[i]["rule_full_log"]) for i in range(len(feats))]
    orig_scale = [math.exp(o) for o in orig]
    metrics_full = _metrics(YF, pred_f, orig_scale)
    metrics_red = _metrics(YR, pred_r, orig_scale)
    return {
        "mode": mode,
        "n": n,
        "full": metrics_full,
        "red": metrics_red,
        "residual_q": {"q10": q10, "q90": q90},
        "coverage_pct": round(coverage * 100, 1),
    }


def _calibration_curve(feats, y_full) -> dict[str, Any]:
    """LOOCV 预测 vs 实际的分桶曲线（原单位）。"""
    n = len(feats)
    if n < 6:
        return {"bins": [], "pred": [], "actual": []}
    med = _impute(feats)
    X = np.asarray([[f[k] if f[k] == f[k] else med[k] for k in FEATURES] for f in feats])
    Y = np.asarray(y_full)
    pred = np.zeros(n)
    for i in range(n):
        idx = [j for j in range(n) if j != i]
        models = _fit_ensemble(X[idx], Y[idx])
        pred[i] = _predict_ensemble(models, X[i:i + 1])[0]
    tot_log = np.asarray([f["rule_full_log"] for f in feats])
    pred_v = np.exp(tot_log + pred)
    actual_v = np.exp(tot_log + Y)
    order = np.argsort(pred_v)
    bins = []
    pv, av, pl, al = [], [], [], []
    nb = min(5, n // 2)
    for i in range(nb):
        sl = order[i * n // nb:(i + 1) * n // nb]
        if len(sl) == 0:
            continue
        pv.append(float(np.mean(pred_v[sl])))
        av.append(float(np.mean(actual_v[sl])))
        pl.append(float(np.percentile(pred_v[sl], 10)))
        al.append(float(np.percentile(actual_v[sl], 10)))
    return {"bins": list(range(nb)), "pred": pv, "actual": av, "pred_lo": pl, "actual_lo": al}


def _save(name: str, payload: dict[str, Any]) -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(payload, MODELS_DIR / name)


def _load(name: str) -> dict[str, Any] | None:
    path = MODELS_DIR / name
    if not path.exists():
        return None
    try:
        return joblib.load(path)
    except Exception:
        return None


def retrain(conn) -> dict[str, Any]:
    feats, y_red, y_full = build_dataset(conn)
    n = len(feats)
    if n < MIN_SAMPLES:
        return {"ok": False, "error": f"样本不足（{n} < {MIN_SAMPLES}），暂不训练", "n": n}
    med = _impute(feats)
    X = np.asarray([[f[k] if f[k] == f[k] else med[k] for k in FEATURES] for f in feats])
    YR = np.asarray(y_red)
    YF = np.asarray(y_full)
    models_r = _fit_ensemble(X, YR)
    models_f = _fit_ensemble(X, YF)
    # 评估（LOOCV/chrono/校准曲线）按数据指纹缓存：数据未变时复用，避免每次重训重算
    fp = _ds_fingerprint(conn)
    ev = _EVAL_CACHE.get(fp)
    if ev is None:
        loocv = _evaluate(feats, y_red, y_full, "loocv")
        chrono = _evaluate(feats, y_red, y_full, "chrono")
        curve = _calibration_curve(feats, y_full)
        _EVAL_CACHE.clear()
        _EVAL_CACHE[fp] = (loocv, chrono, curve)
    else:
        loocv, chrono, curve = ev
    importance = {}
    for m in models_f:
        if hasattr(m, "feature_importances_"):
            imp = np.asarray(m.feature_importances_, dtype=float)
            for k, v in zip(FEATURES, imp):
                importance[k] = importance.get(k, 0.0) + float(v)
            break
    payload = {
        "models_red": models_r,
        "models_full": models_f,
        "feature_names": FEATURES,
        "impute": med,
        "loocv": loocv,
        "chrono": chrono,
        "importance": importance,
        "calibration_curve": curve,
        "trained_at": datetime.now().isoformat(timespec="seconds"),
        "n": n,
    }
    _save("ml_full.joblib", payload)
    metrics = {
        "n": n,
        "loocv": loocv,
        "chrono": chrono,
        "importance": importance,
        "trained_at": payload["trained_at"],
    }
    conn.execute(
        "INSERT INTO model_metrics(created_at, kind, n_samples, metrics_json) VALUES (?,?,?,?)",
        (payload["trained_at"], "tabular", n, json_dumps(metrics)),
    )
    return {"ok": True, **metrics}


def model_status(conn) -> dict[str, Any]:
    payload = _load("ml_full.joblib")
    if payload is None:
        return {"trained": False, "n": 0}
    return {
        "trained": True,
        "n": payload["n"],
        "trained_at": payload["trained_at"],
        "loocv": payload["loocv"],
        "chrono": payload["chrono"],
        "importance": payload["importance"],
        "calibration_curve": payload["calibration_curve"],
    }


def loocv_table(conn) -> list[dict[str, Any]]:
    """逐局留一交叉验证：每局用其余样本训练的模型预测，返回明细。"""
    feats, y_red, y_full = build_dataset(conn)
    n = len(feats)
    if n < MIN_SAMPLES:
        return []
    payload = _load("ml_full.joblib")
    q = (payload or {}).get("loocv", {}).get("residual_q", {"q10": -0.4, "q90": 0.4})
    med = _impute(feats)
    X = np.asarray([[f[k] if f[k] == f[k] else med[k] for k in FEATURES] for f in feats])
    YR = np.asarray(y_red)
    YF = np.asarray(y_full)
    out: list[dict[str, Any]] = []
    for i in range(n):
        idx = [j for j in range(n) if j != i]
        models_r = _fit_ensemble(X[idx], YR[idx])
        models_f = _fit_ensemble(X[idx], YF[idx])
        res_r = _predict_ensemble(models_r, X[i:i + 1])[0]
        res_f = _predict_ensemble(models_f, X[i:i + 1])[0]
        rule_r_log = feats[i]["rule_red_log"]
        rule_f_log = feats[i]["rule_full_log"]
        red_log = rule_r_log + res_r
        full_log = rule_f_log + res_f
        q10 = q["q10"] * INTERVAL_WIDEN
        q90 = q["q90"] * INTERVAL_WIDEN
        actual_red = math.exp(YR[i] + rule_r_log)
        actual_full = math.exp(YF[i] + rule_f_log)
        out.append({
            "game_no": feats[i]["game_no"],
            "red_avg": feats[i]["red_avg"],
            "red_actual": actual_red,
            "red_pred": math.exp(red_log),
            "full_actual": actual_full,
            "full_pred": math.exp(full_log),
            "full_p10": math.exp(full_log + q10),
            "full_p90": math.exp(full_log + q90),
        })
    return out


def predict(conn, inputs: dict[str, Any], rule: dict[str, Any]) -> dict[str, Any]:
    """对单场输入做 ML 预测，返回修正后的红品/全场估值与区间。"""
    payload = _load("ml_full.joblib")
    if payload is None or payload["n"] < MIN_SAMPLES:
        return {"available": False}
    stats, _, _ = _stats_cache(conn)
    cands = rule.get("candidates") or []
    a = inputs.get("red_grids") or (cands[0]["red_grids"] if cands else 0)
    b = inputs.get("red_count") or (cands[0]["red_count"] if cands else 0)
    known_size = inputs.get("known_size")
    known_value = inputs.get("known_value")
    known_ratio = 0.0
    if known_size and known_value and stats.get(known_size, {}).get("mean"):
        known_ratio = float(known_value) / stats[known_size]["mean"]
    max_no = conn.execute("SELECT COALESCE(MAX(game_no),0) m FROM game_records").fetchone()["m"]
    n_rec = conn.execute("SELECT COUNT(*) c FROM user_records WHERE status='completed'").fetchone()["c"]
    feat = {
        "red_avg": float(inputs.get("red_avg") or 0),
        "red_count": float(b or 0),
        "red_grids": float(a or 0),
        "known_size": float(known_size) if known_size else 0.0,
        "log_known_value": math.log(known_value) if known_value and known_value > 0 else 0.0,
        "known_ratio": known_ratio,
        "game_no_norm": float(max_no + 1 + n_rec) / max(payload["n"], 1),
        "rule_red_log": math.log(rule["red"]["ev"]) if rule["red"]["ev"] > 0 else 0.0,
        "rule_full_log": math.log(rule["full"]["ev"]) if rule["full"]["ev"] > 0 else 0.0,
    }
    X = np.asarray([[feat[k] if feat[k] == feat[k] else payload["impute"][k] for k in FEATURES]])
    res_r = _predict_ensemble(payload["models_red"], X)[0]
    res_f = _predict_ensemble(payload["models_full"], X)[0]
    q = payload["loocv"]["residual_q"]
    red_log = feat["rule_red_log"] + res_r
    full_log = feat["rule_full_log"] + res_f
    q10 = q["q10"] * INTERVAL_WIDEN
    q90 = q["q90"] * INTERVAL_WIDEN
    return {
        "available": True,
        "n": payload["n"],
        "red": {
            "ev": float(math.exp(red_log)),
            "p10": float(math.exp(red_log + q10)),
            "p90": float(math.exp(red_log + q90)),
            "p50": float(math.exp(red_log)),
        },
        "full": {
            "ev": float(math.exp(full_log)),
            "p10": float(math.exp(full_log + q10)),
            "p90": float(math.exp(full_log + q90)),
            "p50": float(math.exp(full_log)),
        },
        "residual_red": float(res_r),
        "residual_full": float(res_f),
    }
