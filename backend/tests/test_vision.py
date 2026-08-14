from __future__ import annotations

import json

import numpy as np
import pytest
from PIL import Image

from app import vision


@pytest.fixture
def isolated_vision(tmp_path, monkeypatch):
    monkeypatch.setattr(vision, "MANIFEST", tmp_path / "manifest.json")
    monkeypatch.setattr(vision, "CROPS_DIR", tmp_path / "crops")
    monkeypatch.setattr(vision, "FEATS_CACHE", tmp_path / "feats.npy")
    monkeypatch.setattr(vision, "FEATS_META", tmp_path / "feats.meta")
    monkeypatch.setattr(vision, "FEATS_FP", tmp_path / "feats.fp")
    monkeypatch.setattr(vision, "_MODEL_TRACE", tmp_path / "model.pt")
    vision._gallery_cache["manifest"] = None
    vision._gallery_cache["feats"] = None
    return tmp_path


def _noise_img(w=64, h=64, seed=0) -> Image.Image:
    rng = np.random.RandomState(seed)
    return Image.fromarray(rng.randint(0, 255, (h, w, 3), dtype=np.uint8))


def test_add_crop_source_learn_writes_variants(isolated_vision, tmp_path):
    e = vision.add_crop("测试物品", 0, _noise_img(seed=1), source="learn")
    assert e["source"] == "learn"
    assert e["augmented"] is True and e["variant"] is False
    m = json.loads(vision.MANIFEST.read_text(encoding="utf-8"))
    assert m[0]["source"] == "learn"
    variants = [x for x in m if x.get("variant")]
    assert 8 <= len(variants) <= 16
    assert all(x["source"] == "learn" for x in variants)


def test_add_crop_default_source_ocr(isolated_vision):
    e = vision.add_crop("默认条目", 1, _noise_img(seed=2))
    assert e["source"] == "ocr"


def test_match_crop_structure(isolated_vision):
    for i, name in enumerate(("红宝石", "蓝宝石")):
        vision.add_crop(name, 1, _noise_img(seed=10 + i))
    q_path = vision._load_manifest()[0]["path"]
    r = vision.match_crop(q_path, topk=5)
    assert r["ok"] is True
    assert isinstance(r["matches"], list) and len(r["matches"]) > 0
    for m in r["matches"]:
        assert {"name", "grid_cells", "score", "gallery"} <= set(m.keys())
        assert isinstance(m["score"], float) and 0.0 <= m["score"] <= 1.0


def test_match_crop_empty_gallery(isolated_vision):
    r = vision.match_crop("whatever.png")
    assert r["ok"] is False and r["matches"] == []


def test_stabilize_crop_fallback_none():
    q = Image.new("L", (100, 100), 0)
    t = Image.new("L", (200, 200), 0)  # 模板不小于查询 -> None
    assert vision.stabilize_crop(q, t) is None


def test_icon_crop_missing_boxes_returns_pil():
    im = Image.new("RGB", (50, 50), "white")
    assert vision._icon_crop(im, {}) is im
