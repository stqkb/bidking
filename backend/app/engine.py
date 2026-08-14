"""规则引擎：均格反推 -> 格数组合 -> 红品价值 -> 全场估值 -> 出价建议。"""
from __future__ import annotations

import math
import json
from collections import Counter
from functools import lru_cache
from typing import Any

import numpy as np

from .config import DEFAULT_FULL_RATIO, DEFAULT_MARGIN, DEFAULT_PRICES, MAX_RED_COUNT, MAX_RED_GRIDS, BID_UNCERTAINTY_THRESHOLD
from .core import cache

SIZE_FALLBACK = [1, 2, 3, 4, 6, 8, 9, 12, 15, 16]
# 已知红品校准强度：raw 系数向 1.0 收敛的比例。
# 测试集（32-43局）验证：开校准会放大误差，默认关闭（0.0）。
CALIB_BLEND = 0.0


def get_catalog_stats(conn) -> dict[int, dict[str, Any]]:
    """按格数统计图鉴：count/mean/median/p10/p90/min/max，并保留数值池。

    结果缓存在内存（catalog_items 变化后由 cache.invalidate_catalog() 失效）。
    """
    def _load() -> dict[int, dict[str, Any]]:
        rows = conn.execute(
            "SELECT grid_cells, value FROM catalog_items WHERE value > 0"
        ).fetchall()
        by_grid: dict[int, list[float]] = {}
        for r in rows:
            by_grid.setdefault(int(r["grid_cells"]), []).append(float(r["value"]))
        stats: dict[int, dict[str, Any]] = {}
        for g, vals in by_grid.items():
            arr = np.asarray(vals, dtype=float)
            stats[g] = {
                "count": len(arr),
                "mean": float(arr.mean()),
                "median": float(np.median(arr)),
                "p10": float(np.percentile(arr, 10)),
                "p90": float(np.percentile(arr, 90)),
                "min": float(arr.min()),
                "max": float(arr.max()),
                "pool": arr,
            }
        return stats

    return cache._cache.get(cache.KEY_CATALOG_STATS, _load)


def get_blended_stats(conn) -> dict[int, dict[str, Any]]:
    """以图鉴(Excel)价格为权威来源统计各格数；均值用 10% 截尾均值抗异常值。

    结果缓存在内存（catalog_items 变化后由 cache.invalidate_catalog() 失效）。
    """
    def _load() -> dict[int, dict[str, Any]]:
        cat = get_catalog_stats(conn)
        out: dict[int, dict[str, Any]] = {}
        for g, c in cat.items():
            pool = _trimmed_pool(np.asarray(c["pool"], dtype=float))
            out[g] = {
                "count": c["count"],
                "emp_n": c["count"],
                "mean": float(pool.mean()),
                "median": float(np.median(pool)),
                "p10": float(np.percentile(pool, 10)),
                "p90": float(np.percentile(pool, 90)),
                "min": float(pool.min()),
                "max": float(pool.max()),
                "pool": pool,
            }
        return out

    return cache._cache.get(cache.KEY_BLENDED_STATS, _load)


def _trimmed_pool(arr: np.ndarray, trim: float = 0.1) -> np.ndarray:
    """去掉两端各 10% 的异常高价/低价后返回价格池（样本过少时原样返回）。"""
    a = np.sort(np.asarray(arr, dtype=float))
    if a.size < 5:
        return a
    k = max(1, int(a.size * trim))
    return a[k:-k]


def get_full_ratio(conn) -> float:
    """全场总价值 / 红品价值的实测均值，缺数据时用兜底 1.36。

    结果缓存在内存（game_records 变化后由 cache.invalidate_games() 失效）。
    """
    def _load() -> float:
        rows = conn.execute(
            "SELECT full_value, red_value FROM game_records WHERE full_value > 0 AND red_value > 0"
        ).fetchall()
        if not rows:
            return DEFAULT_FULL_RATIO
        ratios = [float(r["full_value"]) / float(r["red_value"]) for r in rows]
        return float(np.mean(ratios))

    return cache._cache.get(cache.KEY_FULL_RATIO, _load)


def get_count_prior(conn) -> dict[int, float]:
    """红品件数的经验分布（31 局直方图归一化）。

    结果缓存在内存（game_records 变化后由 cache.invalidate_games() 失效）。
    """
    def _load() -> dict[int, float]:
        rows = conn.execute(
            "SELECT red_count FROM game_records WHERE red_count > 0"
        ).fetchall()
        if not rows:
            return {}
        c = Counter(int(r["red_count"]) for r in rows)
        total = sum(c.values())
        return {k: v / total for k, v in c.items()}

    return cache._cache.get(cache.KEY_COUNT_PRIOR, _load)


def find_candidates(
    c: float,
    max_grids: int = MAX_RED_GRIDS,
    max_items: int = MAX_RED_COUNT,
    tol: float = 0.01,
) -> list[tuple[int, int]]:
    """反推满足 c <= a/b <= c+tol 的 (总格数 a, 件数 b)。

    游戏给出的均格只有 1 位小数且不按四舍五入显示，
    因此用宽容区间匹配，避免把 15/4=3.75（游戏显示为 3.7）这类合法组合排除掉。
    """
    if c <= 0:
        return []
    hi = c + tol
    out: list[tuple[int, int]] = []
    for b in range(1, max_items + 1):
        a_min = max(1, math.ceil(c * b - 1e-9))
        a_max = min(max_grids, math.floor(hi * b + 1e-9))
        for a in range(a_min, a_max + 1):
            v = round(a / b, 6)
            if c - 1e-9 <= v <= hi + 1e-9:
                out.append((a, b))
    return out


def rank_candidates(
    cands: list[tuple[int, int]],
    prior: dict[int, float],
    b_est: int | None,
    k: int = 8,
) -> list[dict[str, Any]]:
    """按件数先验 + 用户预估件数排序候选。"""
    if not cands:
        return []
    max_p = max(prior.values()) if prior else 1.0
    scored = []
    for a, b in cands:
        prior_score = (prior.get(b, 0.0) / max_p) if prior else 0.0
        if b_est:
            dist = max(0.0, 1.0 - abs(b - b_est) / max(b_est, 1))
        else:
            dist = 0.0
        score = 0.6 * prior_score + 0.4 * dist
        scored.append({"red_grids": a, "red_count": b, "score": round(score, 4)})
    scored.sort(key=lambda d: (-d["score"], d["red_count"]))
    return scored[:k]


@lru_cache(maxsize=256)
def _count_dp(b: int, a: int, sizes: tuple[int, ...]) -> np.ndarray:
    """有序格数组合计数 DP（numpy int64，饱和到 1e15 防止大数拖慢）。

    返回 (b+1, a+1) 数组：dp[i, j] = i 件总格数 j 的合法组合数。
    原实现用 list of lists + 逐元素 Python 索引，改为 numpy 行内向量加法，
    每行一次 O(a) 的向量操作替代 O(a) 次 Python 循环。
    """
    cap = 10**15
    dp = np.zeros((b + 1, a + 1), dtype=np.int64)
    dp[0, 0] = 1
    for i in range(1, b + 1):
        prev = dp[i - 1]
        row = dp[i]
        for s in sizes:
            if s <= a:
                row[s:] = np.minimum(row[s:] + prev[: a + 1 - s], cap)
    return dp


def count_compositions(a: int, b: int, sizes: tuple[int, ...]) -> int:
    if a <= 0 or b <= 0:
        return 0
    dp = _count_dp(b, a, tuple(sorted(sizes)))
    return int(dp[b, a])


@lru_cache(maxsize=256)
def _count_mset(b: int, a: int, sizes: tuple[int, ...]) -> int:
    """唯一多重集计数（coin-change 式，顺序无关），饱和到 1e15。

    _count_dp 统计的是**有序排列**数（含排列重复，数值巨大）；而本函数按
    「每种格数可用任意次、顺序无关」计数，即真正的互不重复组合数——
    用它判断「组合空间是否 > 采样目标」才准确，避免在很小空间里空转采样。
    """
    cap = 10**15
    dp = np.zeros((b + 1, a + 1), dtype=np.int64)
    dp[0, 0] = 1
    for s in sizes:
        if s > a:
            continue
        for i in range(1, b + 1):
            row = dp[i]
            prev = dp[i - 1]
            row[s:] = np.minimum(row[s:] + prev[: a + 1 - s], cap)
    return int(dp[b, a])


def sample_composition(
    dp: list[list[int]], sizes: tuple[int, ...], b: int, a: int, rng: np.random.Generator
) -> list[int] | None:
    comp: list[int] = []
    rem_a, rem_b = a, b
    while rem_b > 0:
        weights = [dp[rem_b - 1][rem_a - s] if s <= rem_a else 0 for s in sizes]
        total = sum(weights)
        if total <= 0:
            return None
        r = rng.random() * total
        acc = 0.0
        chosen = sizes[0]
        for s, w in zip(sizes, weights):
            acc += w
            if r <= acc:
                chosen = s
                break
        comp.append(chosen)
        rem_a -= chosen
        rem_b -= 1
    return comp


def _sample_comps_mat(
    dp: np.ndarray,
    sizes: tuple[int, ...],
    b: int,
    a: int,
    rng: np.random.Generator,
    n: int,
) -> np.ndarray:
    """批量采样 n 个格数组合，返回 (n, b) 矩阵（每行 b 个位置依次填格数）。

    每步用 active 掩码剔除已无路可走的行（剩余格数无法被剩余件数凑出的死行），
    只对活跃行做 DP 权重查表与向量化 choice——避免死行空转计算。
    死行位置留 0，由调用方用 sum(行) == a 过滤。
    """
    sizes_arr = np.asarray(sizes, dtype=np.int64)
    n_s = len(sizes_arr)
    comps = np.zeros((n, b), dtype=np.int64)
    rem_a = np.full(n, a, dtype=np.int64)
    active = np.ones(n, dtype=bool)
    for step in range(b):
        rem_b = b - step
        a_idx = np.flatnonzero(active)
        m = a_idx.size
        if m == 0:
            break
        sub = rem_a[a_idx]
        w = np.zeros((m, n_s), dtype=np.float64)
        for j, s in enumerate(sizes_arr):
            idx2 = sub - s
            ok = idx2 >= 0
            vals = dp[rem_b - 1, np.clip(idx2, 0, a)].astype(np.float64)
            w[:, j] = np.where(ok, vals, 0.0)
        total = w.sum(axis=1)
        dead = total <= 0
        if dead.all():
            break
        safe = np.where(total > 0, total, 1.0)
        r = rng.random(m) * safe + 1e-12
        chosen = np.argmax(np.cumsum(w, axis=1) >= r[:, None], axis=1)
        sel = sizes_arr[chosen]
        comps[a_idx, step] = sel
        rem_a[a_idx] = sub - sel
        active[a_idx[dead]] = False
    return comps


def _enumerate_comps(
    dp: np.ndarray, sizes: tuple[int, ...], b: int, a: int
) -> list[list[int]]:
    """按非递减约束回溯枚举全部合法格数组合（唯一多重集，无需去重）。

    组合总数已知 <= 调用方阈值时才启用：确定性返回所有组合，
    替代「随机采样 + set 去重」在小空间下的空转（曾出现 20 轮采样仍集不齐）。
    """
    sizes_l = sorted(sizes)
    out: list[list[int]] = []

    def rec(rem_b: int, rem_a: int, min_si: int, cur: list[int]) -> None:
        if rem_b == 0:
            if rem_a == 0:
                out.append(cur[:])
            return
        for j in range(min_si, len(sizes_l)):
            s = sizes_l[j]
            if s > rem_a:
                break
            if dp[rem_b - 1, rem_a - s] > 0:
                cur.append(s)
                rec(rem_b - 1, rem_a - s, j, cur)
                cur.pop()

    rec(b, a, 0, [])
    return out


def sample_compositions(
    a: int,
    b: int,
    sizes: tuple[int, ...],
    n: int,
    rng,
    must_include: int | list[int] | None = None,
) -> list[list[int]]:
    """采样 n 组互不重复的格数组合；must_include 指定必须出现的格数（可多个，如已知红品）。

    策略分两档：
    - 组合总数 <= n：DP 回溯**枚举全部**（确定性，一次返回，避免随机去重空转）；
    - 组合总数 > n：批量向量采样 + set 去重，通常 1~2 轮即可集齐。
    """
    sizes = tuple(sorted(sizes))
    if must_include is not None:
        known = [must_include] if isinstance(must_include, int) else list(must_include)
        if any(s not in sizes for s in known):
            return []
        rem_a, rem_b = a - sum(known), b - len(known)
        if rem_a < 0 or rem_b < 0:
            return []
        if rem_b == 0:
            return [sorted(known)] if rem_a == 0 else []
        dp = _count_dp(rem_b, rem_a, sizes)
        if dp[rem_b, rem_a] <= 0:
            return []
        base_b, base_a, base_known = rem_b, rem_a, sorted(known)
    else:
        dp = _count_dp(b, a, sizes)
        if dp[b, a] <= 0:
            return []
        base_b, base_a, base_known = b, a, []

    # 用「唯一多重集数」判断空间：有序排列数(总)往往巨大但多重集很少，
    # 若多重集 <= n 直接枚举，避免在小空间里随机采样去重空转。
    mset = _count_mset(base_b, base_a, sizes)
    if mset <= 0:
        return []
    if mset <= n:
        enum = _enumerate_comps(dp, sizes, base_b, base_a)
        if base_known:
            return [sorted(base_known + c) for c in enum]
        return enum

    out: list[list[int]] = []
    seen: set[tuple[int, ...]] = set()
    batch_n = max(n * 6, 600)          # 单批采样量：组合空间大时首轮即可集齐
    for _ in range(20):                # 轮数上限（通常 1~2 轮命中）
        mat = _sample_comps_mat(dp, sizes, base_b, base_a, rng, batch_n)
        valid = mat[mat.sum(axis=1) == base_a]
        if valid.size == 0:
            break
        if base_known:
            kn = np.asarray(base_known, dtype=np.int64)
            merged = np.sort(
                np.concatenate(
                    [valid, np.broadcast_to(kn, (valid.shape[0], len(kn)))], axis=1
                ),
                axis=1,
            )
            rows = merged.tolist()
        else:
            rows = np.sort(valid, axis=1).tolist()
        for row in rows:
            key = tuple(row)
            if key in seen:
                continue
            seen.add(key)
            out.append(row)
            if len(out) >= n:
                return out[:n]
    return out[:n]


def calibration_factor(stats: dict[int, dict[str, Any]], known_size: int | None,
                       known_value: float | None, blend: float = CALIB_BLEND) -> float:
    """已知红品价值 / 该格数图鉴均值，限幅 0.5-2.0 后向 1.0 温和收敛。"""
    if not known_size or not known_value or known_value <= 0:
        return 1.0
    s = stats.get(known_size)
    if not s or s["mean"] <= 0:
        return 1.0
    raw = float(np.clip(known_value / s["mean"], 0.5, 2.0))
    return float(1.0 + blend * (raw - 1.0))


def estimate_candidate(
    a: int,
    b: int,
    stats: dict[int, dict[str, Any]],
    rng: np.random.Generator,
    n_comps: int = 400,
    mc_draws: int = 16,
    must_include: int | list[int] | None = None,
    known_adjust: float = 0.0,
) -> dict[str, Any] | None:
    """单候选估值：批量组合采样 + 向量化期望与蒙特卡洛区间。

    原实现对每个组合逐格 `rng.choice(pool[s])` 共 n_comps×mc_draws×b 次 Python 调用；
    现改为把组合写成 (n_comps, b) 矩阵，一次生成 (n_comps, b, mc_draws) 随机索引
    直接查全局价格池求和，EV 同样向量化。数值语义与原来一致。
    """
    sizes = tuple(sorted(stats.keys()))
    comps = sample_compositions(a, b, sizes, n_comps, rng, must_include=must_include)
    if not comps:
        return None
    n_eff = len(comps)
    # 预构建按格数数组 + 全局价格池
    means = np.array([stats[s]["mean"] for s in sizes])
    pools = [stats[s]["pool"] for s in sizes]
    offsets = np.cumsum([0] + [p.size for p in pools])[:-1]
    big_pool = np.concatenate(pools) if pools else np.zeros(0, dtype=float)

    comps_np = np.asarray(comps, dtype=np.int64)      # (n_eff, b)
    size_ids = np.searchsorted(sizes, comps_np)        # (n_eff, b)
    # 组合期望：每格均值求和（确定性，无需 MC）
    evs = means[size_ids].sum(axis=1) + known_adjust   # (n_eff,)
    # 蒙特卡洛：每位置独立抽样 mc_draws 次价值并求和
    lens = np.array([p.size for p in pools])[size_ids]  # (n_eff, b)
    offs = offsets[size_ids]                            # (n_eff, b)
    idx = rng.integers(0, lens[:, :, None], size=(n_eff, b, mc_draws))
    vals = big_pool[offs[:, :, None] + idx]             # (n_eff, b, mc_draws)
    totals = vals.sum(axis=1) + known_adjust            # (n_eff, mc_draws)
    return {
        "ev": float(np.mean(evs)),
        "totals": totals.reshape(-1),
        "compositions": [sorted(c.tolist()) for c in comps_np[:5]],
        "n_compositions": n_eff,
    }


def aggregate_red(
    candidates: list[dict[str, Any]],
    stats: dict[int, dict[str, Any]],
    factor: float,
    rng: np.random.Generator,
    must_include: int | list[int] | None = None,
    known_value_total: float = 0.0,
    known_adjust: float = 0.0,
) -> dict[str, Any]:
    """聚合各候选的红品价值统计（按候选得分加权）。

    原实现对拼接后的样本做 20000 次加权重采样再取分位数（每次请求 ~20000 次
    fancy indexing，且带随机噪声）；改为直接对加权样本按值排序、累计权重插值
    求分位数（等价于重采样的期望极限），O(M log M)，更快且结果确定。
    """
    evs: list[float] = []
    pooled_arrays: list[np.ndarray] = []
    comps: list[list[int]] = []
    cand_weights: list[float] = []
    ev_weights: list[float] = []
    for cand in candidates:
        est = estimate_candidate(
            cand["red_grids"],
            cand["red_count"],
            stats,
            rng,
            must_include=must_include,
            known_adjust=known_adjust,
        )
        if est is None:
            continue
        cand["estimate"] = {
            "ev": est["ev"] * factor,
            "p10": float(np.percentile(est["totals"], 10)) * factor,
            "p50": float(np.percentile(est["totals"], 50)) * factor,
            "p90": float(np.percentile(est["totals"], 90)) * factor,
            "n_compositions": est["n_compositions"],
            "remaining_ev": max(0.0, est["ev"] * factor - known_value_total),
        }
        cand["compositions"] = est["compositions"]
        cand["composition_count"] = est["n_compositions"]
        evs.append(est["ev"])
        pooled_arrays.append(est["totals"])
        # 每个候选按分数等权参与区间抽样（除以各自的抽样次数），
        # 避免组合数多的候选在 p10/p90 里被重复加权，导致区间与期望不一致。
        n_tot = int(est["totals"].size)
        draw_w = max(cand["score"], 0.02) / max(n_tot, 1)
        cand_weights.extend([draw_w] * n_tot)
        ev_weights.append(max(cand["score"], 0.02))
        comps.extend(est["compositions"])
    if not evs:
        return {}
    pooled_np = np.concatenate(pooled_arrays)
    w = np.asarray(cand_weights, dtype=float)
    w = w / w.sum()
    # 对数域加权分位数（等价于原 20000 次重采样 + percentile 的期望极限）
    log_arr = np.log(np.clip(pooled_np, 1.0, None))
    order = np.argsort(log_arr)
    ls = log_arr[order]
    ws = w[order]
    cw = np.cumsum(ws)
    cw = cw / cw[-1]

    def wq(p: float) -> float:
        return float(np.interp(p, cw, ls))

    weights_by_cand = np.asarray(ev_weights, dtype=float)
    weights_by_cand = weights_by_cand / weights_by_cand.sum()
    ev = float(np.average(evs, weights=weights_by_cand)) * factor
    return {
        "ev": ev,
        "p10": float(np.exp(wq(0.10))) * factor,
        "p50": float(np.exp(wq(0.50))) * factor,
        "p90": float(np.exp(wq(0.90))) * factor,
        "min": float(np.exp(wq(0.02))) * factor,
        "max": float(np.exp(wq(0.98))) * factor,
        "factor": factor,
        "composition_samples": comps[:8],
    }


def _full_from_fields(red: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    v_wg = float(inputs.get("v_wg") or DEFAULT_PRICES["v_wg"])
    v_b = float(inputs.get("v_b") or DEFAULT_PRICES["v_b"])
    v_p = float(inputs.get("v_p") or DEFAULT_PRICES["v_p"])
    v_g = float(inputs.get("v_g") or DEFAULT_PRICES["v_g"])
    wg = float(inputs.get("wg_grids") or 0)
    bl = float(inputs.get("blue_grids") or 0)
    pu = float(inputs.get("purple_grids") or 0)
    go = float(inputs.get("gold_grids") or 0)
    fixed = wg * v_wg + bl * v_b + pu * v_p + go * v_g
    return {
        "ev": fixed + red["ev"],
        "p10": fixed + red["p10"],
        "p50": fixed + red["p50"],
        "p90": fixed + red["p90"],
        "min": fixed + red["min"],
        "max": fixed + red["max"],
        "mode": "细分",
    }


def _full_by_ratio(red: dict[str, Any], ratio: float) -> dict[str, Any]:
    return {
        "ev": red["ev"] * ratio,
        "p10": red["p10"] * ratio,
        "p50": red["p50"] * ratio,
        "p90": red["p90"] * ratio,
        "min": red["min"] * ratio,
        "max": red["max"] * ratio,
        "mode": "倍率",
    }


def risk_level(full: dict[str, Any]) -> tuple[str, float]:
    denom = full.get("p10") or 1.0
    score = (full["p90"] / denom) if denom > 0 else 1.0
    if score < 3.0:
        return "低", round(score, 2)
    if score < 8.0:
        return "中", round(score, 2)
    return "高", round(score, 2)


def compute_bid(full: dict[str, Any], margin: float, min_bid_input: float | None = None) -> dict[str, Any]:
    """保守出价策略：基于 p10 下限而非 EV 均值，避免赢家诅咒。

    推荐出价 = p10 × margin（margin 默认 0.85，留 15% 安全垫）
    最高出价 = p10（绝对天花板，超过即放弃）
    不建议出价条件：p10/ev 过低（估值太不可靠）或风险过高
    """
    p10 = full.get("p10", 0) or 0
    ev = full.get("ev", 0) or 0
    p90 = full.get("p90", 0) or 0
    risk, risk_score = risk_level(full)

    recommended = p10 * margin
    max_bid = p10  # 绝对天花板
    min_price = float(min_bid_input) if min_bid_input else p10 * margin * 0.8

    # 不确定性判定：p10/ev 过低说明估值区间太宽，p10 不可信
    uncertainty_ratio = p10 / ev if ev > 0 else 0.0
    should_bid = True
    bid_reason = ""

    if ev <= 0 or p10 <= 0:
        should_bid = False
        bid_reason = "估值数据异常，无法给出出价建议"
    elif uncertainty_ratio < BID_UNCERTAINTY_THRESHOLD:
        should_bid = False
        bid_reason = (
            f"估值不确定性过高（p10/ev={uncertainty_ratio:.1%} < {BID_UNCERTAINTY_THRESHOLD:.0%}），"
            f"保守下限 {p10:,.0f} 远低于期望 {ev:,.0f}，出价风险极大，建议放弃本场"
        )
    elif risk == "高" and risk_score >= 8.0:
        should_bid = False
        bid_reason = (
            f"风险等级过高（区间倍数 ×{risk_score:.1f}），"
            f"价值波动范围 {p10:,.0f} ~ {p90:,.0f} 跨度过大，建议放弃本场"
        )
    else:
        worst_profit = p10 - recommended  # 最坏情况利润
        expected_profit = ev - recommended  # 期望利润
        if worst_profit <= 0:
            should_bid = False
            bid_reason = (
                f"即使在保守下限 p10={p10:,.0f} 出价也无法保证盈利"
                f"（推荐出价 {recommended:,.0f} ≥ p10），建议放弃本场"
            )
        else:
            bid_reason = (
                f"推荐出价 {recommended:,.0f} = 保守下限(p10) × {margin:.0%}，"
                f"最坏情况利润 ≥ {worst_profit:,.0f}，期望利润 ≈ {expected_profit:,.0f}；"
                f"绝对天花板 {max_bid:,.0f}，超过即放弃"
            )

    return {
        "recommended": round(recommended, 0),
        "max_bid": round(max_bid, 0),
        "min_price": round(min_price, 0),
        "margin": margin,
        "risk": risk,
        "risk_score": risk_score,
        "should_bid": should_bid,
        "bid_reason": bid_reason,
        "uncertainty_ratio": round(uncertainty_ratio, 3),
        "worst_case_profit": round(p10 - recommended, 0),
        "expected_profit": round(ev - recommended, 0),
    }


def similar_games(conn, avg: float | None, k: int = 6) -> list[dict[str, Any]]:
    if avg is None or avg <= 0:
        return []
    rows = conn.execute(
        """SELECT game_no, grid_combo, red_count, red_grids, red_avg, red_value,
                  full_value, deal_price, min_bid, profit, winner
           FROM game_records WHERE red_avg IS NOT NULL
           ORDER BY ABS(red_avg - ?) LIMIT ?""",
        (avg, k * 2),
    ).fetchall()
    out = []
    for r in rows:
        if abs(float(r["red_avg"]) - avg) <= 0.15:
            out.append(dict(r))
    return out[:k]


def run_estimate(conn, inputs: dict[str, Any]) -> dict[str, Any]:
    warnings: list[str] = []
    c_raw = inputs.get("red_avg")
    if c_raw is None:
        return {"error": "缺少红品平均格数", "warnings": []}
    c_raw = float(c_raw)
    c = round(c_raw, 1)
    if abs(c - c_raw) > 1e-9:
        warnings.append(f"输入均格 {c_raw} 非 1 位小数，已四舍五入为 {c:.1f}")
    if not (0 < c <= MAX_RED_GRIDS):
        return {"error": "红品平均格数须在 (0, 50] 内", "warnings": []}

    stats = get_blended_stats(conn)
    if not stats:
        return {"error": "图鉴未导入，请先在「图鉴管理」导入 Excel", "warnings": []}
    sizes = tuple(sorted(stats.keys()))

    # 平均格数以 1 位小数为准（输入先四舍五入归一），候选按 ±0.05 宽容匹配。
    cands = find_candidates(c, tol=0.05)
    used_tol = 0.05
    warnings.append("均格为 1 位小数（游戏显示不按四舍五入），候选按 ±0.05 宽容匹配")
    if not cands:
        return {"error": f"均格 {c} 在 (总格数≤50, 件数≤80) 内无合法候选", "warnings": warnings}

    prior = get_count_prior(conn)
    ranked = rank_candidates(cands, prior, inputs.get("red_count_est"))
    all_ranked = ranked

    selected: dict[str, Any] = {"red_grids": None, "red_count": None, "applied": False}
    sel_a = inputs.get("selected_red_grids")
    sel_b = inputs.get("selected_red_count")
    if sel_a is not None and sel_b is not None:
        sel_a, sel_b = int(sel_a), int(sel_b)
        selected = {"red_grids": sel_a, "red_count": sel_b, "applied": False}
        locked = [d for d in all_ranked if d["red_grids"] == sel_a and d["red_count"] == sel_b]
        if locked:
            for d in all_ranked:
                d["selected"] = d["red_grids"] == sel_a and d["red_count"] == sel_b
            ranked = locked
            selected["applied"] = True
            warnings.append(f"已锁定候选 {sel_a} 格 / {sel_b} 件，估值与出价仅按该组合计算")
        else:
            warnings.append(f"候选 {sel_a} 格 / {sel_b} 件不在当前候选列表中，已忽略锁定")
    rng = np.random.default_rng(42)

    # 解析已知红品列表（兼容旧的单件字段 known_size/known_value）
    known_items_raw = inputs.get("known_items") or []
    known_sizes: list[int] = []
    known_vals: list[float] = []
    known_pairs: list[tuple[int, float]] = []
    if known_items_raw:
        for it in known_items_raw:
            if not isinstance(it, dict):
                continue
            s = it.get("size")
            if s:
                known_sizes.append(int(s))
                v = it.get("value")
                if v:
                    known_vals.append(float(v))
                    known_pairs.append((int(s), float(v)))
    else:
        ks = inputs.get("known_size")
        if ks:
            known_sizes.append(int(ks))
            kv = inputs.get("known_value")
            if kv:
                known_vals.append(float(kv))
                known_pairs.append((int(ks), float(kv)))
    known_size = known_sizes[0] if known_sizes else None
    known_value = known_vals[0] if known_vals else None
    # 已知藏品按实际价格计入期望（替代该格数的平均价），避免"单件已知藏品比整个候选期望还高"。
    known_adjust = 0.0
    if known_pairs:
        known_adjust = sum(v for _, v in known_pairs) - sum(
            stats[s]["mean"] for s, _ in known_pairs
        )
    raw_factor = 1.0
    if known_size and known_value and stats.get(known_size, {}).get("mean", 0) > 0:
        raw_factor = float(np.clip(float(known_value) / stats[known_size]["mean"], 0.5, 2.0))
    factor = calibration_factor(stats, known_size, known_value)
    if factor != 1.0 and inputs.get("use_calibration", True):
        warnings.append(
            f"已知红品校准系数 {factor:.2f}（原始 {raw_factor:.2f}，40% 温和融合）"
        )
    elif factor != 1.0:
        factor = 1.0

    # 所有已知红品都必须出现在组合里：过滤掉总格数/件数无法同时容纳的候选，
    # 采样组合时强制包含全部已知格数。
    if known_sizes:
        if any(s not in sizes for s in known_sizes):
            return {
                "error": f"已知红品格数 {'、'.join(map(str, known_sizes))} 中存在不在可用格数中的值",
                "warnings": warnings,
            }
        total_known = sum(known_sizes)
        m_known = len(known_sizes)
        feasible: list[dict[str, Any]] = []
        for d in all_ranked:
            rem_a = d["red_grids"] - total_known
            rem_b = d["red_count"] - m_known
            if rem_b == 0:
                ok = rem_a == 0
            elif rem_a > 0 and count_compositions(rem_a, rem_b, sizes) > 0:
                ok = True
            else:
                ok = False
            if ok:
                feasible.append(d)
        dropped = len(all_ranked) - len(feasible)
        if dropped:
            warnings.append(
                f"已知红品 {'+'.join(map(str, known_sizes))} 格：已过滤 {dropped} 个无法同时容纳这些格数的候选"
            )
        all_ranked = feasible
        if not all_ranked:
            return {
                "error": f"已知红品 {'+'.join(map(str, known_sizes))} 格，但没有候选组合能同时容纳这些格数",
                "warnings": warnings,
            }
        if selected.get("applied") and not any(
            d["red_grids"] == selected["red_grids"]
            and d["red_count"] == selected["red_count"]
            for d in all_ranked
        ):
            selected["applied"] = False
            warnings.append(f"锁定的候选无法容纳已知红品 {'+'.join(map(str, known_sizes))} 格，已恢复综合估值")
        if selected.get("applied"):
            ranked = [
                d
                for d in all_ranked
                if d["red_grids"] == selected["red_grids"]
                and d["red_count"] == selected["red_count"]
            ]
        else:
            ranked = all_ranked
        for d in all_ranked:
            d["selected"] = (
                selected.get("applied")
                and d["red_grids"] == selected["red_grids"]
                and d["red_count"] == selected["red_count"]
            )

    # 候选卡片需要展示每个候选的单独估值，因此始终对完整候选列表聚合一次。
    must_include = known_sizes or None
    known_value_total = sum(known_vals)
    red = aggregate_red(
        all_ranked,
        stats,
        factor,
        rng,
        must_include=must_include,
        known_value_total=known_value_total,
        known_adjust=known_adjust,
    )
    if not red:
        return {"error": "候选组合无法构成合法格数分布", "warnings": warnings}
    if selected.get("applied"):
        # 锁定态下，估值/区间/出价只按选中的候选计算。
        red = aggregate_red(
            ranked,
            stats,
            factor,
            rng,
            must_include=must_include,
            known_value_total=known_value_total,
            known_adjust=known_adjust,
        )
        if not red:
            return {"error": "候选组合无法构成合法格数分布", "warnings": warnings}

    has_fields = any(
        inputs.get(k) not in (None, "", 0)
        for k in ("wg_grids", "blue_grids", "purple_grids", "gold_grids")
    )
    if has_fields:
        full = _full_from_fields(red, inputs)
    else:
        ratio = get_full_ratio(conn)
        full = _full_by_ratio(red, ratio)
        warnings.append(f"未填其他品质，全场价值按实测倍率 {ratio:.2f} × 红品价值估算")

    margin = float(inputs.get("margin") or DEFAULT_MARGIN)
    min_bid_input = inputs.get("min_bid")
    bid = compute_bid(full, margin, float(min_bid_input) if min_bid_input else None)

    result = {
        "calibration": {"factor": factor, "known_size": known_size, "known_value": known_value},
        "red": red,
        "full": full,
        "bid": bid,
        "candidates": all_ranked,
        "selected": selected,
        "known": {
            "sizes": known_sizes,
            "value_total": known_value_total,
            "count": len(known_sizes),
        },
        "similar_games": similar_games(conn, c),
        "warnings": warnings,
        "precision_tol": used_tol,
        "rule_full_ratio": full.get("mode", "倍率"),
    }
    return result
