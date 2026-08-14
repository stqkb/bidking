from PIL import Image, ImageDraw, ImageFont

from app import ocr as ocr_mod
from app.db import db, init_db
from app.importers import import_catalog


def test_parse_shape():
    assert ocr_mod.parse_shape("1×1") == (1, 1)
    assert ocr_mod.parse_shape("2×3") == (2, 3)
    assert ocr_mod.parse_shape("5x3") == (5, 3)
    assert ocr_mod.parse_shape("结算") is None


def test_is_price():
    assert ocr_mod._is_price("78,750")
    assert ocr_mod._is_price("123456")
    assert ocr_mod._is_price("12.5")
    assert not ocr_mod._is_price("斯翼尊享车标")


def _synthetic_grid(path, rows=3, cols=3, cell=200):
    img = Image.new("RGB", (cell * cols, cell * rows), "white")
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/simhei.ttf", 28)
    except Exception:  # noqa: BLE001
        font = ImageFont.load_default()
    for r in range(rows):
        for c in range(cols):
            x0, y0 = c * cell, r * cell
            d.rectangle([x0, y0, x0 + cell - 1, y0 + cell - 1], outline="black", width=2)
            d.text((x0 + 12, y0 + 16), f"藏品{c}{r}", fill="black", font=font)
            d.text((x0 + 12, y0 + 110), f"{100000 + r * 1000 + c * 100:,}", fill="black", font=font)
    img.save(path)


def test_ocr_grid_extraction(test_env, tmp_path):
    init_db()
    import_catalog()
    p = tmp_path / "grid.png"
    _synthetic_grid(p)
    with db() as conn:
        res = ocr_mod.process_image(conn, p, (1, 1))
    items = res["items"]
    assert len(items) >= 6, f"识别到 {len(items)} 件，预期 9"
    prices = {it["price"] for it in items}
    assert 100000 in prices and 100200 in prices and 102100 in prices
    assert all(it["grid_cells"] == 1 for it in items)


def test_ocr_scan_and_confirm(test_env, tmp_path, monkeypatch):
    import shutil

    from app.config import OCR_PROCESSED_DIR, SCAN_DIR

    init_db()
    import_catalog()
    scan = tmp_path / "截图输入"
    f1 = scan / "1×1"
    f1.mkdir(parents=True)
    _synthetic_grid(f1 / "a.png")
    monkeypatch.setattr(ocr_mod, "SCAN_DIR", scan)
    monkeypatch.setattr(ocr_mod, "OCR_PROCESSED_DIR", scan / "已处理")
    res = ocr_mod.scan_folder()
    assert res["added"] == 1
    tasks = ocr_mod.list_tasks()
    assert len(tasks) == 1 and tasks[0]["status"] == "pending"
    items = tasks[0]["result"]["items"]
    conf = ocr_mod.confirm_task(tasks[0]["id"], [
        {"name": it["name"], "price": it["price"], "grid_cells": it["grid_cells"]}
        for it in items
    ])
    assert conf["ok"] is True
    with db() as conn:
        n = conn.execute("SELECT COUNT(*) c FROM ocr_samples").fetchone()["c"]
        assert n == len(items)
    assert not (scan / "1×1" / "a.png").exists()  # 已归档
    assert (scan / "已处理" / "1×1" / "a.png").exists()


def test_confirm_overwrites_price(test_env, tmp_path, monkeypatch):
    init_db()
    import_catalog()
    scan = tmp_path / "in"
    (scan / "1×1").mkdir(parents=True)
    _synthetic_grid(scan / "1×1" / "a.png")
    monkeypatch.setattr(ocr_mod, "SCAN_DIR", scan)
    monkeypatch.setattr(ocr_mod, "OCR_PROCESSED_DIR", scan / "已处理")
    ocr_mod.scan_folder()
    tid = ocr_mod.list_tasks()[0]["id"]
    r = ocr_mod.confirm_task(tid, [{"name": "非洲之心", "price": 123, "grid_cells": 1}])
    assert r["ok"] is True and r["updated_catalog"] == 1
    with db() as conn:
        row = conn.execute(
            "SELECT value, current_value FROM catalog_items WHERE name=?", ("非洲之心",)
        ).fetchone()
        assert row["value"] == 123
        assert row["current_value"] == round(123 * 1.15)


def test_match_alias_and_price_fallback(test_env):
    from app.importers import import_games

    init_db()
    import_catalog()
    import_games()
    with db() as conn:
        # 历史对局别名：游戏显示名 -> 图鉴名
        m1 = ocr_mod._match_catalog(conn, "易行铆角硬箱", 120_800, 2)
        assert any(c["name"] == "易行铆皮箱" and not c["by_price"] for c in m1)
        # 名称对不上但 格数+价格 精确命中：轩辕号 -> 益韵珍藏盘
        m2 = ocr_mod._match_catalog(conn, "轩辕号", 69_970, 1)
        assert any(c["name"] == "益韵珍藏盘" and c["by_price"] for c in m2)


def test_single_item_pairing():
    # 单件图：名称在左上、价格在下方居中（横坐标不同列）
    boxes = [
        {"text": "翡翠观音", "conf": 0.99, "cx": 51, "cy": 17,
         "x0": 10, "y0": 10, "x1": 90, "y1": 30},
        {"text": "157,500", "conf": 0.99, "cx": 114, "cy": 187,
         "x0": 90, "y0": 175, "x1": 150, "y1": 200},
    ]
    items = ocr_mod._pair_items(boxes, 300, 300)
    assert len(items) == 1
    assert items[0]["name"] == "翡翠观音"
    assert items[0]["price"] == 157_500
