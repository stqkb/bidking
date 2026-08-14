"""验收评估脚本:遍历 crops_manifest.json,统计同款/异款余弦相似度分布。

用法:
    python backend/tests/eval_vision.py            # 仅原始图(跨截图,验收口径)
    python backend/tests/eval_vision.py --variants # 全部条目(含增广变体)

验收标准(原始图口径):同款中位分 >= 0.80,且(同款中位分 - 异款最高分) >= 0.15。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import vision  # noqa: E402


def _stats(arr: list[float]) -> dict[str, Any]:
    a = np.asarray(arr, dtype=np.float64)
    if len(a) == 0:
        return {
            "n": 0, "mean": None, "median": None,
            "p10": None, "p25": None, "p75": None, "p90": None,
            "min": None, "max": None,
        }
    return {
        "n": int(len(a)),
        "mean": round(float(a.mean()), 4),
        "median": round(float(np.median(a)), 4),
        "p10": round(float(np.percentile(a, 10)), 4),
        "p25": round(float(np.percentile(a, 25)), 4),
        "p75": round(float(np.percentile(a, 75)), 4),
        "p90": round(float(np.percentile(a, 90)), 4),
        "min": round(float(a.min()), 4),
        "max": round(float(a.max()), 4),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", action="store_true", help="包含增广变体条目")
    ap.add_argument("--json", action="store_true", help="仅输出 JSON")
    args = ap.parse_args()

    manifest = vision._load_manifest()
    if not args.variants:
        manifest = [m for m in manifest if not m.get("variant")]
    if len(manifest) < 2:
        print(json.dumps({"error": "样本不足"}, ensure_ascii=False))
        return

    feats = vision._encode([vision._open_pil(m["path"]) for m in manifest])
    sims = feats @ feats.T  # 已 L2 归一化 -> 余弦相似度

    same: list[float] = []
    diff: list[float] = []
    for i in range(len(manifest)):
        for j in range(i + 1, len(manifest)):
            s = float(sims[i, j])
            if manifest[i]["name"] == manifest[j]["name"]:
                same.append(s)
            else:
                diff.append(s)

    s_s, d_s = _stats(same), _stats(diff)
    gap = (
        round(s_s["median"] - d_s["max"], 4)
        if s_s["median"] is not None and d_s["max"] is not None
        else None
    )
    passed = (
        s_s["median"] is not None
        and s_s["median"] >= 0.80
        and gap is not None
        and gap >= 0.15
    )
    result = {
        "mode": "variants" if args.variants else "originals_only",
        "samples": len(manifest),
        "distinct_names": len({m["name"] for m in manifest}),
        "same": s_s,
        "diff": d_s,
        "gap_same_median_minus_diff_max": gap,
        "pass": bool(passed),
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=1))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=1))
        print("验收:", "PASS" if passed else "FAIL",
              "(同款中位>=0.80 且 同款中位-异款最高>=0.15)")


if __name__ == "__main__":
    main()
