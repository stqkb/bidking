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
from rapidocr_onnxruntime import RapidOCR

from .config import AUCTION_DIR, OCR_FAILED_DIR, OCR_PROCESSED_DIR, SCAN_DIR
from .core import cache
from .core.norm import norm_name as _norm_name
from .db import db, json_dumps
from .services import matching

from .config import DATA_DIR

_ocr: RapidOCR | None = None

# GPU OCR：若安装了 onnxruntime-gpu，把 torch 自带的 CUDA 12 DLL 目录加入搜索路径，
# 使 RapidOCR 能实际使用 CUDAExecutionProvider（无 GPU 时自动回退 CPU）。
if os.environ.get("BIDKING_OCR_CPU") != "1":
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


def get_ocr() -> RapidOCR:
    global _ocr
    if _ocr is None:
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


def _is_price(t: str) -> bool:
    return bool(re.fullmatch(r"[\d,]+(?:\.\d+)?", t.strip()))


def _is_signed_price(t: str) -> bool:
    return bool(re.fullmatch(r"[+-]?[\d,]+(?:\.\d+)?", t.strip()))


def _parse_price(t: str) -> float:
    return float(t.replace(",", "").replace("+", ""))


def _trunc1(x: float) -> float:
    """截断到 1 位小数（不四舍五入），与游戏显示规则一致。"""
    return math.floor(x * 10) / 10


def _inline_number(t: str) -> float | None:
    """从文本内提取数字（如「盈亏差额+446,831」-> 446831；「-92,319」-> -92319）。"""
    m = re.search(r"([+-]?[\d,]+(?:\.\d+)?)", t or "")
    if not m:
        return None
    return _parse_price(m.group(1))


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


def parse_settlement(boxes: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for b in boxes:
        t = b["text"]
        if "总价值" in t and "总价值" not in out:
            out["total_value"] = (
                _nearest_number(boxes, b, align="right")
                or _nearest_number(boxes, b, align="below")
            )
        elif "成交价" in t and "deal_price" not in out:
            out["deal_price"] = _nearest_number(boxes, b, align="below")
        elif "盈亏" in t and "profit" not in out:
            inline = _inline_number(t)
            if inline is not None:
                out["profit"] = inline
        elif t == "收益" and "profit" not in out:
            out["profit"] = _nearest_number(boxes, b, align="below")
    return out


def _match_by_name(conn, name: str) -> list[dict[str, Any]]:
    """按名称模糊匹配图鉴（统一实现见 services.matching）。"""
    return matching.match_by_name(conn, name)


def _board_items(conn, boxes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # 合并同列上下紧邻的名称片段（如「吉星」+「高照」=「吉星高照」）
    merged: list[dict[str, Any]] = []
    for b in sorted(boxes, key=lambda x: (x["cy"], x["cx"])):
        t = b["text"]
        if len(t) < 2 or b["conf"] < 0.5 or _is_price(t) or _is_signed_price(t) or t in _STOPWORDS:
            continue
        if re.match(r"^[\d\.\-\+%]+$", t):
            continue  # 纯数字/符号碎片（如 47.、5,262K 残留）
        if re.match(r"^\d+[\u4e00-\u9fffA-Za-z]", t):
            continue  # 序号+名称碎片（如 1德莱）属于噪音
        if any(k in t for k in ("总价值", "成交价", "收益", "拍得者", "已揭示", "经过", "成功", "段位", "独白")):
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
        if not placed:
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
        items.append({
            "name": t,
            "price": matches[0]["value"] if matches else 0,
            "grid_cells": matches[0]["grid_cells"] if matches else 0,
            "matches": matches,
            "matched": bool(matches),
            "name_box": {k: b[k] for k in ("x0", "y0", "x1", "y1")},
        })
    return items


def _red_cell_ratio(rgb: np.ndarray, name_box: dict[str, Any]) -> float:
    """红品格子背景占比：红品所在的格子除藏品图标外背景为深红/绛红。
    取名称框正上方一小段（格子底部背景带）统计深红像素比例，
    与白/绿/蓝/紫/金格子的背景区分开。"""
    x0 = int(name_box.get("x0", 0))
    y0 = int(name_box.get("y0", 0))
    x1 = int(name_box.get("x1", 0))
    y1 = int(name_box.get("y1", 0))
    h = max(y1 - y0, 10)
    H, W = rgb.shape[:2]
    rx0 = max(0, x0 - int(0.9 * h))
    rx1 = min(W, x1 + int(0.9 * h))
    ry0 = max(0, y0 - int(0.6 * h))
    ry1 = min(H, y0)
    if ry1 <= ry0 or rx1 <= rx0:
        return 0.0
    reg = rgb[ry0:ry1, rx0:rx1].astype(int)
    r = reg[..., 0]
    g = reg[..., 1]
    b = reg[..., 2]
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
    with ThreadPoolExecutor(max_workers=min(4, max(1, len(imgs)))) as ex:
        for img, boxes in ex.map(_ocr_one, imgs):
            if boxes is None:
                continue
            s = parse_settlement(boxes)
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
    settlement = parse_settlement(boxes)
    items = _board_items(conn, boxes)
    pil = Image.open(p)
    rgb = np.asarray(pil.convert("RGB")).astype(int)
    H, W, _ = rgb.shape
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    crops_dir = DATA_DIR / "auction_crops" / "single"
    crops_dir.mkdir(parents=True, exist_ok=True)
    VISUAL_THRESHOLD = 0.85
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
        it["is_red"] = red_ratio >= 0.30 and (it.get("matched") or bool(it.get("visual")))
    red_items = [it for it in items if it.get("is_red")]
    red_count = len(red_items)
    total_cells = sum(int(it.get("grid_cells") or 0) for it in red_items)
    red_value = sum(
        float(it["matches"][0]["value"]) if it.get("matches") else float(it.get("price") or 0)
        for it in red_items
    )
    return {
        "ok": True,
        "settlement": settlement,
        "items": items,
        "red_count": red_count,
        "total_cells": total_cells,
        "red_value": round(red_value, 0),
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
    seen_names: dict[str, str] = {}   # 名称 -> 首次出现的来源图
    errors: list[str] = []
    for p, r in zip(image_paths, results):
        if not r.get("ok"):
            errors.append(f"{Path(p).name}: {r.get('error', '识别失败')}")
            continue
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
            key = _norm_name(it.get("name") or "")
            if not key:
                continue
            src = Path(p).name
            # 仅跨图同名合并（对局图+结算图多为同一件藏品）；
            # 同一张图内的同名藏品（拍得两件相同藏品）分别保留。
            if key in seen_names and seen_names[key] != src:
                continue
            seen_names.setdefault(key, src)
            it = dict(it)
            it["source_image"] = src
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
            full_value, deal_price, profit, items_json)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (game_no, combo, red_count if red_count else None, red_grids or None,
         red_avg, red_value or None, full_value, deal_price, profit,
         json_dumps(saved_items)),
    )
    cache.invalidate_games()   # 新增对局记录
    return {
        **res,
        "game_no": game_no,
        "saved": True,
        "saved_at": now,
        "saved_items": saved_items,
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
