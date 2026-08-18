"""精度优化回测框架（chrono 切分，无泄漏）。

用法：
  python backend/scripts/eval_precision.py --calibration median --fusion equal --features base
  python backend/scripts/eval_precision.py --calibration loess  --fusion equal --features base
  python backend/scripts/eval_precision.py --calibration loess  --fusion bma    --features v2

度量（测试集，前 70% 训练+校准、后 30% 评估）：
  - full_mape / red_mape      ：系统级平均绝对百分比误差
  - full_medratio / red_medratio：系统偏差（actual/pred 中位数，1.0=无偏）
  - coverage_pct              ：训练残差 conformal 区间覆盖测试集比例
  - fusion weights            ：equal/bma/stacking 各模型权重
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from typing import Any

import numpy as np

sys.path.insert(0, "backend")
from app import ml  # noqa: E402
from app.db import db  # noqa: E402


def _load_games(conn) -> list[dict[str, Any]]:
    rows = conn.execute(
        """SELECT game_no, red_avg, red_count, red_grids, red_value, full_value, items_json
           FROM game_records
           WHERE red_avg > 0 AND red_value > 0 AND full_value > 0
             AND COALESCE(profit_ok, 1) = 1
             AND COALESCE(status, '') != 'pending_settlement'
           ORDER BY game_no"""
    ).fetchall()
    out = []
    for r in rows:
        items = json.loads(r["items_json"] or "[]")
        if items:
            best = max(items, key=lambda it: (it.get("trade_price") or it.get("sys_price") or 0))
            kv = best.get("trade_price") or best.get("sys_price")
            known_size = int(best.get("grid_cells") or 0) or None
            known_value = float(kv) if kv else None
        else:
            known_size = None
            known_value = None
        out.append({
            "game_no": int(r["game_no"]),
            "red_avg": float(r["red_avg"]),
            "red_count": int(r["red_count"]) if r["red_count"] else 0,
            "red_grids": int(r["red_grids"]) if r["red_grids"] else 0,
            "red_value": float(r["red_value"]),
            "full_value": float(r["full_value"]),
            "known_size": known_size,
            "known_value": known_value,
        })
    return out


def _train_bases(X, y):
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.gaussian_process import GaussianProcessRegressor
    from sklearn.gaussian_process.kernels import Matern, WhiteKernel
    from sklearn.linear_model import BayesianRidge

    specs = {
        "bayes": BayesianRidge(),
        "gp": GaussianProcessRegressor(
            kernel=1.0 * Matern(nu=2.5, length_scale=np.ones(X.shape[1]))
                  + WhiteKernel(noise_level=0.05),
            normalize_y=True, n_restarts_optimizer=3, random_state=0,
        ),
        "hgb": HistGradientBoostingRegressor(
            max_depth=4, max_leaf_nodes=16, max_iter=200,
            learning_rate=0.05, l2_regularization=0.5,
            min_samples_leaf=3, early_stopping=True,
            validation_fraction=0.15, n_iter_no_change=10, random_state=0,
        ),
    }
    trained = {}
    for name, m in specs.items():
        try:
            m.fit(X, y)
            trained[name] = m
        except Exception:
            continue
    return trained


def _bic_weights(models, Xtr, ytr):
    n = len(ytr)
    w = {}
    bics = {}
    for name, m in models.items():
        pred = np.asarray(m.predict(Xtr), dtype=float)
        rss = float(np.sum((ytr - pred) ** 2))
        k = {"bayes": Xtr.shape[1] + 1, "hgb": 16, "gp": Xtr.shape[1] + 2}.get(name, Xtr.shape[1])
        bics[name] = n * math.log(max(rss / n, 1e-9)) + k * math.log(n)
    mn = min(bics.values())
    raw = {name: math.exp(-0.5 * (b - mn)) for name, b in bics.items()}
    s = sum(raw.values()) or 1.0
    for name in raw:
        w[name] = raw[name] / s
    return w


def _stacking_weights(models, Xtr, ytr):
    w = {}
    inv = {}
    for name, m in models.items():
        pred = np.asarray(m.predict(Xtr), dtype=float)
        resid = ytr - pred
        var = float(np.var(resid)) + 1e-9
        inv[name] = 1.0 / var
    s = sum(inv.values()) or 1.0
    for name in inv:
        w[name] = inv[name] / s
    return w


def _combine(models, X, method, Xtr, ytr):
    names = list(models.keys())
    if method == "equal":
        weights = {n: 1.0 / len(names) for n in names}
    elif method == "bma":
        weights = _bic_weights(models, Xtr, ytr)
    elif method == "stacking":
        weights = _stacking_weights(models, Xtr, ytr)
    else:
        raise ValueError(method)
    preds = {n: np.asarray(m.predict(X), dtype=float) for n, m in models.items()}
    out = np.zeros(len(X))
    for n in names:
        out += weights[n] * preds[n]
    return out, weights


def _fit_calibration(mode, log_preds, ratios, red_avgs):
    if mode == "median":
        gk = float(np.median(ratios))
        buckets: dict[str, list[float]] = {}
        for ra, r in zip(red_avgs, ratios):
            bk = "lt2" if ra < 2 else ("2-3" if ra < 3 else ("3-4" if ra < 4 else "gt4"))
            buckets.setdefault(bk, []).append(r)
        bk_med = {k: float(np.median(v)) for k, v in buckets.items()}

        def fn(red_avg, log_pred):
            bk = "lt2" if red_avg < 2 else ("2-3" if red_avg < 3 else ("3-4" if red_avg < 4 else "gt4"))
            k = bk_med.get(bk, gk)
            return float(min(max(k, 0.2), 3.0))

        return {"kind": "median", "global": gk, "buckets": bk_med, "fn": fn}
    elif mode == "loess":
        # 复用生产实现（app.services.estimator.loess_fit），保证回测与线上同一条曲线
        from app.services.estimator import loess_fit

        fx, fy = loess_fit(log_preds, ratios, frac=0.4)

        def fn(red_avg, log_pred):
            k = float(np.interp(log_pred, fx, fy))
            return float(min(max(k, 0.2), 3.0))

        return {"kind": "loess", "fit_x": fx.tolist(), "fit_y": fy.tolist(), "fn": fn}
    else:
        raise ValueError(mode)


def _metrics(actual, pred):
    actual = np.asarray(actual, dtype=float)
    pred = np.asarray(pred, dtype=float)
    mape = float(np.mean(np.abs(pred - actual) / np.maximum(actual, 1.0)) * 100)
    med = float(np.median(actual / pred))
    return mape, med


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--calibration", choices=["median", "loess"], default="median")
    ap.add_argument("--calib-full", choices=["median", "loess"], default=None)
    ap.add_argument("--calib-red", choices=["median", "loess"], default=None)
    ap.add_argument("--fusion", choices=["equal", "bma", "stacking"], default="equal")
    ap.add_argument("--features", choices=["base", "v2"], default="base")
    ap.add_argument("--split", type=float, default=0.7)
    args = ap.parse_args()
    args.calib_full = args.calib_full or args.calibration
    args.calib_red = args.calib_red or args.calibration

    ml.USE_V2_FEATURES = (args.features == "v2")
    feat_names = ml._active_features()

    with db() as conn:
        games = _load_games(conn)
        feats, y_red, y_full = ml.build_dataset(conn)

    n = len(feats)
    assert n == len(games), f"feats({n}) != games({len(games)})"
    cut = max(1, int(n * args.split))
    tr, te = list(range(cut)), list(range(cut, n))

    med = ml._impute(feats)
    X = np.asarray([[f[k] if f[k] == f[k] else med[k] for k in feat_names] for f in feats])
    YR = np.asarray(y_red)
    YF = np.asarray(y_full)

    models_r = _train_bases(X[tr], YR[tr])
    models_f = _train_bases(X[tr], YF[tr])
    Xtr, YRtr, YFtr = X[tr], YR[tr], YF[tr]

    # 分别计算 red / full 的融合残差
    res_r_tr, _ = _combine(models_r, X[tr], args.fusion, Xtr, YRtr)
    res_f_tr, _ = _combine(models_f, X[tr], args.fusion, Xtr, YFtr)
    res_r_te, wr = _combine(models_r, X[te], args.fusion, Xtr, YRtr)
    res_f_te, wf = _combine(models_f, X[te], args.fusion, Xtr, YFtr)

    def full_pred(i_global, res_f):
        f = feats[i_global]
        rule_ev = math.exp(f["rule_full_log"])
        ml_ev = math.exp(f["rule_full_log"] + res_f)
        known = f["known_size"] > 0
        return 0.5 * rule_ev + 0.5 * ml_ev if known else ml_ev

    def red_pred(i_global, res_r):
        f = feats[i_global]
        rule_ev = math.exp(f["rule_red_log"])
        ml_ev = math.exp(f["rule_red_log"] + res_r)
        known = f["known_size"] > 0
        return 0.5 * rule_ev + 0.5 * ml_ev if known else ml_ev

    # 训练集校准拟合
    tr_full_pred = np.array([full_pred(i, res_f_tr[k]) for k, i in enumerate(tr)])
    tr_red_pred = np.array([red_pred(i, res_r_tr[k]) for k, i in enumerate(tr)])
    tr_actual_full = np.array([games[i]["full_value"] for i in tr])
    tr_actual_red = np.array([games[i]["red_value"] for i in tr])
    calib_f = _fit_calibration(args.calib_full, np.log(tr_full_pred),
                               (tr_actual_full / tr_full_pred).tolist(),
                               [feats[i]["red_avg"] for i in tr])
    calib_r = _fit_calibration(args.calib_red, np.log(tr_red_pred),
                               (tr_actual_red / tr_red_pred).tolist(),
                               [feats[i]["red_avg"] for i in tr])

    # 测试集评估
    te_full_pred = np.array([full_pred(i, res_f_te[k]) for k, i in enumerate(te)])
    te_red_pred = np.array([red_pred(i, res_r_te[k]) for k, i in enumerate(te)])
    te_actual_full = np.array([games[i]["full_value"] for i in te])
    te_actual_red = np.array([games[i]["red_value"] for i in te])
    te_red_avg = [feats[i]["red_avg"] for i in te]

    te_full_cal = np.array([p * calib_f["fn"](ra, math.log(p))
                            for p, ra in zip(te_full_pred, te_red_avg)])
    te_red_cal = np.array([p * calib_r["fn"](ra, math.log(p))
                           for p, ra in zip(te_red_pred, te_red_avg)])

    full_mape, full_med = _metrics(te_actual_full, te_full_cal)
    red_mape, red_med = _metrics(te_actual_red, te_red_cal)

    # 覆盖率：训练残差(对数) conformal 分位 → 测试区间覆盖
    resid_f = YFtr - res_f_tr  # 校准前
    lo_p = (ml.CONFORMAL_ALPHA / 2) * 100
    hi_p = (1 - ml.CONFORMAL_ALPHA / 2) * 100
    q10 = np.percentile(resid_f, lo_p)
    q90 = np.percentile(resid_f, hi_p)
    in_lo = (YF[te] >= res_f_te + q10)
    in_hi = (YF[te] <= res_f_te + q90)
    coverage = float(np.mean(in_lo & in_hi)) * 100

    print(json.dumps({
        "config": {
            "calibration": args.calibration,
            "calib_full": args.calib_full,
            "calib_red": args.calib_red,
            "fusion": args.fusion,
            "features": args.features,
            "n_train": len(tr), "n_test": len(te),
        },
        "full_mape_pct": round(full_mape, 2),
        "full_medratio": round(full_med, 4),
        "red_mape_pct": round(red_mape, 2),
        "red_medratio": round(red_med, 4),
        "coverage_pct": round(coverage, 1),
        "fusion_weights_full": {k: round(v, 3) for k, v in wf.items()},
        "fusion_weights_red": {k: round(v, 3) for k, v in wr.items()},
        "calib_full": {kk: vv for kk, vv in calib_f.items() if kk in ("kind", "global", "buckets")},
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
