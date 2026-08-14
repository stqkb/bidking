# -*- coding: utf-8 -*-
"""视觉通道验收自检:输出同款/异款相似度分布、审计结果与判定。"""
import sys
sys.stdout.reconfigure(encoding="utf-8")
from backend.app import vision

d = vision.eval_distribution()
if "error" in d:
    print("无法评估:", d["error"])
    print("提示:确认 data/crops_manifest.json 存在且有条目(图鉴管理页重建图库后重试)。")
    sys.exit(1)
s, f = d["same"], d["diff"]
gap_p10 = s["p10"] - f["p90"]
gap_med = s["median"] - f["p90"]
print("=" * 46)
print("视觉识别通道 · 验收自检")
print("=" * 46)
print("同款样本对: %d  | 中位 %.3f | p10 %.3f" % (s["n"], s["median"], s["p10"]))
print("异款样本对: %d  | 中位 %.3f | p90 %.3f" % (f["n"], f["median"], f["p90"]))
print("分离间隙(中位-p90): %.3f  | (p10-p90): %.3f" % (gap_med, gap_p10))
ok = s["median"] >= 0.80 and gap_med >= 0.15
print("判定:", "通过 - 视觉通道就绪可用" if ok else "未达标 - 请到「图像学习」页框选补样本后重试")
print("参考: 同款中位>=0.80 且 中位与异款p90间隙>=0.15 即视为就绪。")
print("说明: 图库增长期同款p10会暂时偏低,样本稳定后自然回升;")
print("      若出现同款中位下滑或审计可疑,再清理/重框选样本。")
