"""视觉识别：ResNet50 特征 + 余弦相似度 + 模板稳定化 + 增广图库。

2026-08 升级（对接文档 v2）：
- 特征从像素级（灰度/HSV/边缘）换为 torchvision ResNet50 avgpool 特征（2048 维，L2 归一化，余弦相似度）
- 图库条目带 source 字段（learn=图像学习手动样本优先 / ocr=自动裁剪样本兜底）
- 先审计/清洗原始图，再对保留图做增广（平移/缩放/亮度变体），提升小样本鲁棒性
- `_encode` 为可替换接口：后续如需 CLIP，只需替换该函数与 `_get_model`

对外 API（签名不变）：match_crop / add_crop / gallery / audit_crops / clean_gallery / collect_crops
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageEnhance
from torchvision.models import resnet50, ResNet50_Weights

from .config import CROPS_DIR, DATA_DIR, OCR_PROCESSED_DIR, SCAN_DIR
from .core.norm import norm_name as _norm
from .db import db

MANIFEST = DATA_DIR / "crops_manifest.json"
FEATS_CACHE = DATA_DIR / "crops_feats.npy"   # 特征持久化缓存（manifest 变更自动失效）
FEATS_META = DATA_DIR / "crops_feats.meta"   # 与 npy 行对齐的源文件签名（增量更新用）
FEATS_FP = DATA_DIR / "crops_feats.fp"       # 缓存指纹（兼容旧版，新逻辑以 meta 为准）
IMG_SIZE = 224
FEAT_DIM = 2048

_model = None
_gallery_cache: dict[str, Any] = {"manifest": None, "feats": None}
_device = "cuda" if torch.cuda.is_available() else "cpu"

# TorchScript trace 缓存：免每次进程启动重新构造 torchvision ResNet50（节省约 1~2s 初始化）。
# 注意：放系统 temp（英文路径）——torch.jit.save/load 在中文路径下会失败。
_MODEL_TRACE = Path(tempfile.gettempdir()) / f"bidking_resnet50_feat_{'cuda' if _device == 'cuda' else 'cpu'}.pt"


# ---------------------------------------------------------------- 基础工具


def _load_manifest() -> list[dict[str, Any]]:
    if not MANIFEST.exists():
        return []
    try:
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []


def _save_manifest(items: list[dict[str, Any]]) -> None:
    MANIFEST.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    _gallery_cache["manifest"] = None
    _gallery_cache["feats"] = None


def _cached_manifest() -> list[dict[str, Any]]:
    """进程内缓存的 manifest（与特征缓存同源，图库变更由 _save_manifest 失效）。"""
    if _gallery_cache["manifest"] is None:
        _gallery_cache["manifest"] = _load_manifest()
    return _gallery_cache["manifest"]


# ---------------------------------------------------------------- 编码器


def _get_model() -> torch.nn.Module:
    """ResNet50(ImageNet) 去掉 fc，输出 avgpool 后 2048 维特征。

    优先加载 TorchScript trace 缓存（免 torchvision 构造开销）；无缓存时构造
    并 trace 落盘。GPU 下使用 FP16 半精度，推理速度约翻倍。
    """
    global _model
    if _model is None:
        if _MODEL_TRACE.exists():
            try:
                m = torch.jit.load(str(_MODEL_TRACE)).to(_device).eval()
                if _device == "cuda":
                    m = m.half()
                _model = m
                return _model
            except Exception:  # noqa: BLE001
                _model = None
        weights = ResNet50_Weights.IMAGENET1K_V1
        m = resnet50(weights=weights)
        m.fc = torch.nn.Identity()
        m.eval()
        try:
            # 注意：Module.cpu()/float() 是 inplace，会修改 m 本身。
            # 因此先以初始 cpu/fp32 状态 trace 保存（中文路径下 jit.save 会失败，故用英文 temp 路径），
            # 再转移到目标 device，避免模型被挪回 cpu。
            dummy = torch.zeros(1, 3, IMG_SIZE, IMG_SIZE)
            traced = torch.jit.trace(m, dummy)
            torch.jit.save(traced, str(_MODEL_TRACE))
        except Exception:  # noqa: BLE001 trace 失败不阻塞，退回普通模型
            pass
        if _device == "cuda":
            m = m.half()
        m.to(_device)
        _model = m
    return _model


def _encode(images: list[Image.Image]) -> np.ndarray:
    """批量编码为 L2 归一化特征 (n, 2048)。可替换为 CLIP 实现。"""
    if not images:
        return np.zeros((0, FEAT_DIM), dtype=np.float32)
    tf = ResNet50_Weights.IMAGENET1K_V1.transforms()
    model = _get_model()
    out: list[np.ndarray] = []
    chunk = 32  # CPU 内存保护：分批前向，结果与整批一致
    with torch.no_grad():
        for i in range(0, len(images), chunk):
            prepped = [im if im.mode == "RGB" else im.convert("RGB") for im in images[i : i + chunk]]
            batch = torch.stack([tf(im) for im in prepped])
            batch = batch.to(_device)
            if _device == "cuda":
                batch = batch.half()
            feats = F.normalize(model(batch), p=2, dim=1)
            out.append(feats.cpu().numpy())
    return np.concatenate(out, axis=0).astype(np.float32)


def _open_pil(p: str | Path) -> Image.Image:
    return Image.open(p).convert("RGB")


# ---------------------------------------------------------------- 裁剪


def _cell_crop(pil: Image.Image, item: dict[str, Any], pad: float = 0.25) -> Image.Image:
    return _icon_crop(pil, item, pad)


def _box_band_crop(pil: Image.Image, item: dict[str, Any], pad: float = 0.15) -> Image.Image:
    """名称框与价格框之间的条带（旧启发式，作为兜底之一）。"""
    nb = item.get("name_box") or {}
    pb = item.get("price_box") or {}
    if not nb:
        return pil
    if pb:
        y0 = nb.get("y1", 0) + 0.05 * (pb["y0"] - nb["y1"])
        y1 = pb["y0"] - 0.05 * (pb["y0"] - nb["y1"])
    else:
        y0 = nb.get("y1", 0) + 2
        y1 = min(pil.height, y0 + max(80, 3 * (nb["y1"] - nb["y0"])))
    x0 = min(nb.get("x0", 0), pb.get("x0", 0)) if pb else nb.get("x0", 0)
    x1 = max(nb.get("x1", pil.width), pb.get("x1", pil.width)) if pb else nb.get("x1", pil.width)
    w = x1 - x0
    h = y1 - y0
    if h <= 4 or w <= 4:
        return pil
    x0 = max(0, x0 - pad * w)
    y0 = max(0, y0 - pad * h)
    x1 = min(pil.width, x1 + pad * w)
    y1 = min(pil.height, y1 + pad * h)
    return pil.crop((int(x0), int(y0), int(x1), int(y1)))


def _search_region(pil: Image.Image, item: dict[str, Any]) -> Image.Image | None:
    """OCR 框区域：名称框上沿到价格框上沿（不含价格文字），左右外扩，供模板定位图标。"""
    nb = item.get("name_box") or {}
    pb = item.get("price_box") or {}
    xs = [b["x0"] for b in (nb, pb) if b] or [0]
    xe = [b["x1"] for b in (nb, pb) if b] or [pil.width]
    ys = nb.get("y0", 0)
    ye = pb["y0"] if pb else nb.get("y1", pil.height)
    w = max(xe) - min(xs)
    h = ye - ys
    if h <= 4 or w <= 4:
        return None
    x0 = max(0, int(min(xs) - 0.35 * w))
    y0 = max(0, int(ys - 0.45 * h))
    x1 = min(pil.width, int(max(xe) + 0.35 * w))
    y1 = min(pil.height, int(ye))
    if x1 - x0 < 12 or y1 - y0 < 12:
        return None
    return pil.crop((x0, y0, x1, y1))


def _content_icon_crop(pil: Image.Image, item: dict[str, Any], pad: float = 0.15) -> Image.Image | None:
    """内容感知兜底：在候选区域（名称-价格条带 / 名称框扩展 / 名称上方）中，
    用“灰度方差×面积”选出信息量最高的区域；空白条带（方差过低）直接出局。"""
    nb = item.get("name_box") or {}
    pb = item.get("price_box") or {}
    cands: list[tuple[Image.Image, str]] = []
    band = _box_band_crop(pil, item, pad)
    if band is not pil:
        cands.append((band, "band"))
    if nb and nb.get("y1", 0) - nb.get("y0", 0) >= 8:
        h = nb["y1"] - nb["y0"]
        x0 = max(0, int(nb["x0"] - 0.35 * h))
        y0 = max(0, int(nb["y0"] - 0.35 * h))
        x1 = min(pil.width, int(nb["x1"] + 0.35 * h))
        y1 = min(pil.height, int(nb["y1"] + 0.35 * h))
        if x1 - x0 >= 16 and y1 - y0 >= 16:
            cands.append((pil.crop((x0, y0, x1, y1)), "namebox"))
    if nb and pb and nb.get("y0", 0) >= 16:
        h = nb["y1"] - nb["y0"]
        x0 = max(0, int(nb["x0"] - 0.4 * h))
        x1 = min(pil.width, int(nb["x1"] + 0.4 * h))
        y0 = max(0, int(nb["y0"] - 2.6 * h))
        y1 = int(nb["y0"])
        if x1 - x0 >= 16 and y1 - y0 >= 16:
            cands.append((pil.crop((x0, y0, x1, y1)), "above_name"))
    if not cands:
        return None

    def score(c: Image.Image) -> float:
        g = np.asarray(c.convert("L"), dtype=np.float32)
        std = float(g.std())
        if std < 12.0:  # 近乎空白（例如名称/价格之间的空隙条带）
            return 0.0
        return std * float(np.sqrt(c.size[0] * c.size[1]))

    best_c: Image.Image | None = None
    best_s = 0.0
    for c, _tag in cands:
        s = score(c)
        if s > best_s:
            best_c, best_s = c, s
    return best_c


def _reference_template(name: str) -> Image.Image | None:
    """同款参考图标：优先 learn 样本，其次按面积最大选 ocr 原始样本；无则返回 None。"""
    key = _norm(name)
    if not key:
        return None
    cands = [
        m for m in _cached_manifest()
        if not m.get("variant") and _norm(m.get("name") or "") == key
    ]
    if not cands:
        return None

    def sort_key(m: dict[str, Any]) -> tuple[int, int]:
        src = 0 if m.get("source", "ocr") == "learn" else 1
        try:
            with Image.open(m["path"]) as im:
                w, h = im.size
            return (src, -(w * h))
        except Exception:  # noqa: BLE001
            return (src, 0)

    best = min(cands, key=sort_key)
    try:
        return _open_pil(best["path"])
    except Exception:  # noqa: BLE001
        return None


def _icon_crop(pil: Image.Image, item: dict[str, Any], pad: float = 0.15,
               use_template: bool = True) -> Image.Image:
    """稳定裁剪：优先在同款参考模板存在时，用 matchTemplate 在 OCR 框区域内
    定位图标并统一裁剪；无模板/匹配失败时退回内容感知区域，最后退回旧条带裁剪。"""
    if use_template:
        region = _search_region(pil, item)
        tmpl = _reference_template(item.get("name") or "")
        if region is not None and tmpl is not None:
            stable = stabilize_crop(region, tmpl)
            if stable is not None:
                return stable
    content = _content_icon_crop(pil, item, pad)
    if content is not None:
        return content
    return _box_band_crop(pil, item, pad)


# ---------------------------------------------------------------- 增广


def _variant_images(im: Image.Image, n: int = 12) -> list[Image.Image]:
    """平移/缩放/亮度变体。"""
    out: list[Image.Image] = []
    w, h = im.size
    # 平移 ±5px
    for dx, dy in ((5, 0), (-5, 0), (0, 5), (0, -5)):
        canvas = Image.new("RGB", (w + 10, h + 10), (0, 0, 0))
        canvas.paste(im, (5 + dx, 5 + dy))
        out.append(canvas.crop((5, 5, 5 + w, 5 + h)))
    # 缩放 0.9 / 1.1
    for s in (0.9, 1.1):
        nw, nh = max(4, int(w * s)), max(4, int(h * s))
        small = im.resize((nw, nh), Image.LANCZOS)
        canvas = Image.new("RGB", (w, h), (0, 0, 0))
        canvas.paste(small, ((w - nw) // 2, (h - nh) // 2))
        out.append(canvas)
    # 亮度 0.85 / 1.15
    out.append(ImageEnhance.Brightness(im).enhance(0.85))
    out.append(ImageEnhance.Brightness(im).enhance(1.15))
    # 缩放+亮度组合
    small = im.resize((max(4, int(w * 0.95)), max(4, int(h * 0.95))), Image.LANCZOS)
    canvas = Image.new("RGB", (w, h), (0, 0, 0))
    canvas.paste(small, ((w - small.width) // 2, (h - small.height) // 2))
    out.append(ImageEnhance.Brightness(canvas).enhance(1.1))
    out.append(ImageEnhance.Brightness(im).enhance(0.9))
    return out[:n]


def _make_variants(base_entry: dict[str, Any], n: int = 12) -> list[dict[str, Any]]:
    im = _open_pil(base_entry["path"])
    key = _norm(base_entry["name"]) or "item"
    d = CROPS_DIR / key
    d.mkdir(parents=True, exist_ok=True)
    stem = Path(base_entry["path"]).stem
    variants: list[dict[str, Any]] = []
    for i, v in enumerate(_variant_images(im, n)):
        p = d / f"{stem}_v{i}.png"
        v.save(p)
        e = dict(base_entry)
        e["path"] = str(p)
        e["variant"] = True
        e["augmented"] = True
        variants.append(e)
    return variants


def _augment_manifest(n: int = 12) -> int:
    """为未增广的原始条目生成变体并写入 manifest。"""
    manifest = _load_manifest()
    out: list[dict[str, Any]] = []
    added = 0
    for e in manifest:
        if e.get("variant") or e.get("augmented"):
            out.append(e)
            continue
        try:
            variants = _make_variants(e, n)
        except Exception:  # noqa: BLE001
            variants = []
        e["augmented"] = True
        out.append(e)
        out.extend(variants)
        added += len(variants)
    _save_manifest(out)
    return added


# ---------------------------------------------------------------- 入库


def add_crop(name: str, grid_cells: int, crop_img: Image.Image,
             source: str = "ocr", manual: bool = False) -> dict[str, Any]:
    """新增学习样本（source=learn 优先 / ocr 兜底），入库并生成增广变体。

    manual=True 表示「手动补录的漏检红品」，匹配时给分数加成（多注意/加强），
    该标记会随增广变体一起继承。
    """
    CROPS_DIR.mkdir(parents=True, exist_ok=True)
    key = _norm(name) or f"item_{int(np.random.rand() * 1e9)}"
    d = CROPS_DIR / key
    d.mkdir(parents=True, exist_ok=True)
    fname = f"{int(np.random.rand() * 1e9)}.png"
    path = str(d / fname)
    crop_img.convert("RGB").save(path)
    entry = {
        "name": name,
        "grid_cells": grid_cells,
        "path": path,
        "source": source,
        "variant": False,
        "augmented": False,
        "manual": bool(manual),
    }
    manifest = _load_manifest()
    manifest.append(entry)
    try:
        variants = _make_variants(entry)
    except Exception:  # noqa: BLE001
        variants = []
    entry["augmented"] = True
    manifest[-1] = entry
    manifest.extend(variants)
    _save_manifest(manifest)
    return entry


def collect_crops(stabilize: bool = True) -> dict[str, Any]:
    """从 已处理 + 待确认 九宫格图裁切藏品图像建库。
    已确认任务优先用 ocr_samples 的用户确认名打标签（按顺序），否则用图鉴匹配名。
    只入库原始图（不增广），审计/清洗后由 clean_gallery 统一增广。
    保留 source=learn 的手动学习样本，刷新 ocr 自动样本。
    stabilize=True 时用同款参考模板做 matchTemplate 稳定裁剪（首次建库可传 False 先产出内容感知裁剪）。"""
    CROPS_DIR.mkdir(parents=True, exist_ok=True)
    old = _load_manifest()
    manifest: list[dict[str, Any]] = [e for e in old if e.get("source") == "learn"]
    from .ocr import parse_shape, process_image

    with db() as conn:
        samples_by_task: dict[int, list[str]] = {}
        for s in conn.execute(
            "SELECT task_id, name FROM ocr_samples ORDER BY id"
        ).fetchall():
            samples_by_task.setdefault(s["task_id"], []).append(s["name"])
        task_paths: dict[str, int] = {}
        for t in conn.execute(
            "SELECT id, path, kind, status FROM ocr_tasks"
        ).fetchall():
            if t["kind"] == "grid" and t["status"] == "confirmed":
                task_paths[Path(t["path"]).name] = t["id"]

    with db() as conn:
        catalog_names = {_norm(r["name"]) for r in conn.execute("SELECT name FROM catalog_items").fetchall()}
    images: list[Path] = []
    for root in (OCR_PROCESSED_DIR, SCAN_DIR):
        if root.exists():
            for p in root.rglob("*"):
                if p.is_file() and p.suffix.lower() in (".png", ".jpg", ".jpeg", ".bmp"):
                    images.append(p)
    images = list(dict.fromkeys(images))
    for img_path in images:
        shape = parse_shape(img_path.parent.name)
        if shape is None:
            continue
        try:
            with db() as conn:
                res = process_image(conn, img_path, shape)
        except Exception:  # noqa: BLE001
            continue
        items = res.get("items") or []
        samples = samples_by_task.get(task_paths.get(img_path.name, -1), [])
        for i, it in enumerate(items):
            if i < len(samples) and samples[i]:
                label = samples[i]
            else:
                label = it["matches"][0]["name"] if it.get("matched") and it.get("matches") else it["name"]
            crop = _icon_crop(_open_pil(img_path), it, use_template=stabilize)
            key = _norm(label) or f"item_{img_path.parent.name}_{i}"
            d = CROPS_DIR / key
            d.mkdir(parents=True, exist_ok=True)
            fname = f"{img_path.stem}_{i}.png"
            crop.save(d / fname)
            manifest.append({
                "name": label,
                "grid_cells": it["grid_cells"],
                "path": str(d / fname),
                "source": "ocr",
                "variant": False,
                "augmented": False,
            })
    # 只保留图鉴内条目 + 手动学习样本（OCR 标签不在图鉴里的视为噪音，剔除）
    keep = [
        e for e in manifest
        if e.get("source") == "learn" or _norm(e["name"]) in catalog_names
    ]
    _save_manifest(keep)
    cleanup_orphans()
    return {"crops": len(keep), "distinct": len({m["name"] for m in keep})}


# ---------------------------------------------------------------- 匹配


def _file_sig(path: str) -> tuple[int, int] | None:
    """文件签名（size, mtime_ns），用于检测图片是否被替换。"""
    try:
        st = os.stat(path)
        return int(st.st_size), int(st.st_mtime_ns)
    except OSError:
        return None


def _manifest_fingerprint(manifest: list[dict[str, Any]]) -> str:
    """图库指纹：由每个条目的路径+名称+变体标志+文件签名计算，图库一变指纹即变。"""
    h = hashlib.md5()
    for m in manifest:
        h.update(str(m.get("path", "")).encode("utf-8", "ignore"))
        h.update(str(m.get("name", "")).encode("utf-8", "ignore"))
        h.update(str(bool(m.get("variant"))).encode("ascii", "ignore"))
        sig = _file_sig(str(m.get("path", "")))
        if sig:
            h.update(str(sig).encode("ascii", "ignore"))
    return h.hexdigest()


def _save_feats(manifest: list[dict[str, Any]], feats: np.ndarray) -> None:
    """持久化特征矩阵 + 与行对齐的源文件签名（供下次增量重建对齐）。"""
    try:
        np.save(FEATS_CACHE, feats)
        rows = []
        for m in manifest:
            p = str(m.get("path", ""))
            sig = _file_sig(p)
            rows.append({"path": p, "size": sig[0] if sig else 0, "mtime": sig[1] if sig else 0})
        FEATS_META.write_text(json.dumps({"rows": rows}), encoding="utf-8")
    except Exception:  # noqa: BLE001 中文路径等异常时退回内存缓存
        pass


def _rebuild_feats(
    manifest: list[dict[str, Any]],
    old_feats: np.ndarray,
    old_rows: list[dict[str, Any]],
) -> tuple[np.ndarray, bool]:
    """增量重建特征矩阵：只对新增/变更（路径或签名不一致）的图重新编码。

    命中旧缓存的行直接复用，避免 manifest 增删少量条目时全量重跑 ResNet50。
    返回 (新特征, 是否发生了实际变化)。
    """
    sig_map: dict[tuple[str, int, int], int] = {}
    for i, r in enumerate(old_rows):
        sig_map[(r.get("path", ""), int(r.get("size", 0)), int(r.get("mtime", 0)))] = i
    keep = np.zeros((len(manifest), FEAT_DIM), dtype=np.float32)
    pending: list[tuple[int, str]] = []
    for i, m in enumerate(manifest):
        p = str(m.get("path", ""))
        sig = _file_sig(p)
        if sig is not None:
            idx = sig_map.get((p, sig[0], sig[1]))
            if idx is not None:
                keep[i] = old_feats[idx]
                continue
        pending.append((i, p))
    if not pending:
        return keep, False
    new_feats = _encode([_open_pil(p) for _, p in pending])
    for (i, _), f in zip(pending, new_feats):
        keep[i] = f
    return keep, True


def _ensure_cache() -> tuple[list[dict[str, Any]], np.ndarray]:
    if _gallery_cache["manifest"] is None:
        manifest = _cached_manifest()
        feats = None
        changed = False
        if manifest:
            try:
                if FEATS_CACHE.exists() and FEATS_META.exists():
                    cached = np.load(FEATS_CACHE)
                    meta = json.loads(FEATS_META.read_text(encoding="utf-8"))
                    old_rows = meta.get("rows", [])
                    if cached.shape == (len(old_rows), FEAT_DIM):
                        feats, changed = _rebuild_feats(manifest, cached.astype(np.float32), old_rows)
            except Exception:  # noqa: BLE001
                feats = None
        if feats is None:
            feats = _encode([_open_pil(m["path"]) for m in manifest]) if manifest else np.zeros((0, FEAT_DIM), dtype=np.float32)
            changed = True
        if manifest and changed:
            _save_feats(manifest, feats)
        _gallery_cache["manifest"] = manifest
        _gallery_cache["feats"] = feats
    return _gallery_cache["manifest"], _gallery_cache["feats"]


def match_crop(crop_path: str | Path, topk: int = 5) -> dict[str, Any]:
    """按 ResNet50 余弦相似度匹配藏品。
    同一 name 取最高分；source=learn 样本优先；命中多个变体时 votes 计数（仅参考，分数为纯余弦）。"""
    manifest, feats = _ensure_cache()
    if not manifest:
        return {"ok": False, "error": "暂无藏品图像库，请先在截图识别页确认九宫格图片", "matches": []}
    q = _encode([_open_pil(crop_path)])[0]
    sims = feats @ q  # (n,)

    # 单次遍历：同时统计每 name 的最佳 learn/ocr 候选与高置信 votes，避免 O(n·k) 嵌套
    per_name: dict[str, dict[str, Any]] = {}
    votes_map: dict[str, int] = {}
    for i, m in enumerate(manifest):
        s = float(sims[i])
        nm = m["name"]
        if s >= 0.75:
            votes_map[nm] = votes_map.get(nm, 0) + 1
        src = m.get("source", "ocr")
        d = per_name.setdefault(nm, {"learn": None, "ocr": None})
        cand = {"score": s, "path": m["path"], "cells": m.get("grid_cells", 0), "manual": bool(m.get("manual"))}  # 重建样本可能缺 grid_cells
        cur = d[src]
        if cur is None or s > cur["score"]:
            d[src] = cand

    ranked: list[dict[str, Any]] = []
    for nm, d in per_name.items():
        learn, ocr = d["learn"], d["ocr"]
        if learn is not None and (learn["score"] >= 0.60 or ocr is None or learn["score"] >= ocr["score"]):
            use = learn
            source = "learn"
        elif ocr is not None:
            use = ocr
            source = "ocr"
        else:
            use = learn
            source = "learn"
        # 手动补录的漏检红品：分数加成（多注意/加强），提高下次同类命中排名
        bonus = 0.04 if use.get("manual") else 0.0
        # 多票加权：该 name 命中 >=0.75 的变体数量（单次遍历已统计）
        ranked.append({
            "name": nm,
            "grid_cells": use["cells"],
            "score": round(use["score"] + bonus, 4),  # 纯余弦 + 手动加成
            "gallery": use["path"],
            "source": source,
            "votes": votes_map.get(nm, 0),
            "manual": bool(use.get("manual")),
        })
    ranked.sort(key=lambda x: -x["score"])
    return {"ok": True, "matches": ranked[:topk]}


def match_crops(crops: list[Image.Image], topk: int = 5) -> list[dict[str, Any]]:
    """批量匹配：一次编码所有裁剪图（单次 GPU forward），逐张返回与 match_crop 相同的结构。
    供 auto_detect 多格场景使用，避免每格临时文件 + 单独编码的开销。"""
    manifest, feats = _ensure_cache()
    n = len(crops)
    if not manifest or n == 0:
        return [{"ok": False, "matches": []} for _ in range(n)]
    qs = _encode(crops)          # (n, 2048)
    sims_all = qs @ feats.T      # (n, m)
    results: list[dict[str, Any]] = []
    for k in range(n):
        sims = sims_all[k]
        per_name: dict[str, dict[str, Any]] = {}
        votes_map: dict[str, int] = {}
        for i, m in enumerate(manifest):
            s = float(sims[i])
            nm = m["name"]
            if s >= 0.75:
                votes_map[nm] = votes_map.get(nm, 0) + 1
            src = m.get("source", "ocr")
            d = per_name.setdefault(nm, {"learn": None, "ocr": None})
            cand = {"score": s, "path": m["path"], "cells": m.get("grid_cells", 0), "manual": bool(m.get("manual"))}
            cur = d[src]
            if cur is None or s > cur["score"]:
                d[src] = cand
        ranked: list[dict[str, Any]] = []
        for nm, d in per_name.items():
            learn, ocr = d["learn"], d["ocr"]
            if learn is not None and (learn["score"] >= 0.60 or ocr is None or learn["score"] >= ocr["score"]):
                use = learn
                source = "learn"
            elif ocr is not None:
                use = ocr
                source = "ocr"
            else:
                use = learn
                source = "learn"
            bonus = 0.04 if use.get("manual") else 0.0
            ranked.append({
                "name": nm,
                "grid_cells": use["cells"],
                "score": round(use["score"] + bonus, 4),
                "gallery": use["path"],
                "source": source,
                "votes": votes_map.get(nm, 0),
                "manual": bool(use.get("manual")),
            })
        ranked.sort(key=lambda x: -x["score"])
        results.append({"ok": True, "matches": ranked[:topk]})
    return results


def stabilize_crop(crop_img: Image.Image, template_img: Image.Image) -> Image.Image | None:
    """多尺度模板对齐：在查询图内用 matchTemplate(TM_CCOEFF_NORMED) 定位模板，
    按统一比例重裁；找不到可靠匹配时返回 None（由调用方兜底）。"""
    q = np.asarray(crop_img.convert("L"), dtype=np.uint8)
    t = np.asarray(template_img.convert("L"), dtype=np.uint8)
    if t.shape[0] >= q.shape[0] or t.shape[1] >= q.shape[1]:
        return None
    best = (None, -1.0)
    for s in (0.7, 0.8, 0.9, 1.0):
        th, tw = int(t.shape[0] * s), int(t.shape[1] * s)
        if th < 8 or tw < 8 or th >= q.shape[0] or tw >= q.shape[1]:
            continue
        ts = cv2.resize(t, (tw, th), interpolation=cv2.INTER_AREA)
        res = cv2.matchTemplate(q, ts, cv2.TM_CCOEFF_NORMED)
        _, mx, _, mxloc = cv2.minMaxLoc(res)
        if mx > best[1]:
            best = (mxloc, mx, s)
    if best[1] < 0.55 or best[0] is None:
        return None
    x, y = best[0]
    s = best[2]
    th, tw = int(t.shape[0] * s), int(t.shape[1] * s)
    pad = 0.25
    x0 = max(0, int(x - tw * pad))
    y0 = max(0, int(y - th * pad))
    x1 = min(crop_img.width, int(x + tw * (1 + pad)))
    y1 = min(crop_img.height, int(y + th * (1 + pad)))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    return crop_img.crop((x0, y0, x1, y1))


# ---------------------------------------------------------------- 审计 / 清洗


def audit_crops(min_same: float = 0.75) -> dict[str, Any]:
    """审计原始图（不含增广变体）：同名多张互相相似度低（或低于异名最高分）视为可疑。"""
    manifest = [m for m in _load_manifest() if not m.get("variant")]
    if not manifest:
        return {"checked": 0, "suspicious": []}
    feats = _encode([_open_pil(m["path"]) for m in manifest])
    sims = feats @ feats.T
    by_name: dict[str, list[int]] = {}
    for i, e in enumerate(manifest):
        by_name.setdefault(e["name"], []).append(i)

    suspicious: list[dict[str, Any]] = []
    checked = 0
    for name, idxs in by_name.items():
        if len(idxs) < 2:
            continue
        others = set(idxs)
        for i in idxs:
            best_same = float(np.max([sims[i, j] for j in idxs if j != i]))
            best_diff = float(np.max([sims[i, j] for j in range(len(manifest)) if j not in others] or [0.0]))
            checked += 1
            if best_same < min_same or best_same < best_diff:
                suspicious.append({
                    "name": name,
                    "path": manifest[i]["path"],
                    "best_same": round(best_same, 3),
                    "best_diff": round(best_diff, 3),
                })
    return {"checked": checked, "suspicious": suspicious}


def clean_gallery() -> dict[str, Any]:
    """剔除可疑原始条目（文件保留），随后对保留条目统一增广。"""
    result = audit_crops()
    sus = result["suspicious"]
    manifest = _load_manifest()
    if sus:
        sus_paths = {s["path"] for s in sus}
        keep = [m for m in manifest if m["path"] not in sus_paths]
        _save_manifest(keep)
    added = _augment_manifest()
    kept = len(_load_manifest())
    return {**result, "removed": len(sus), "kept": kept, "augmented_added": added}


def delete_learn_samples(names: list[str]) -> dict[str, Any]:
    """删除指定藏品的 learn 学习样本（含变体文件），使其回到未学习状态。"""
    target = {_norm(n) for n in names if n}
    if not target:
        return {"ok": True, "deleted_files": 0, "items_affected": 0}
    manifest = _load_manifest()
    keep: list[dict[str, Any]] = []
    deleted_files = 0
    affected: set[str] = set()
    for e in manifest:
        if e.get("source") == "learn" and _norm(e["name"]) in target:
            try:
                Path(e["path"]).unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass
            deleted_files += 1
            affected.add(e["name"])
        else:
            keep.append(e)
    _save_manifest(keep)
    return {"ok": True, "deleted_files": deleted_files, "items_affected": len(affected)}


def _to_trash(p: Path) -> bool:
    """删除前把文件移动到回收箱目录。

    本机有系统级 safe-delete 会拦截 unlink/rm，导致每个文件删除都很慢（前端“删除中”卡死）。
    移动文件(p.replace)不触发删除钩子、即时完成，且文件可恢复，故删除一律走回收箱。
    """
    try:
        trash = DATA_DIR / "crops_trash"
        trash.mkdir(parents=True, exist_ok=True)
        try:
            rel = p.relative_to(CROPS_DIR)
        except ValueError:
            rel = Path(p.name)
        dest = trash / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        p.replace(dest)
        return True
    except Exception:  # noqa: BLE001
        return False


def delete_manifest_entries(paths: list[str]) -> dict[str, Any]:
    """按路径删除指定 manifest 条目及其图片文件（逐张清理某藏品的学习图片）。"""
    target = set(paths or [])
    if not target:
        return {"ok": True, "deleted": 0}
    manifest = _load_manifest()
    keep: list[dict[str, Any]] = []
    deleted = 0
    for e in manifest:
        if e.get("path") in target:
            _to_trash(Path(e["path"]))
            deleted += 1
        else:
            keep.append(e)
    _save_manifest(keep)
    cleanup_orphans()
    return {"ok": True, "deleted": deleted}


def cleanup_orphans() -> dict[str, Any]:
    """统计 crops 中不在 manifest 里的孤儿图片，但不做任何移动/删除。

    2026-08-14 曾因路径(正斜杠 vs 反斜杠)不一致把全部正常图片当孤儿移入回收箱，
    造成 800+ 张图片丢失事故。此后改为只读统计，绝不再自动清理文件。
    孤儿文件由外部脚本按需处理（用 _to_trash 移入回收箱）。
    """
    manifest = _load_manifest()
    keep_paths = {os.path.normcase(os.path.normpath(m["path"])) for m in manifest}
    orphan = 0
    orphan_mb = 0.0
    if CROPS_DIR.exists():
        for p in CROPS_DIR.rglob("*"):
            if p.is_file():
                sp = os.path.normcase(os.path.normpath(str(p)))
                if sp not in keep_paths:
                    try:
                        orphan_mb += p.stat().st_size / 1024 / 1024
                        orphan += 1
                    except Exception:  # noqa: BLE001
                        pass
    return {"orphan": orphan, "orphan_mb": round(orphan_mb, 1), "removed": 0, "removed_mb": 0.0}


def delete_crops_for_names(names: list[str]) -> dict[str, Any]:
    """删除指定藏品名在清单里的全部条目与文件（图鉴删除时同步调用）。"""
    target = {_norm(n) for n in names if n}
    if not target:
        return {"ok": True, "removed": 0}
    manifest = _load_manifest()
    keep: list[dict[str, Any]] = []
    removed = 0
    for e in manifest:
        if _norm(e["name"]) in target:
            _to_trash(Path(e["path"]))
            removed += 1
        else:
            keep.append(e)
    _save_manifest(keep)
    cleanup_orphans()
    return {"ok": True, "removed": removed}


def prune_missing_files() -> dict[str, Any]:
    """剔除清单中文件已不存在的死记录，保证 清单==磁盘。"""
    manifest = _load_manifest()
    keep = [e for e in manifest if Path(e["path"]).exists()]
    removed = len(manifest) - len(keep)
    if removed:
        _save_manifest(keep)
    cleanup_orphans()
    return {"removed_entries": removed, "kept": len(keep)}


def trim_gallery(max_per_name: int = 5) -> dict[str, Any]:
    """每种藏品最多保留 max_per_name 张图：优先 learn 样本、其次非变体原始图，多余删除并同步文件。"""
    from collections import defaultdict

    manifest = _load_manifest()
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for e in manifest:
        groups[_norm(e["name"])].append(e)
    keep: list[dict[str, Any]] = []
    removed = 0
    for name, entries in groups.items():
        entries.sort(key=lambda e: (
            0 if e.get("source") == "learn" else 1,
            1 if e.get("variant") else 0,
            e.get("path", ""),
        ))
        keep.extend(entries[:max_per_name])
        removed += max(0, len(entries) - max_per_name)
    _save_manifest(keep)
    cleanup_orphans()
    return {"kept": len(keep), "removed_entries": removed, "max_per_name": max_per_name}


# ---------------------------------------------------------------- 目录


def gallery(conn) -> dict[str, Any]:
    """藏品目录：所有图鉴条目 + 是否已有分割图像（用于网页端核对）。"""
    from collections import defaultdict

    manifest = _load_manifest()
    img_by_name: dict[str, list[int]] = defaultdict(list)
    learn_names: set[str] = set()
    manual_names: set[str] = set()
    for i, m in enumerate(manifest):
        img_by_name[_norm(m["name"])].append(i)
        if m.get("source") == "learn":
            learn_names.add(_norm(m["name"]))
        if m.get("manual"):
            manual_names.add(_norm(m["name"]))
    items = []
    for r in conn.execute(
        "SELECT id, name, grid_cells, value, current_value, source FROM catalog_items ORDER BY grid_cells, value DESC"
    ).fetchall():
        imgs = img_by_name.get(_norm(r["name"]), [])
        items.append({
            "cat_id": r["id"],
            "id": imgs[0] if imgs else None,
            "image_path": manifest[imgs[0]]["path"] if imgs else None,
            "name": r["name"],
            "grid_cells": r["grid_cells"],
            "value": r["value"],
            "current_value": r["current_value"],
            "source": r["source"],
            "has_image": bool(imgs),
            "n_images": len(imgs),
            "images": [
                {
                    "id": i,
                    "path": manifest[i]["path"],
                    "source": manifest[i].get("source"),
                    "variant": bool(manifest[i].get("variant")),
                }
                for i in imgs
            ],
            "has_learn": _norm(r["name"]) in learn_names,
            "has_manual": _norm(r["name"]) in manual_names,
        })
    return {
        "items": items,
        "total": len(items),
        "with_image": sum(1 for x in items if x["has_image"]),
    }


# ---------------------------------------------------------------- 评估


def eval_distribution(min_score: float = 0.0,
                      exclude_prefixes: list[str] | None = None) -> dict[str, Any]:
    """同款 vs 异款相似度分布（用于确定匹配阈值）。
    遍历 manifest 的原始条目，两两余弦相似度，按同名/异名分组输出均值/分位。
    exclude_prefixes：排除近亲系列（如 ["十三幺"]）后复验，用于验收判据。"""
    manifest = [m for m in _load_manifest() if not m.get("variant")]
    if len(manifest) < 2:
        return {"error": "图库样本不足"}
    exclude = exclude_prefixes or []
    feats = _encode([_open_pil(m["path"]) for m in manifest])
    sims = feats @ feats.T
    same, diff = [], []
    for i in range(len(manifest)):
        for j in range(i + 1, len(manifest)):
            if any(manifest[i]["name"].startswith(p) or manifest[j]["name"].startswith(p) for p in exclude):
                continue
            s = float(sims[i, j])
            if s < min_score:
                continue
            if manifest[i]["name"] == manifest[j]["name"]:
                same.append(s)
            else:
                diff.append(s)

    def stats(arr: list[float]) -> dict[str, float]:
        a = np.asarray(arr)
        return {
            "n": int(len(a)),
            "mean": round(float(a.mean()), 4) if len(a) else None,
            "median": round(float(np.median(a)), 4) if len(a) else None,
            "p10": round(float(np.percentile(a, 10)), 4) if len(a) else None,
            "p90": round(float(np.percentile(a, 90)), 4) if len(a) else None,
            "max": round(float(a.max()), 4) if len(a) else None,
        }

    s_s, d_s = stats(same), stats(diff)
    gap = None
    if s_s.get("median") is not None and d_s.get("max") is not None:
        gap = round(s_s["median"] - d_s["max"], 4)
    return {"same": s_s, "diff": d_s, "gap_median_vs_max": gap}


def recognition_status() -> dict[str, Any]:
    """红品识别模型状态：特征库版本、样本统计、GPU 设备、区分度指标。"""
    manifest = [m for m in _load_manifest() if not m.get("variant")]
    total = len(_load_manifest())
    names = {m["name"] for m in manifest}
    learn_cnt = sum(1 for m in manifest if m.get("source") == "learn")
    status: dict[str, Any] = {
        "trained": len(manifest) > 0,
        "samples": len(manifest),
        "total_entries": total,
        "distinct_names": len(names),
        "learn_samples": learn_cnt,
        "device": _device,
        "cuda": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "fp16": _device == "cuda",
        "fingerprint": _manifest_fingerprint(manifest) if manifest else None,
    }
    if len(manifest) >= 2:
        try:
            status["distribution"] = eval_distribution()
        except Exception:  # noqa: BLE001
            status["distribution"] = None
    return status


def rebuild_features() -> dict[str, Any]:
    """强制重建特征缓存（GPU 下约 1-2 秒）。"""
    _gallery_cache["manifest"] = None
    _gallery_cache["feats"] = None
    manifest, feats = _ensure_cache()
    return {
        "ok": True,
        "samples": len(manifest),
        "distinct_names": len({m["name"] for m in manifest}),
        "feat_dim": int(feats.shape[1]) if len(feats) else 0,
        "device": _device,
    }
