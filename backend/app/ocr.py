"""截图识别：按格数分组的藏品九宫格 -> 名称 + 价格 -> 图鉴匹配。"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import cv2
from PIL import Image
# rapidocr_onnxruntime（含 onnxruntime ~2s）惰性导入，见 get_ocr()

from .config import AUCTION_DIR, OCR_FAILED_DIR, OCR_PROCESSED_DIR, SCAN_DIR
from .core import cache
from .core.norm import norm_name as _norm_name
from .db import db, json_dumps
from .services import matching

from .config import DATA_DIR

_ocr = None  # RapidOCR 惰性实例化
_GPU_DLLS_DONE = False

# ══════════════════ 颜色参考（区分总价值/成交价 + 红品背景）═════════════════
_COLOR_REFS = None  # 惰性加载：{blue:{h,s,v,...}, yellow:{...}, red:{s,v,...}}


def _load_color_refs() -> dict:
    """读取 颜色图片/ 参考图，提取蓝/黄文字与红背景的 HSV 范围（惰性 + 缓存）。
    - 字体颜色/总价值 -> 蓝色文字（标记 total_value）
    - 字体颜色/成交价 -> 黄色文字（标记 deal_price）
    - 红品背景图     -> 红品格子背景的 HSV 范围（替代 _red_cell_ratio 硬编码阈值）
    若无参考图则返回空 dict，调用方回退到原逻辑。"""
    global _COLOR_REFS
    if _COLOR_REFS is not None:
        return _COLOR_REFS
    base = Path(__file__).resolve().parents[2] / "颜色图片"

    def _hue_stats(folder: str):
        fdir = base / folder
        if not fdir.exists():
            return None
        Hs, Ss, Vs = [], [], []
        for f in sorted(fdir.rglob("*.png")):
            try:
                arr = np.asarray(Image.open(f).convert("RGB")).astype(np.uint8)
            except Exception:
                continue
            hsv = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)
            H, S, V = hsv[..., 0].astype(int), hsv[..., 1].astype(int), hsv[..., 2].astype(int)
            m = (S >= 60) & (V >= 30)  # 彩色文字/背景像素
            Hs.extend(H[m].tolist()); Ss.extend(S[m].tolist()); Vs.extend(V[m].tolist())
        if not Hs:
            return None
        return (int(np.median(Hs)), int(np.median(Ss)), int(np.median(Vs)))

    blue = _hue_stats("字体颜色/总价值")
    yellow = _hue_stats("字体颜色/成交价")
    red = _hue_stats("红品背景图")
    _COLOR_REFS = {
        "blue": ({"h": blue[0], "s": blue[1], "v": blue[2],
                  "h_margin": 14, "s_margin": 34, "v_margin": 90} if blue else None),
        "yellow": ({"h": yellow[0], "s": yellow[1], "v": yellow[2],
                    "h_margin": 14, "s_margin": 34, "v_margin": 90} if yellow else None),
        "red": ({"s": red[1], "v": red[2], "s_margin": 40, "v_margin": 28, "h_band": 14}
                if red else None),
    }
    return _COLOR_REFS


def _get_color_refs() -> dict:
    return _load_color_refs() or {}


def _text_color_of_region(rgb: np.ndarray, box: dict, refs: dict) -> str:
    """判断文字框内数字的主色调：blue(蓝=总价值) / yellow(黄=成交价) / neutral。
    裁剪框周围 2px，统计蓝/黄文字像素占比（彩色文字对暗背景），多数者胜。"""
    x0 = max(0, int(box["x0"]) - 2); y0 = max(0, int(box["y0"]) - 2)
    x1 = min(rgb.shape[1], int(box["x1"]) + 2); y1 = min(rgb.shape[0], int(box["y1"]) + 2)
    if x1 <= x0 or y1 <= y0:
        return "neutral"
    reg = rgb[y0:y1, x0:x1].astype(np.uint8)
    hsv = cv2.cvtColor(reg, cv2.COLOR_RGB2HSV)
    H = hsv[..., 0].astype(int); S = hsv[..., 1].astype(int); V = hsv[..., 2].astype(int)
    area = (x1 - x0) * (y1 - y0)
    nb = ny = 0
    blu = refs.get("blue"); yel = refs.get("yellow")
    if blu:
        s_min = max(70, blu["s"] - blu["s_margin"]); v_min = max(120, blu["v"] - blu["v_margin"])
        m = (S >= s_min) & (V >= v_min) & (H >= blu["h"] - blu["h_margin"]) & (H <= blu["h"] + blu["h_margin"])
        nb = int(m.sum())
    if yel:
        s_min = max(70, yel["s"] - yel["s_margin"]); v_min = max(120, yel["v"] - yel["v_margin"])
        m = (S >= s_min) & (V >= v_min) & (H >= yel["h"] - yel["h_margin"]) & (H <= yel["h"] + yel["h_margin"])
        ny = int(m.sum())
    # 彩色文字像素占比过低 -> 中性（灰字/背景）
    if nb + ny < max(10, 0.03 * area):
        return "neutral"
    return "blue" if nb >= ny else "yellow"


def _ensure_gpu_dlls() -> None:
    """GPU OCR：若安装了 onnxruntime-gpu，把 torch 自带的 CUDA 12 DLL 目录加入搜索路径，
    使 RapidOCR 能实际使用 CUDAExecutionProvider（无 GPU 时自动回退 CPU）。
    惰性执行（冷启动优化：import onnxruntime/torch 较重，仅首次 OCR 时触发）。
    """
    global _GPU_DLLS_DONE
    if _GPU_DLLS_DONE:
        return
    _GPU_DLLS_DONE = True
    if os.environ.get("BIDKING_OCR_CPU") == "1":
        return
    try:
        import onnxruntime as _ort

        if "CUDAExecutionProvider" in _ort.get_available_providers():
            import torch as _torch

            _torch_lib = Path(_torch.__file__).resolve().parent / "lib"
            if _torch_lib.exists():
                os.environ["PATH"] = str(_torch_lib) + os.pathsep + os.environ.get("PATH", "")
    except Exception:  # noqa: BLE001 无 GPU/无 torch 时保持纯 CPU
        pass

_SETTLE_KEYWORDS = ["总价值", "成交价", "收益", "拍得者"]
_STOPWORDS = {
    "拍得者", "收益", "当前已揭示总价值", "最终成交价", "已揭示", "总价值",
    "成交价", "独白", "经过不懈努力", "成功达到", "段位", "福", "美",
}
# 系统公告横幅关键词（包含匹配）：公告/祝贺类文字不是藏品名
_BANNER_KEYWORDS = (
    "恭喜", "运气爆棚", "运气", "爆棚", "收获", "百万级", "千万级",
    "拍卖场", "小可肥",
)


def get_ocr():
    global _ocr
    if _ocr is None:
        _ensure_gpu_dlls()
        from rapidocr_onnxruntime import RapidOCR
        _ocr = RapidOCR()
    return _ocr


def _ocr_run(img) -> list[dict[str, Any]]:
    """直接对 ndarray/PIL 做 OCR（GPU），返回标准 box 列表，避免临时文件 IO。"""
    result, _ = get_ocr()(img)
    out = []
    for box, text, conf in result or []:
        if box is None or len(box) < 4:
            continue
        xs = [pt[0] for pt in box]
        ys = [pt[1] for pt in box]
        out.append({
            "text": str(text).strip(),
            "conf": float(conf or 0),
            "cx": float(np.mean(xs)),
            "cy": float(np.mean(ys)),
            "x0": float(min(xs)),
            "y0": float(min(ys)),
            "x1": float(max(xs)),
            "y1": float(max(ys)),
        })
    return out


def parse_shape(name: str) -> tuple[int, int] | None:
    m = re.match(r"^\s*(\d+)[×x*](\d+)\s*$", name)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


# 数字分隔符：同时接受半角逗号与全角逗号（OCR 常把 盈亏差额+94，830 的逗号识别为全角）
_NUM = r"[\d，,]+(?:\.\d+)?"

# 「格数为X.X」：截图直接以文字显示红品藏品的平均格数（纯文本提取，非计算均值）
_RED_AVG_RE = re.compile(r"格数为(\d+\.?\d*)")


def _is_price(t: str) -> bool:
    return bool(re.fullmatch(_NUM, t.strip()))


def _is_signed_price(t: str) -> bool:
    return bool(re.fullmatch(r"[+-]?" + _NUM, t.strip()))


def _check_profit_ok(full_value, deal_price, profit) -> int:
    """收益核验：profit 是否 = 总价值 - 成交价。数据齐全且吻合 → 1，否则 0。"""
    if full_value is None or deal_price is None or profit is None:
        return 1  # 缺数据不判错（历史兼容），仅当三值齐全且不吻合时标红
    try:
        if abs(float(profit) - (float(full_value) - float(deal_price))) > 0.5:
            return 0
    except (TypeError, ValueError):
        return 0
    return 1


def _parse_price(t: str) -> float:
    return float(t.replace(",", "").replace("，", "").replace("+", ""))


def _trunc1(x: float) -> float:
    """截断到 1 位小数（不四舍五入），与游戏显示规则一致。"""
    return math.floor(x * 10) / 10


def _inline_number(t: str) -> float | None:
    """从文本内提取数字（如「盈亏差额+446,831」-> 446831；「盈亏差额+94，830」全角逗号 -> 94830）。"""
    m = re.search(r"([+-]?" + _NUM + ")", t or "")
    if not m:
        return None
    return _parse_price(m.group(1))


def _parse_try(s: str) -> float | None:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _extract_red_avg(boxes: list[dict[str, Any]]) -> float | None:
    """从 OCR 文本中提取红品平均格数「格数为X.X」（纯文本提取，不计算均值）。
    遍历所有识别行，取第一个匹配项；未匹配返回 None。
    - 匹配「格数为1.5」-> 1.5；「格数为5」-> 5.0（兼容无小数点）。"""
    for b in boxes:
        m = _RED_AVG_RE.search(b.get("text", "") or "")
        if m:
            return _parse_try(m.group(1))
    return None


# 识别结果 LRU 缓存：同一文件（路径+mtime+大小+缩放档位）不重复 OCR。
# 对局归档/多图合并等场景常对同一张图多次识别，命中后直接返回。
_OCR_CACHE: "OrderedDict[tuple[Any, ...], list[dict[str, Any]]]" = OrderedDict()
_OCR_CACHE_MAX = 64
_OCR_CACHE_LOCK = threading.Lock()


def _ocr_cache_key(path: str, scale: int) -> tuple[Any, ...]:
    try:
        st = os.stat(path)
        return (os.path.abspath(path), st.st_mtime_ns, st.st_size, scale)
    except OSError:
        return (os.path.abspath(path), 0, 0, scale)


def _full_texts(path: str, scale: int = 3) -> list[dict[str, Any]]:
    """整图 OCR：缩放后以内存 ndarray 传给 RapidOCR（无临时文件 IO），结果 LRU 缓存。

    scale=3 时按图长边动态降档（>1600→1、>900→2），控制 OCR 输入尺寸。
    """
    im = Image.open(path).convert("RGB")
    w, h = im.size
    # 动态缩放：大图不放大，小图放大，控制 OCR 输入尺寸在 ~2000px 内
    if scale == 3:
        long_side = max(w, h)
        if long_side > 1600:
            scale = 1
        elif long_side > 900:
            scale = 2
    key = _ocr_cache_key(path, scale)
    with _OCR_CACHE_LOCK:
        cached = _OCR_CACHE.get(key)
    if cached is not None:
        return cached
    if scale != 1:
        im = im.resize((w * scale, h * scale), Image.LANCZOS)
    out = _ocr_run(np.asarray(im))
    for b in out:
        for k in ("cx", "cy", "x0", "y0", "x1", "y1"):
            b[k] = b[k] / scale
    with _OCR_CACHE_LOCK:
        _OCR_CACHE[key] = out
        if len(_OCR_CACHE) > _OCR_CACHE_MAX:
            _OCR_CACHE.popitem(last=False)
    return out


def _nearest_number(boxes: list[dict[str, Any]], kw: dict[str, Any],
                    align: str = "below") -> float | None:
    """找关键词对应的数字：总价值=同行右侧，成交价/收益=同列下方。"""
    best = None
    best_d = 1e18
    for b in boxes:
        if not _is_signed_price(b["text"]):
            continue
        if align == "right":
            if abs(b["cy"] - kw["cy"]) > 40 or b["cx"] < kw["cx"]:
                continue
            d = abs(b["cy"] - kw["cy"]) * 2 + (b["cx"] - kw["cx"])
        else:
            if b["cy"] < kw["cy"] - 20 or abs(b["cx"] - kw["cx"]) > 60:
                continue
            d = abs(b["cx"] - kw["cx"]) * 2 + (b["cy"] - kw["cy"])
        if d < best_d:
            best_d = d
            best = b
    return _parse_price(best["text"]) if best is not None else None


def parse_settlement(boxes: list[dict[str, Any]], rgb: np.ndarray | None = None) -> dict[str, Any]:
    """解析结算区：总价值 / 成交价 / 收益。
    颜色优先：蓝色数字=总价值、黄色数字=成交价（来自 颜色图片 参考），按颜色标签
    辅助定位结算数字；颜色缺失/不确定时回退到位置关联（原逻辑）。"""
    out: dict[str, Any] = {}
    refs = _get_color_refs() if rgb is not None else {}
    # 颜色分类：蓝=总价值候选数字，黄=成交价候选数字
    blue_boxes: list[dict[str, Any]] = []
    yellow_boxes: list[dict[str, Any]] = []
    if rgb is not None:
        for b in boxes:
            if _is_signed_price(b["text"]):
                c = _text_color_of_region(rgb, b, refs)
                if c == "blue":
                    blue_boxes.append(b)
                elif c == "yellow":
                    yellow_boxes.append(b)

    def _nearest_color(cands: list[dict[str, Any]], kw: dict[str, Any], max_d: int = 260) -> float | None:
        """取距关键字最近的同色数字（颜色优先于位置）。"""
        if not cands:
            return None
        best = None; bd = 1e18
        for b in cands:
            d = abs(b["cy"] - kw["cy"]) + abs(b["cx"] - kw["cx"])
            if d < bd:
                bd = d; best = b
        return _parse_price(best["text"]) if bd <= max_d else None

    for b in boxes:
        t = b["text"]
        if "总价值" in t and "total_value" not in out:
            out["total_value"] = (
                _nearest_color(blue_boxes, b)
                or _nearest_number(boxes, b, align="right")
                or _nearest_number(boxes, b, align="below")
            )
        elif "成交价" in t and "deal_price" not in out:
            out["deal_price"] = (
                _nearest_color(yellow_boxes, b)
                or _nearest_number(boxes, b, align="below")
            )
        elif "盈亏" in t and "profit" not in out:
            inline = _inline_number(t)
            if inline is not None:
                out["profit"] = inline
        elif t == "收益" and "profit" not in out:
            out["profit"] = _nearest_number(boxes, b, align="below")
    # 颜色兜底：关键字漏识别时，直接用唯一的蓝/黄数字（取最靠上的，结算区总价值在上）
    if "total_value" not in out and blue_boxes:
        out["total_value"] = _parse_price(min(blue_boxes, key=lambda b: b["cy"])["text"])
    if "deal_price" not in out and yellow_boxes:
        out["deal_price"] = _parse_price(min(yellow_boxes, key=lambda b: b["cy"])["text"])
    return out


def _match_by_name(conn, name: str) -> list[dict[str, Any]]:
    """按名称模糊匹配图鉴（统一实现见 services.matching）。"""
    return matching.match_by_name(conn, name)


def _board_items(conn, boxes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # 结算区锚点：拍得者/总价值/成交价/收益 等结算标签的 y 上界。
    # 玩家昵称（拍得者）与成交信息集中在该区域，不属于藏品名称。
    settle_ys = [
        b["y0"]
        for b in boxes
        if any(k in b["text"] for k in ("拍得者", "总价值", "成交价", "收益", "已揭示", "最终成交"))
    ]
    settle_lo = min(settle_ys) - 20 if settle_ys else None

    # 合并同列上下紧邻的名称片段（如「吉星」+「高照」=「吉星高照」）
    merged: list[dict[str, Any]] = []
    for b in sorted(boxes, key=lambda x: (x["cy"], x["cx"])):
        t = b["text"]
        if len(t) < 2 or b["conf"] < 0.5 or _is_price(t) or _is_signed_price(t) or t in _STOPWORDS:
            continue
        if re.match(r"^[\d\.\-\+%]+$", t):
            continue  # 纯数字/符号碎片（如 47.、5,262K 残留）
        if any(k in t for k in ("总价值", "成交价", "收益", "拍得者", "已揭示", "经过", "成功", "段位", "独白")):
            continue
        # 系统公告横幅（恭喜/运气爆棚/收获百万 等）不是藏品名
        if any(k in t for k in _BANNER_KEYWORDS):
            continue
        # 结算区（拍得者昵称/成交信息）文字不是藏品名
        if settle_lo is not None and b["y0"] >= settle_lo:
            continue
        # 序号前缀剥离：如「1顺意相伴蘑菇汤」→「顺意相伴蘑菇汤」。
        # 数字仅作序号/件数标记，剥离后才是名称本体（此前直接按噪音剔除会漏识别）。
        mnum = re.match(r"^(\d+)([\u4e00-\u9fffA-Za-z].*)$", t)
        if mnum:
            t = mnum.group(2).strip()
            if len(t) < 2 or not _norm_name(t):
                continue
        placed = False
        for m in merged:
            if abs(m["cx"] - b["cx"]) < 30 and 0 < b["cy"] - m["cy"] < 45:
                m["text"] += t
                m["cy"] = b["cy"]
                m["y1"] = b["y1"]
                m["x0"] = min(m["x0"], b["x0"])
                m["x1"] = max(m["x1"], b["x1"])
                placed = True
                break
        # P1-a 水平碎片合并：同一行（y 接近）、x 相邻的框合并为完整名称
        # 如「蓝锥」+「矿晶体」→「蓝锥矿晶体」，此前只做垂直合并导致碎片无法匹配图鉴。
        h_placed = False
        if not placed:
            for m in merged:
                if abs(m["cy"] - b["cy"]) < 25 and 0 < b["cx"] - m["cx"] < 90:
                    m["text"] += t
                    m["x1"] = max(m["x1"], b["x1"])
                    m["y0"] = min(m["y0"], b["y0"])
                    m["y1"] = max(m["y1"], b["y1"])
                    h_placed = True
                    break
        if not placed and not h_placed:
            merged.append({
                "text": t, "cx": b["cx"], "cy": b["cy"], "conf": b["conf"],
                "x0": b["x0"], "y0": b["y0"], "x1": b["x1"], "y1": b["y1"],
            })
    items: list[dict[str, Any]] = []
    for b in sorted(merged, key=lambda x: (x["cy"], x["cx"])):
        t = b["text"]
        nn = _norm_name(t)
        if not nn:
            continue
        cx = (b["x0"] + b["x1"]) / 2
        # 去重策略：同一名称的重复框（OCR 碎片/重复识别）仅当其与已保留框
        # 位置重叠、或水平距离很近（同一格内）时才剔除；同名但位置不同的藏品
        # （如结算图里同一件藏品拍得两件）必须分别保留，不能按名称合并。
        dup = False
        for it in items:
            ib = it["name_box"]
            if _norm_name(it["name"]) != nn:
                continue
            icx = (ib["x0"] + ib["x1"]) / 2
            ix = min(b["x1"], ib["x1"]) - max(b["x0"], ib["x0"])
            iy = min(b["y1"], ib["y1"]) - max(b["y0"], ib["y0"])
            if (ix > 8 and iy > 8) or abs(cx - icx) < 90:
                dup = True
                break
        if dup:
            continue
        matches = _match_by_name(conn, t)
        # 低置信且图鉴无法匹配的文字框（玩家昵称/OCR 碎片）直接丢弃
        if not matches and b["conf"] < 0.6:
            continue
        items.append({
            "name": t,
            "price": matches[0]["value"] if matches else 0,
            "grid_cells": matches[0]["grid_cells"] if matches else 0,
            "matches": matches,
            "matched": bool(matches),
            "name_box": {k: b[k] for k in ("x0", "y0", "x1", "y1")},
        })
    return items


def _red_cell_ratio(rgb: np.ndarray, name_box: dict[str, Any], refs: dict | None = None) -> float:
    """红品格子背景占比：红品所在的格子（图标+名称）背景为深红/绛红。
    颜色范围取自 颜色图片/红品背景图 的 HSV 范围（替代原硬编码 RGB 阈值），
    检测区域由名称框正上方 0.6h 扩大到整格（图标+背景，与视觉裁剪同范围），
    提升对偏色/小检测区红格的召回。"""
    if refs is None:
        refs = _get_color_refs()
    x0 = int(name_box.get("x0", 0))
    y0 = int(name_box.get("y0", 0))
    x1 = int(name_box.get("x1", 0))
    y1 = int(name_box.get("y1", 0))
    h = max(y1 - y0, 10)
    H, W = rgb.shape[:2]
    cx = (x0 + x1) / 2
    # 检测区域：名称框上方红背景带（较原 0.6h 适度扩大到 1.0h，横向 0.9h->1.2h），
    # 仍聚焦红背景带、避开图标中心，避免整格区域稀释红占比导致漏判。
    rx0 = max(0, int(cx - 1.2 * h))
    rx1 = min(W, int(cx + 1.2 * h))
    ry0 = max(0, int(y0 - 1.0 * h))
    ry1 = min(H, int(y0))
    if ry1 <= ry0 or rx1 <= rx0:
        return 0.0
    reg = rgb[ry0:ry1, rx0:rx1].astype(np.uint8)
    hsv = cv2.cvtColor(reg, cv2.COLOR_RGB2HSV)
    Hh = hsv[..., 0].astype(int); S = hsv[..., 1].astype(int); V = hsv[..., 2].astype(int)
    red = refs.get("red") if refs else None
    if red:
        s_min = max(50, red["s"] - red["s_margin"])
        v_min = max(35, red["v"] - red["v_margin"])
        hb = red.get("h_band", 14)
        # 红 Hue 在 0/180 附近回绕；红背景偏暗（排除高亮红图标/红字干扰）
        m = (S >= s_min) & (V >= v_min) & ((Hh <= hb) | (Hh >= 180 - hb))
    else:
        # 回退：原硬编码 RGB 阈值
        r = reg[..., 0]; g = reg[..., 1]; b = reg[..., 2]
        m = (
            (r - g >= 15) & (r - b >= 15)
            & (r >= 55) & (r <= 150)
            & (g >= 28) & (g <= 85)
            & (b >= 28) & (b <= 75)
        )
    return float(m.mean())


def process_auction_dir(conn, folder: Path) -> dict[str, Any]:
    settlement: dict[str, Any] = {}
    items: list[dict[str, Any]] = []
    board_img: Path | None = None
    imgs = sorted(
        f for f in folder.glob("*")
        if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".bmp")
    )

    def _ocr_one(p: Path) -> tuple[Path, list[dict[str, Any]] | None]:
        try:
            return p, _full_texts(str(p))
        except Exception:  # noqa: BLE001
            return p, None

    # 多图并行 OCR（GPU/CPU 下线程池独立推理），按原顺序合并结果
    _SETTLE_KW = ("总价值", "成交价", "收益", "盈亏")
    with ThreadPoolExecutor(max_workers=min(4, max(1, len(imgs)))) as ex:
        for img, boxes in ex.map(_ocr_one, imgs):
            if boxes is None:
                continue
            # 结算图：有关键词则加载 rgb 做颜色辅助（蓝=总价值/黄=成交价）
            rgb = None
            if any(any(k in b["text"] for k in _SETTLE_KW) for b in boxes):
                try:
                    rgb = np.asarray(Image.open(img).convert("RGB")).astype(int)
                except Exception:
                    rgb = None
            s = parse_settlement(boxes, rgb)
            if any(v is not None for v in s.values()):
                for k, v in s.items():
                    if v is not None:
                        settlement[k] = v
            elif board_img is None:
                board_img = img
                items = _board_items(conn, boxes)
    from . import vision

    crops_dir = DATA_DIR / "auction_crops" / folder.name
    crops_dir.mkdir(parents=True, exist_ok=True)
    for i, it in enumerate(items):
        nb = it.get("name_box") or {}
        if not nb or board_img is None:
            continue
        pil = Image.open(board_img)
        # 图标通常在名字上方（卡片式布局）
        h = max(nb["y1"] - nb["y0"], 12)
        cx = (nb["x0"] + nb["x1"]) / 2
        x0 = max(0, int(cx - 1.6 * h))
        x1 = min(pil.width, int(cx + 1.6 * h))
        y0 = max(0, int(nb["y0"] - 3.0 * h))
        y1 = min(pil.height, int(nb["y0"]))
        crop = pil.crop((x0, y0, x1, y1))
        cp = crops_dir / f"{i}.png"
        crop.save(cp)
        it["crop_path"] = str(cp)
        try:
            v = vision.match_crop(cp, topk=3)
            it["visual"] = v.get("matches", [])
        except Exception:  # noqa: BLE001
            it["visual"] = []
    return {
        "settlement": settlement,
        "items": items,
        "red_count": len(items),
        "total_cells": sum(it["grid_cells"] for it in items),
    }


def scan_auction_folder() -> dict[str, Any]:
    now = datetime.now().isoformat(timespec="seconds")
    added = 0
    if not AUCTION_DIR.exists():
        return {"added": 0}
    with db() as conn:
        existing = {
            r["path"]: r["id"] for r in conn.execute(
                "SELECT id, path, status FROM ocr_tasks WHERE kind='auction'"
            ).fetchall()
        }
        for folder in sorted(AUCTION_DIR.iterdir()):
            if not folder.is_dir() or folder.name == "已处理":
                continue
            imgs = [f for f in folder.iterdir()
                    if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".bmp")]
            if not imgs:
                continue
            key = str(folder)
            task_id = existing.get(key)
            if task_id is not None:
                with db() as conn2:
                    st = conn2.execute(
                        "SELECT status FROM ocr_tasks WHERE id=?", (task_id,)
                    ).fetchone()["status"]
                if st != "failed":
                    continue
            try:
                result = process_auction_dir(conn, folder)
                status = "pending"
            except Exception as e:  # noqa: BLE001
                result = {"error": str(e)}
                status = "failed"
            if task_id is None:
                conn.execute(
                    """INSERT INTO ocr_tasks(path, kind, shape, status, result_json, created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?)""",
                    (key, "auction", "对局", status, json_dumps(result), now, now),
                )
            else:
                conn.execute(
                    "UPDATE ocr_tasks SET status=?, result_json=?, updated_at=? WHERE id=?",
                    (status, json_dumps(result), now, task_id),
                )
            added += 1
    return {"added": added}


def _cluster_x(centers: list[float], img_w: int) -> list[list[int]]:
    """按 x 中心一维聚类成列（自适应间距阈值）。"""
    idx = sorted(range(len(centers)), key=lambda i: centers[i])
    cols: list[list[int]] = []
    gap = max(60.0, img_w * 0.12)
    for i in idx:
        if not cols or centers[i] - centers[cols[-1][-1]] > gap:
            cols.append([i])
        else:
            cols[-1].append(i)
    return cols


def _ocr_texts(path: str) -> list[dict[str, Any]]:
    """单图 OCR（不缩放），走 _full_texts 的内存传递与识别缓存。"""
    return _full_texts(path, scale=1)


def _pair_items(boxes: list[dict[str, Any]], img_w: int, img_h: int) -> list[dict[str, Any]]:
    """把 OCR 文本按列分组后配对名称与价格；列内配不上的用全局「下方最近价格」兜底。"""
    cols = _cluster_x([b["cx"] for b in boxes], img_w)
    items: list[dict[str, Any]] = []
    used: set[int] = set()
    unpaired_names: list[int] = []
    unpaired_prices: list[int] = []
    for col in cols:
        col_idx = sorted(col, key=lambda i: boxes[i]["cy"])
        pending: int | None = None
        for i in col_idx:
            b = boxes[i]
            if _is_price(b["text"]):
                if pending is not None:
                    items.append(_mk_item(boxes, pending, i))
                    used.add(pending)
                    used.add(i)
                    pending = None
                else:
                    unpaired_prices.append(i)
            else:
                if pending is not None:
                    unpaired_names.append(pending)
                pending = i
        if pending is not None:
            unpaired_names.append(pending)
    # 全局兜底：未配对的名称 -> 其下方最近的未配对价格
    for ni in sorted(unpaired_names, key=lambda i: boxes[i]["cy"]):
        if ni in used:
            continue
        cands = [
            pi for pi in unpaired_prices
            if pi not in used and boxes[pi]["cy"] > boxes[ni]["cy"]
        ]
        if cands:
            pi = min(cands, key=lambda j: boxes[j]["cy"] - boxes[ni]["cy"])
            items.append(_mk_item(boxes, ni, pi))
            used.add(ni)
            used.add(pi)
    return items


def _mk_item(boxes: list[dict[str, Any]], name_i: int, price_i: int) -> dict[str, Any]:
    return {
        "name": boxes[name_i]["text"],
        "price": _parse_price(boxes[price_i]["text"]),
        "y": boxes[name_i]["cy"],
        "name_conf": boxes[name_i]["conf"],
        "name_box": {k: boxes[name_i][k] for k in ("x0", "y0", "x1", "y1")},
        "price_box": {k: boxes[price_i][k] for k in ("x0", "y0", "x1", "y1")},
    }


def _build_alias_map(conn) -> dict[str, str]:
    """历史对局里的「游戏显示名/对应文档名 -> 图鉴名」别名映射（统一实现见 services.matching）。"""
    return matching._build_alias_map(conn)


def _match_catalog(conn, name: str, price: float, cells: int) -> list[dict[str, Any]]:
    """名称 + 格数 + 价格三重匹配图鉴（统一实现见 services.matching）。"""
    return matching.match_catalog(conn, name, price, cells)


def process_image(conn, path: Path, shape: tuple[int, int]) -> dict[str, Any]:
    im = Image.open(path)
    img_w, img_h = im.size
    boxes = []
    for attempt in range(3):
        try:
            boxes = _ocr_texts(str(path))
            break
        except Exception:  # noqa: BLE001
            if attempt == 2:
                raise
            time.sleep(1.0)
    items = _pair_items(boxes, img_w, img_h)
    cells = shape[0] * shape[1]
    out_items = []
    for it in items:
        matches = _match_catalog(conn, it["name"], it["price"], cells)
        out_items.append({
            "name": it["name"],
            "price": it["price"],
            "grid_cells": cells,
            "name_box": it.get("name_box"),
            "price_box": it.get("price_box"),
            "matches": matches,
            "matched": bool(matches),
            "matched_by_price": bool(matches) and bool(matches[0].get("by_price")),
            "price_mismatch": bool(matches) and not matches[0].get("price_ok"),
            "price_suspect": it["price"] < 50000,
            "name_conf": round(it["name_conf"], 2),
        })
    return {"items": out_items, "image_size": [img_w, img_h]}


def process_capture(conn, image_path: str) -> dict[str, Any]:
    """对一张截图（游戏窗口/剪贴板）直接做识别：OCR 名称+价格 -> 图鉴匹配 -> 生成待确认任务。
    不知道格子数，匹配时不施加格数惩罚（cells=0）。"""
    from pathlib import Path

    p = Path(image_path)
    if not p.exists():
        return {"ok": False, "error": "图片不存在"}
    im = Image.open(p)
    img_w, img_h = im.size
    boxes = _ocr_texts(str(p))
    items = _pair_items(boxes, img_w, img_h)
    out_items = []
    for it in items:
        matches = _match_catalog(conn, it["name"], it["price"], 0)
        out_items.append({
            "name": it["name"],
            "price": it["price"],
            "grid_cells": matches[0]["grid_cells"] if matches else 0,
            "name_box": it.get("name_box"),
            "price_box": it.get("price_box"),
            "matches": matches,
            "matched": bool(matches),
            "price_suspect": it["price"] < 50000,
            "name_conf": round(it["name_conf"], 2),
        })
    now = datetime.now().isoformat(timespec="seconds")
    cur = conn.execute(
        """INSERT INTO ocr_tasks(path, kind, shape, status, result_json, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?)""",
        (str(p), "grid", "自动截图", "pending",
         json_dumps({"items": out_items, "image_size": [img_w, img_h]}), now, now),
    )
    return {"ok": True, "task_id": cur.lastrowid, "items": len(out_items)}


def recognize_single(conn, image_path: str) -> dict[str, Any]:
    """单图识别：一张截图 -> 每件红品（名称/格数/价值/视觉候选）+ 成交价/总价值。"""
    from pathlib import Path

    p = Path(image_path)
    if not p.exists():
        return {"ok": False, "error": "图片不存在"}
    boxes = _full_texts(str(p))
    red_avg = _extract_red_avg(boxes)
    pil = Image.open(p)
    rgb = np.asarray(pil.convert("RGB")).astype(int)
    H, W, _ = rgb.shape
    settlement = parse_settlement(boxes, rgb)
    items = _board_items(conn, boxes)
    crops_dir = DATA_DIR / "auction_crops" / "single"
    crops_dir.mkdir(parents=True, exist_ok=True)
    VISUAL_THRESHOLD = 0.80  # P1-b：0.85→0.80，视觉高置信即可确认图鉴藏品
    for i, it in enumerate(items):
        nb = it.get("name_box") or {}
        red_ratio = _red_cell_ratio(rgb, nb) if nb else 0.0
        it["red_ratio"] = round(red_ratio, 3)
        if nb:
            h = max(nb["y1"] - nb["y0"], 12)
            cx = (nb["x0"] + nb["x1"]) / 2
            x0 = max(0, int(cx - 1.6 * h))
            x1 = min(pil.width, int(cx + 1.6 * h))
            y0 = max(0, int(nb["y0"] - 3.0 * h))
            y1 = min(pil.height, int(nb["y0"]))
            crop = pil.crop((x0, y0, x1, y1))
            # 多图并行时避免各线程覆盖同名裁剪文件：用图名前缀区分
            cp = crops_dir / f"{p.stem}_{i}.png"
            crop.save(cp)
            it["crop_path"] = str(cp)
            try:
                from . import vision
                all_v = vision.match_crop(cp, topk=5).get("matches", [])
                high = [x for x in all_v if x["score"] >= VISUAL_THRESHOLD]
                it["visual"] = high[:1]
                # P1-b 视觉补名：OCR 碎片未能匹配图鉴时，用高置信视觉候选的
                # 图鉴标准名/格数/价值覆盖，避免碎片名导致红品被漏判。
                if high and not it.get("matched"):
                    v = high[0]
                    m2 = _match_by_name(conn, v["name"])
                    if m2:
                        it["name"] = m2[0]["name"]
                        it["matches"] = m2
                        it["matched"] = True
                        it["price"] = m2[0].get("value") or it.get("price")
                        it["grid_cells"] = m2[0]["grid_cells"] or it.get("grid_cells")
                        it["visual_source_cells"] = True
                # 名称未匹配上图鉴时，用高置信视觉结果补格数/价值
                if not it.get("grid_cells") and high:
                    it["grid_cells"] = high[0]["grid_cells"]
                    it["visual_source_cells"] = True
            except Exception:  # noqa: BLE001
                it["visual"] = []
        else:
            it["visual"] = []
        # 红品判定：红色格子背景 + 名称能对上图鉴（或高置信视觉匹配），
        # 排除 OCR 碎片（如单字「国」、符号残留「47.」）误报为红品。
        # P1-b 视觉高置信（≥0.80）且已确认图鉴藏品时，红品判定阈值放宽到 0.15
        # （视觉已确认是图鉴藏品，红格子检测区域小/颜色偏时不再因 red_ratio 卡掉）。
        visual_high = bool(it.get("visual")) and (it["visual"][0].get("score") or 0) >= 0.80
        red_thr = 0.15 if (it.get("matched") and visual_high) else 0.30
        it["is_red"] = red_ratio >= red_thr and (it.get("matched") or bool(it.get("visual")))
    red_items = [it for it in items if it.get("is_red")]
    red_count = len(red_items)
    total_cells = sum(int(it.get("grid_cells") or 0) for it in red_items)
    red_value = sum(
        float(it["matches"][0]["value"]) if it.get("matches") else float(it.get("price") or 0)
        for it in red_items
    )
    # 需求3：识别完成即自动计算盈亏（总价值 - 成交价），无需等一键归档。
    # 若结算区已自带收益文本则保留；否则用总价值/成交价推导。
    tv = settlement.get("total_value")
    dp = settlement.get("deal_price")
    if tv is not None and dp is not None and settlement.get("profit") is None:
        try:
            settlement["profit"] = round(float(tv) - float(dp), 0)
        except (TypeError, ValueError):
            pass
    return {
        "ok": True,
        "settlement": settlement,
        "items": items,
        "red_count": red_count,
        "total_cells": total_cells,
        "red_value": round(red_value, 0),
        "red_avg": red_avg,
    }


def recognize_multi(conn, image_paths: list[str]) -> dict[str, Any]:
    """多图合并识别：对局图与结算图可能分开存放。
    每张图独立走 recognize_single，藏品并集去重、结算字段跨图合并，
    输出统一的 红品件数/格数/价值/成交价/总价值。"""
    if not image_paths:
        return {"ok": False, "error": "未提供图片"}
    # 多图并行识别（GPU 下每张图独立推理，线程池加速）
    def _run(p: str) -> dict[str, Any]:
        try:
            # SQLite 连接不可跨线程：每张图用独立连接
            with db() as tconn:
                return recognize_single(tconn, p)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    with ThreadPoolExecutor(max_workers=min(4, max(1, len(image_paths)))) as ex:
        results = list(ex.map(_run, image_paths))
    per_image: list[dict[str, Any]] = []
    merged_items: list[dict[str, Any]] = []
    settlement: dict[str, Any] = {}
    errors: list[str] = []
    red_avg: float | None = None
    for p, r in zip(image_paths, results):
        if not r.get("ok"):
            errors.append(f"{Path(p).name}: {r.get('error', '识别失败')}")
            continue
        if red_avg is None and r.get("red_avg") is not None:
            red_avg = r["red_avg"]
        per_image.append({
            "path": p,
            "name": Path(p).name,
            "settlement": r.get("settlement") or {},
            "items": r.get("items") or [],
            "red_count": r.get("red_count", 0),
            "total_cells": r.get("total_cells", 0),
            "red_value": r.get("red_value", 0),
        })
        for k, v in (r.get("settlement") or {}).items():
            if v is not None and settlement.get(k) is None:
                settlement[k] = v
        for it in r.get("items") or []:
            if not it.get("is_red"):
                continue
            src = Path(p).name
            it = dict(it)
            it["source_image"] = src
            # 保留所有红品实例，不做跨图按名称去重：
            # 同名但来自不同截图（不同位置/不同对局）的藏品应分别计为一件。
            # 图内 OCR 碎片去重已在 _board_items 内按位置重叠处理。
            merged_items.append(it)
    red_count = len(merged_items)
    total_cells = sum(int(it.get("grid_cells") or 0) for it in merged_items)
    red_value = sum(
        float(it["matches"][0]["value"]) if it.get("matches") else float(it.get("price") or 0)
        for it in merged_items
    )
    return {
        "ok": True,
        "settlement": settlement,
        "items": merged_items,
        "per_image": per_image,
        "red_count": red_count,
        "total_cells": total_cells,
        "red_value": round(red_value, 0),
        "red_avg": red_avg,
        "errors": errors,
        "image_count": len(per_image),
    }


def save_multi_record(conn, image_paths: list[str]) -> dict[str, Any]:
    """多图（分割图）识别后直接保存为一条历史对局记录，供模型训练。
    保存字段与估值引擎/训练端对齐：
      - items_json: 每件红品 name / grid_cells / trade_price（交易行价，引擎读取 trade_price）
      - red_count / red_grids / red_avg / red_value / full_value / deal_price / profit
    红品并集去重、结算字段跨图合并。"""
    res = recognize_multi(conn, image_paths)
    if not res.get("ok"):
        return res
    items = res.get("items") or []
    settlement = res.get("settlement") or {}
    now = datetime.now().isoformat(timespec="seconds")
    game_no = conn.execute(
        "SELECT COALESCE(MAX(game_no),0)+1 m FROM game_records"
    ).fetchone()["m"]
    red_count = len(items)
    cells_list = [int(it.get("grid_cells") or 0) for it in items]
    red_grids = sum(cells_list)
    red_avg = _trunc1(red_grids / red_count) if red_count else None
    combo = "+".join(str(c) for c in sorted(cells_list)) if cells_list else None
    def _item_price(it: dict[str, Any]) -> float:
        """红品价值：优先交易行价(current_value)，否则系统价(value)。"""
        m = (it.get("matches") or [{}])[0]
        return float(m.get("current_value") or m.get("value") or it.get("price") or 0)

    red_value = round(sum(_item_price(it) for it in items), 0)
    full_value = settlement.get("total_value")
    deal_price = settlement.get("deal_price")
    profit = settlement.get("profit")
    saved_items = [{
        "name": it.get("name"),
        "grid_cells": it.get("grid_cells"),
        "trade_price": _item_price(it),
        "source_image": it.get("source_image"),
    } for it in items]
    conn.execute(
        """INSERT INTO game_records
           (game_no, grid_combo, red_count, red_grids, red_avg, red_value,
            full_value, deal_price, profit, items_json, profit_ok)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (game_no, combo, red_count if red_count else None, red_grids or None,
         red_avg, red_value or None, full_value, deal_price, profit,
         json_dumps(saved_items),
         _check_profit_ok(full_value, deal_price, profit)),
    )
    cache.invalidate_games()   # 新增对局记录
    return {
        **res,
        "game_no": game_no,
        "saved": True,
        "saved_at": now,
        "saved_items": saved_items,
        "profit_ok": _check_profit_ok(full_value, deal_price, profit),
    }


def _iter_images() -> list[Path]:
    if not SCAN_DIR.exists():
        return []
    skip = {OCR_PROCESSED_DIR.name, OCR_FAILED_DIR.name}
    return [
        p for p in SCAN_DIR.rglob("*")
        if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".bmp", ".webp"}
        and not any(part in skip for part in p.parts)
    ]


def scan_folder() -> dict[str, Any]:
    now = datetime.now().isoformat(timespec="seconds")
    added = 0
    failed = 0
    with db() as conn:
        existing = {
            r["path"]: r["id"] for r in conn.execute(
                "SELECT id, path, status FROM ocr_tasks"
            ).fetchall()
        }
        for path in _iter_images():
            task_id = existing.get(str(path))
            folder = path.parent.name
            if task_id is not None:
                with db() as conn2:
                    st = conn2.execute(
                        "SELECT status FROM ocr_tasks WHERE id=?", (task_id,)
                    ).fetchone()["status"]
                if st != "failed":
                    continue
            shape = parse_shape(folder)
            if shape is None:
                continue
            try:
                result = process_image(conn, path, shape)
                status = "pending"
            except Exception as e:  # noqa: BLE001
                result = {"error": str(e)}
                status = "failed"
                failed += 1
            if task_id is None:
                conn.execute(
                    """INSERT INTO ocr_tasks(path, kind, shape, status, result_json, created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?)""",
                    (str(path), "grid", f"{shape[0]}×{shape[1]}", status, json_dumps(result), now, now),
                )
            else:
                conn.execute(
                    "UPDATE ocr_tasks SET status=?, result_json=?, updated_at=? WHERE id=?",
                    (status, json_dumps(result), now, task_id),
                )
            added += 1
    return {"added": added, "failed": failed, "total": added + failed}


def list_tasks() -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM ocr_tasks ORDER BY id DESC"
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["result"] = json.loads(d.pop("result_json") or "{}")
        out.append(d)
    return out


def confirm_task(task_id: int, items: list[dict[str, Any]],
                 settlement: dict[str, Any] | None = None) -> dict[str, Any]:
    """确认识别结果：价格以图像识别为准——
    图鉴中已有同名条目则覆盖原价（现价按 ×1.15 同步），否则按原价新增；
    标记任务完成并归档图片。"""
    now = datetime.now().isoformat(timespec="seconds")
    added = 0
    updated = 0
    settlement = settlement or {}
    with db() as conn:
        row = conn.execute("SELECT * FROM ocr_tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            return {"ok": False, "error": "任务不存在"}
        if row["status"] == "confirmed":
            return {"ok": False, "error": "该任务已确认"}
        if row["kind"] == "auction":
            game_no = conn.execute(
                "SELECT COALESCE(MAX(game_no),0)+1 m FROM game_records"
            ).fetchone()["m"]
            red_count = len(items)
            cells_list = [int(it.get("grid_cells") or 0) for it in items]
            red_grids = sum(cells_list)
            red_avg = _trunc1(red_grids / red_count) if red_count else None
            combo = "+".join(str(c) for c in sorted(cells_list)) if cells_list else None
            red_value = round(sum(float(it.get("price") or 0) for it in items), 0)
            full_value = settlement.get("total_value")
            deal_price = settlement.get("deal_price")
            profit = settlement.get("profit")
            conn.execute(
                """INSERT INTO game_records
                   (game_no, grid_combo, red_count, red_grids, red_avg, red_value,
                    full_value, deal_price, profit, items_json)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (game_no, combo, red_count if red_count else None, red_grids or None,
                 red_avg, red_value or None, full_value, deal_price, profit, json_dumps(items)),
            )
            for it in items:
                conn.execute(
                    """INSERT INTO ocr_samples(task_id, name, grid_cells, price, matched_name, created_at)
                       VALUES (?,?,?,?,?,?)""",
                    (task_id, it.get("name"), int(it.get("grid_cells") or 0),
                     float(it.get("price") or 0), "", now),
                )
                if it.get("crop_path") and Path(it["crop_path"]).exists():
                    from . import vision
                    vision.add_crop(
                        it.get("name") or "", int(it.get("grid_cells") or 0),
                        Image.open(it["crop_path"]),
                    )
            conn.execute(
                "UPDATE ocr_tasks SET status='confirmed', updated_at=? WHERE id=?",
                (now, task_id),
            )
            _archive_auction(row["path"], task_id)
            cache.invalidate_games()   # 新增了对局记录，件数先验/倍率/别名映射失效
            return {"ok": True, "game_no": game_no}
        for it in items:
            name = (it.get("name") or "").strip()
            if not name:
                continue
            price = it.get("price")
            if not price or price <= 0:
                continue
            cells = int(it.get("grid_cells") or 0)
            exists = conn.execute(
                "SELECT id, value, current_value FROM catalog_items WHERE name=?", (name,)
            ).fetchone()
            if exists is not None:
                conn.execute(
                    """UPDATE catalog_items
                       SET value=?, current_value=? WHERE id=?""",
                    (float(price), round(float(price) * 1.15, 0), exists["id"]),
                )
                updated += 1
                matched = name
            else:
                conn.execute(
                    """INSERT INTO catalog_items(name, grid_cells, value, current_value, source)
                       VALUES (?,?,?,NULL,'ocr')""",
                    (name, cells, float(price)),
                )
                matched = ""
                added += 1
            conn.execute(
                """INSERT INTO ocr_samples(task_id, name, grid_cells, price, matched_name, created_at)
                   VALUES (?,?,?,?,?,?)""",
                (task_id, name, cells, float(price), matched, now),
            )
        conn.execute(
            "UPDATE ocr_tasks SET status='confirmed', updated_at=? WHERE id=?",
            (now, task_id),
        )
    # 归档图片到 已处理\<shape>\
    try:
        src = Path(row["path"])
        if src.exists():
            dest_dir = OCR_PROCESSED_DIR / row["shape"] if row["shape"] else OCR_PROCESSED_DIR
            dest_dir.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dest_dir / src.name))
    except Exception:  # noqa: BLE001
        pass
    cache.invalidate_catalog()   # 新增/覆盖了图鉴条目，图鉴行与统计缓存失效
    return {"ok": True, "added_catalog": added, "updated_catalog": updated}


def _archive_auction(folder_path: str, task_id: int) -> None:
    from .config import AUCTION_DONE_DIR

    try:
        src = Path(folder_path)
        if not src.is_dir():
            return
        dest = AUCTION_DONE_DIR / str(task_id)
        dest.mkdir(parents=True, exist_ok=True)
        for f in src.iterdir():
            if f.is_file():
                shutil.move(str(f), str(dest / f.name))
    except Exception:  # noqa: BLE001
        pass


def delete_task(task_id: int) -> dict[str, Any]:
    with db() as conn:
        conn.execute("DELETE FROM ocr_tasks WHERE id=?", (task_id,))
    return {"ok": True}


def clear_pending_tasks() -> dict[str, Any]:
    """清空全部待确认 OCR 任务（含其关联样本）。

    待确认任务 = status='pending'（未确认的识别结果）；
    已确认（confirmed）任务记录保留，不影响图库。
    """
    with db() as conn:
        ids = [
            r["id"]
            for r in conn.execute("SELECT id FROM ocr_tasks WHERE status='pending'").fetchall()
        ]
        if ids:
            marks = ",".join("?" for _ in ids)
            conn.execute(f"DELETE FROM ocr_samples WHERE task_id IN ({marks})", ids)
            conn.execute(f"DELETE FROM ocr_tasks WHERE id IN ({marks})", ids)
    return {"ok": True, "cleared": len(ids)}
