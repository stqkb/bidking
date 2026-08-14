"""视觉识别、截屏、剪贴板路由（/api/vision/*、/api/capture、/api/clipboard）。"""
from __future__ import annotations

import io
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from .. import ocr as ocr_mod, vision, schemas
from ..config import DATA_DIR
from ..db import db
from ..services import matching

router = APIRouter()


def _catalog_value(name: str) -> float | None:
    """按名称查图鉴当前值（原名 main._catalog_value）。"""
    with db(readonly=True) as conn:
        return matching.catalog_value(conn, name)


@router.get("/api/vision/gallery")
def vision_gallery() -> dict[str, Any]:
    with db(readonly=True) as conn:
        return vision.gallery(conn)


@router.get("/api/vision/model_status")
def vision_model_status() -> dict[str, Any]:
    """红品识别模型状态：特征库样本、GPU、区分度。"""
    return vision.recognition_status()


@router.post("/api/vision/model_rebuild")
def vision_model_rebuild() -> dict[str, Any]:
    """重建红品识别特征库（GPU 加速）。"""
    return vision.rebuild_features()


@router.get("/api/vision/image/{crop_id}")
def vision_image(crop_id: int) -> FileResponse:
    manifest = vision._load_manifest()
    if crop_id < 0 or crop_id >= len(manifest):
        raise HTTPException(status_code=404, detail="图像不存在")
    p = manifest[crop_id]["path"]
    if not Path(p).exists():
        raise HTTPException(status_code=404, detail="图像不存在")
    return FileResponse(p)


@router.post("/api/vision/learn")
def vision_learn(body: schemas.LearnInput) -> dict[str, Any]:
    from PIL import Image

    if body.image_path.startswith("task:"):
        tid = int(body.image_path.split(":", 1)[1])
        with db() as conn:
            row = conn.execute("SELECT path, shape FROM ocr_tasks WHERE id=?", (tid,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        p = Path(row["path"])
        if not p.exists() and row["shape"]:
            p = ocr_mod.OCR_PROCESSED_DIR / row["shape"] / p.name
    else:
        p = Path(body.image_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="请填写藏品名称")
    im = Image.open(p).convert("RGB")
    x0, y0, x1, y1 = body.box
    x0, x1 = sorted((max(0, min(x0, im.width)), max(0, min(x1, im.width))))
    y0, y1 = sorted((max(0, min(y0, im.height)), max(0, min(y1, im.height))))
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise HTTPException(status_code=400, detail="框选区域太小，请重新框选")
    crop = im.crop((x0, y0, x1, y1))
    vision.add_crop(name, body.grid_cells, crop, source="learn")
    return {"ok": True, "name": name, "grid_cells": body.grid_cells}


@router.post("/api/vision/annotate")
def vision_annotate(body: schemas.AnnotateInput) -> dict[str, Any]:
    """人工标注校准：框选红品（入库学习）或结算字段（总价值/成交价/收益）。"""
    from PIL import Image

    if not body.box or len(body.box) != 4:
        raise HTTPException(status_code=400, detail="请先框选区域")
    p = Path(body.image_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    x0, y0, x1, y1 = body.box
    x0, x1 = sorted((max(0, min(x0, 100000)), max(0, min(x1, 100000))))
    y0, y1 = sorted((max(0, min(y0, 100000)), max(0, min(y1, 100000))))
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise HTTPException(status_code=400, detail="框选区域太小")
    im = Image.open(p).convert("RGB")
    crop = im.crop((x0, y0, x1, y1))
    now = datetime.now().isoformat(timespec="seconds")
    if body.kind == "red":
        if not body.name.strip():
            raise HTTPException(status_code=400, detail="请填写红品名称")
        vision.add_crop(body.name.strip(), body.grid_cells or 0, crop, source="learn")
        with db() as conn:
            conn.execute(
                """INSERT INTO vision_annotations(image_path, box, kind, name, grid_cells, value, created_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (str(p), str(body.box), "red", body.name.strip(), body.grid_cells or 0, body.value, now),
            )
        return {"ok": True, "kind": "red", "name": body.name.strip()}
    with db() as conn:
        conn.execute(
            """INSERT INTO vision_annotations(image_path, box, kind, name, grid_cells, value, created_at)
               VALUES (?,?,?,?,?,?,?)""",
            (str(p), str(body.box), body.kind, body.name, body.grid_cells or 0, body.value, now),
        )
    return {"ok": True, "kind": body.kind, "value": body.value}


@router.post("/api/vision/ocr_box")
def vision_ocr_box(body: schemas.OcrBoxInput) -> dict[str, Any]:
    """对框选区域做 OCR，返回文字与数字（用于结算字段标注辅助）。"""
    from PIL import Image, ImageOps, ImageEnhance

    p = Path(body.image_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    x0, y0, x1, y1 = body.box
    im = Image.open(p).convert("RGB").crop((x0, y0, x1, y1))
    im = ImageOps.autocontrast(ImageEnhance.Contrast(im).enhance(2.0))
    tmp = str(Path(os.environ.get("TEMP", ".")) / f"_ocrbox_{int(time.time()*1000)}.png")
    im.save(tmp)
    try:
        boxes = ocr_mod._ocr_run(tmp)
    finally:
        Path(tmp).unlink(missing_ok=True)
    texts = [b["text"] for b in boxes]
    return {"ok": True, "texts": texts, "ocr": boxes}


@router.post("/api/vision/auto_detect")
def vision_auto_detect(body: schemas.ImagePathInput) -> dict[str, Any]:
    """自动检测图片中的红品格子，返回每个格子的裁剪图与视觉候选，供人工勾选标注。"""
    from PIL import Image
    import cv2

    p = Path(body.image_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    pil = Image.open(p).convert("RGB")
    a = np.asarray(pil).astype(int)
    H, W, _ = a.shape
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    # 统一红底判定：兼容旧版亮红(≈101,66,79)与新版深红(≈60,30,28)。
    # 核心特征：R-G≥30（红色主导；金色 R-G≈10-15、棕色图标 R-G≈16-18 均排除）、
    # R≥B+6、G≈B（|G-B|≤16，金色 G-B≈20 排除）。
    red_bg = (
        (R - G >= 30) & (R >= B + 6) & (np.abs(G - B) <= 16)
        & (R >= 35) & (R <= 150) & (G >= 15) & (G <= 90) & (B >= 15) & (B <= 95)
    )
    mask = red_bg.astype(np.uint8) * 255

    k = np.ones((3, 3), np.uint8)
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)
    n, labels, stats, cents = cv2.connectedComponentsWithStats(closed, connectivity=8)
    cells = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if y > H * 0.84:
            continue
        if w < 26 or h < 26 or area < 600:
            continue
        sub = a[y:y + h, x:x + w]
        rR, rG, rB = sub[..., 0], sub[..., 1], sub[..., 2]
        # 格内红底填充检测：比连通域掩码略宽松（处理抗锯齿），但仍排除金/棕
        is_red = (
            (rR - rG >= 24) & (rR >= rB + 4) & (np.abs(rG - rB) <= 20)
            & (rR >= 28) & (rR <= 170) & (rG >= 10) & (rG <= 105) & (rB >= 10) & (rB <= 110)
        )
        fill = is_red.mean()
        if fill < 0.30:
            continue
        # 背景主色校验：格子四周边缘背景必须满足红底判定（排除金底与棕褐图标）
        border = np.concatenate([
            sub[: max(3, h // 12)].reshape(-1, 3),
            sub[-max(3, h // 12):].reshape(-1, 3),
            sub[:, : max(3, w // 12)].reshape(-1, 3),
            sub[:, -max(3, w // 12):].reshape(-1, 3),
        ])
        lum = border.mean(axis=1)
        border = border[(lum > 25) & (lum < 240)]
        if len(border) >= 30:
            bg = np.median(border, axis=0)
            br, bgr, bb = float(bg[0]), float(bg[1]), float(bg[2])
            ok_border = (
                (br - bgr >= 24) & (br >= bb + 4) & (abs(bgr - bb) <= 20)
                & (28 <= br <= 170) & (10 <= bgr <= 105) & (10 <= bb <= 110)
            )
            if not ok_border:
                continue
        # 图标 = 非红色、有足够饱和度的彩色像素（排除白字/灰白描边/纯黑）
        mx = np.maximum(np.maximum(rR, rG), rB)
        mn = np.minimum(np.minimum(rR, rG), rB)
        sat = mx - mn
        icon = ~is_red & (sat >= 30) & ~((rR < 40) & (rG < 40) & (rB < 40))
        # 真正的红品格子：内部必须有足够多的彩色图标像素
        if icon.mean() < 0.06:
            continue
        imask = icon.astype(np.uint8) * 255
        # 先腐蚀去掉红背景边缘渗入的像素，再闭运算连接图标内部
        erode_k = np.ones((2, 2), np.uint8)
        imask = cv2.erode(imask, erode_k)
        ik = np.ones((4, 4), np.uint8)
        iclosed = cv2.morphologyEx(imask, cv2.MORPH_CLOSE, ik)
        ret, ilab, ist, icen = cv2.connectedComponentsWithStats(iclosed, connectivity=8)
        best = None
        for j in range(1, ret):
            ix, iy, iw, ih, ia = ist[j]
            if 20 <= iw <= 260 and 20 <= ih <= 260 and ia >= 200:
                if best is None or ia > best[4]:
                    best = (ix, iy, iw, ih, ia)
        if best:
            ix, iy, iw, ih, ia = best
            # 红品图标应接近方形或竖直：宽高比 0.45~2.2（排除扁条/细线碎片）
            ratio = iw / max(ih, 1)
            if ratio < 0.45 or ratio > 2.2:
                continue
            if iw < 30 or ih < 30:
                continue
            cells.append({
                "cell": [int(x), int(y), int(x + w), int(y + h)],
                "icon": [int(x + ix), int(y + iy), int(x + ix + iw), int(y + iy + ih)],
            })
    # 对每个格子图标做视觉匹配：整批一次编码（单次 GPU forward），不再逐格落盘
    crops = []
    for c in cells:
        ix0, iy0, ix1, iy1 = c["icon"]
        pad = 4
        crops.append(pil.crop((max(0, ix0 - pad), max(0, iy0 - pad), min(W, ix1 + pad), min(H, iy1 + pad))))
    out = []
    if crops:
        vs = vision.match_crops(crops, topk=5)
        for c, v in zip(cells, vs):
            matches = [
                {
                    "name": m["name"],
                    "grid_cells": m["grid_cells"],
                    "score": m["score"],
                    "value": _catalog_value(m["name"]),
                }
                for m in v.get("matches", [])[:5]
            ]
            out.append({"cell": c["cell"], "icon": c["icon"], "crop_path": None, "matches": matches})
    if not out:
        # 场景1：单件红品截图（红底/金底/深底均可）——整图直配。
        # 判定"单件"：最大彩色区域占图面积 >= 35% 且明显大于次大区域。
        mx2 = np.maximum(np.maximum(R, G), B)
        mn2 = np.minimum(np.minimum(R, G), B)
        sat2 = (mx2 - mn2 >= 22) & (mx2 >= 35)
        sclosed = cv2.morphologyEx(sat2.astype(np.uint8) * 255, cv2.MORPH_CLOSE, k)
        sn2, sl2, sst2, sc2 = cv2.connectedComponentsWithStats(sclosed, connectivity=8)
        comps2 = sorted((s for s in sst2[1:]), key=lambda s: -s[4])
        if comps2:
            top_area = float(comps2[0][4])
            second_area = float(comps2[1][4]) if len(comps2) > 1 else 0.0
            total_area = float(H * W)
            if top_area >= total_area * 0.35 and top_area >= 3.0 * max(second_area, 1.0):
                tmp = str(Path(os.environ.get("TEMP", ".")) / f"_detect_single_{int(time.time()*1000)}.png")
                pil.save(tmp)
                try:
                    v = vision.match_crop(tmp, topk=5)
                    matches = [
                        {
                            "name": m["name"],
                            "grid_cells": m["grid_cells"],
                            "score": m["score"],
                            "value": _catalog_value(m["name"]),
                        }
                        for m in v.get("matches", [])[:5]
                    ]
                    if matches and matches[0]["score"] >= 0.80:
                        out.append({"cell": [0, 0, W, H], "icon": [0, 0, W, H], "crop_path": tmp, "matches": matches})
                finally:
                    Path(tmp).unlink(missing_ok=True)
        # 场景2：整图以红底为主（旧回退）
        if not out:
            red_ratio = float(red_bg.mean())
            if red_ratio >= 0.03:
                tmp = str(Path(os.environ.get("TEMP", ".")) / f"_detect_single_{int(time.time()*1000)}.png")
                pil.save(tmp)
                try:
                    v = vision.match_crop(tmp, topk=5)
                    matches = [
                        {
                            "name": m["name"],
                            "grid_cells": m["grid_cells"],
                            "score": m["score"],
                            "value": _catalog_value(m["name"]),
                        }
                        for m in v.get("matches", [])[:5]
                    ]
                finally:
                    Path(tmp).unlink(missing_ok=True)
                out.append({"cell": [0, 0, W, H], "icon": [0, 0, W, H], "crop_path": tmp, "matches": matches})
    return {"ok": True, "cells": out}


@router.get("/api/vision/crop_box")
def vision_crop_box(image_path: str, box: str) -> Response:
    """按原始坐标裁剪图片区域（用于标注记录缩略图）。box = "x0,y0,x1,y1"。"""
    from PIL import Image

    p = Path(image_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    try:
        x0, y0, x1, y1 = [int(v) for v in box.split(",")]
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="box 格式错误")
    im = Image.open(p).convert("RGB").crop((x0, y0, x1, y1))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    buf.seek(0)
    return Response(content=buf.read(), media_type="image/png")


@router.get("/api/vision/annotations")
def vision_annotations(image_path: str = "") -> dict[str, Any]:
    """列出标注记录，可按图片路径过滤。"""
    with db() as conn:
        if image_path:
            rows = conn.execute(
                "SELECT * FROM vision_annotations WHERE image_path=? ORDER BY id", (image_path,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM vision_annotations ORDER BY id DESC LIMIT 200").fetchall()
    return {"annotations": [dict(r) for r in rows]}


@router.post("/api/vision/delete_learn")
def vision_delete_learn(body: schemas.LearnDeleteInput) -> dict[str, Any]:
    return vision.delete_learn_samples(body.names)


@router.post("/api/vision/delete_images")
def vision_delete_images(body: schemas.ImageDeleteInput) -> dict[str, Any]:
    return vision.delete_manifest_entries(body.paths)


@router.post("/api/vision/cleanup")
def vision_cleanup() -> dict[str, Any]:
    return vision.cleanup_orphans()


@router.post("/api/vision/trim")
def vision_trim(body: schemas.TrimInput) -> dict[str, Any]:
    return vision.trim_gallery(max(1, body.max_per_name))


@router.get("/api/vision/uploaded")
def vision_uploaded(path: str) -> FileResponse:
    # 容错：Windows 下路径可能混用反斜杠，统一转正斜杠再解析
    p = Path(path.replace("\\", "/"))
    if not p.exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    return FileResponse(str(p))


@router.post("/api/capture")
def capture_screen() -> dict[str, Any]:
    """截取《竞拍之王》游戏窗口（找不到则截全屏），返回图片路径供图像学习框选。"""
    import ctypes
    import ctypes.wintypes

    from PIL import Image, ImageGrab

    cap_dir = DATA_DIR / "captures"
    cap_dir.mkdir(parents=True, exist_ok=True)
    window = None
    window_title = ""

    def _find_game_window():
        user32 = ctypes.windll.user32
        result = []
        # 保证坐标与截取一致（物理像素）
        try:
            user32.SetProcessDPIAware()
        except Exception:  # noqa: BLE001
            pass

        def _cb(hwnd, _lparam):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buf = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buf, length + 1)
                title = buf.value
                if any(x in title for x in ("估值助手", "Edge", "Chrome", "Firefox", "浏览器", "360")):
                    return True
                if ("竞拍" in title) or ("BidKing" in title) or ("拍卖" in title):
                    if user32.IsWindowVisible(hwnd):
                        rect = ctypes.wintypes.RECT()
                        user32.GetWindowRect(hwnd, ctypes.byref(rect))
                        w = rect.right - rect.left
                        h = rect.bottom - rect.top
                        if w > 200 and h > 200:
                            result.append((title, (rect.left, rect.top, rect.right, rect.bottom), hwnd))
            return True

        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        user32.EnumWindows(WNDENUMPROC(_cb), 0)
        return result

    try:
        wins = _find_game_window()
        if wins:
            wins.sort(key=lambda x: (x[1][2] - x[1][0]) * (x[1][3] - x[1][1]), reverse=True)
            title, rect, hwnd = wins[0]
            window_title = title
            user32 = ctypes.windll.user32
            # 还原最小化窗口并调到前台，避免截到被遮挡内容
            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.4)
            r2 = ctypes.wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r2))
            window = (r2.left, r2.top, r2.right, r2.bottom)
    except Exception:  # noqa: BLE001
        window = None

    try:
        if window:
            # 裁剪到虚拟屏幕范围内
            vx = ctypes.windll.user32.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
            vy = ctypes.windll.user32.GetSystemMetrics(77)
            vw = ctypes.windll.user32.GetSystemMetrics(78)
            vh = ctypes.windll.user32.GetSystemMetrics(79)
            bbox = (
                max(window[0], vx),
                max(window[1], vy),
                min(window[2], vx + vw),
                min(window[3], vy + vh),
            )
            if bbox[2] - bbox[0] > 0 and bbox[3] - bbox[1] > 0:
                img = ImageGrab.grab(bbox=bbox)
            else:
                img = ImageGrab.grab(all_screens=True)
        else:
            img = ImageGrab.grab(all_screens=True)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"截屏失败：{e}"}

    p = cap_dir / f"{datetime.now().strftime('%H%M%S')}_{uuid4().hex[:6]}.png"
    img.convert("RGB").save(p)
    return {
        "ok": True,
        "path": str(p),
        "source": "game_window" if window else "fullscreen",
        "window_title": window_title,
    }


@router.post("/api/clipboard")
def clipboard_snip() -> dict[str, Any]:
    """读取剪贴板中的截图（Win+Shift+S 后自动在剪贴板），保存为图片供学习。"""
    import hashlib

    from PIL import Image, ImageGrab

    cap_dir = DATA_DIR / "captures"
    cap_dir.mkdir(parents=True, exist_ok=True)
    img = None
    try:
        data = ImageGrab.grabclipboard()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"读取剪贴板失败：{e}"}
    if isinstance(data, list):
        for p in data:
            if str(p).lower().endswith((".png", ".jpg", ".jpeg", ".bmp")):
                try:
                    img = Image.open(p).convert("RGB")
                    break
                except Exception:  # noqa: BLE001
                    continue
    elif isinstance(data, Image.Image):
        img = data.convert("RGB")
    if img is None:
        return {"ok": False, "error": "剪贴板中没有图片，请先按 Win+Shift+S 截图"}
    p = cap_dir / f"clip_{datetime.now().strftime('%H%M%S')}_{uuid4().hex[:6]}.png"
    img.save(p)
    h = hashlib.md5(open(p, "rb").read()).hexdigest()
    return {"ok": True, "path": str(p), "hash": h}


@router.post("/api/vision/upload")
async def vision_upload(file: UploadFile = File(...)) -> dict[str, Any]:
    from PIL import Image

    data = await file.read()
    up = DATA_DIR / "uploads"
    up.mkdir(parents=True, exist_ok=True)
    p = up / f"{uuid4().hex}.png"
    Image.open(io.BytesIO(data)).convert("RGB").save(p)
    return {"path": str(p)}


@router.post("/api/vision/upload_multi")
async def vision_upload_multi(files: list[UploadFile] = File(...)) -> dict[str, Any]:
    from PIL import Image

    up = DATA_DIR / "uploads"
    up.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    for f in files:
        data = await f.read()
        p = up / f"{uuid4().hex}.png"
        try:
            Image.open(io.BytesIO(data)).convert("RGB").save(p)
            paths.append(str(p))
        except Exception:  # noqa: BLE001
            continue
    return {"paths": paths}
