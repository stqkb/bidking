from pathlib import Path

from app.config import MD_AGGREGATE, MD_SOURCES, XLSX_SOURCE
from app.db import db, init_db
from app.importers import (
    cn_num,
    identify_item,
    import_catalog,
    import_extra_games,
    import_games,
    parse_aggregate_md,
    parse_game_info_md,
)


def test_cn_num():
    assert cn_num("一") == 1
    assert cn_num("十") == 10
    assert cn_num("十二") == 12
    assert cn_num("二十一") == 21
    assert cn_num("三十一") == 31


def test_parse_aggregate_md():
    games = parse_aggregate_md(MD_AGGREGATE)
    assert len(games) == 31
    g1 = games[1]
    assert g1["red_count"] == 5
    assert g1["red_grids"] == 11
    assert abs(g1["red_avg"] - 2.2) < 1e-6
    assert g1["full_value"] == 1_162_584
    assert g1["deal_price"] == 888_889
    g31 = games[31]
    assert g31["grid_combo"] == "6+4+4+1+2"
    assert g31["red_count"] == 5
    assert g31["profit"] == 126_501


def test_parse_game_info_md():
    games = parse_game_info_md(MD_SOURCES[0])
    assert 1 in games
    assert len(games[1]["items"]) == 5
    first = games[1]["items"][0]
    assert first["grid_cells"] == 1
    assert first["trade_price"] == 150_000
    games21 = parse_game_info_md(MD_SOURCES[2])
    assert games21[21]["items"][0]["grid_cells"] == 2
    assert games21[21]["items"][0]["trade_price"] == 114_988


def test_import_catalog(test_env):
    init_db()
    n = import_catalog(XLSX_SOURCE)
    assert n == 188
    with db() as conn:
        assert conn.execute("SELECT COUNT(*) c FROM catalog_items").fetchone()["c"] == 188


def test_import_games(test_env):
    init_db()
    n = import_games()
    assert n == 31
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM game_records WHERE game_no=16"
        ).fetchone()
        assert row["red_count"] == 2
        assert row["red_grids"] == 17


def test_identify_item(test_env):
    init_db()
    import_catalog()
    import_games()
    with db() as conn:
        # 只填格数：返回该格数全部图鉴藏品（每件仅系统价一条），按价值从低到高
        hits = identify_item(conn, 8, None)
        vals = [h["value"] for h in hits]
        assert vals == sorted(vals)
        names = [h["name"] for h in hits]
        assert len(names) == len(set(names)), "同一藏品不应重复出现"
        assert len(hits) == 3
        # 填价格：12 格 60.06 万 → 按 |价格差| 排序，优先展示最接近的目录藏品
        hits12 = identify_item(conn, 12, 600_600)
        assert any(h["name"] == "AWM枪械藏品" for h in hits12)
        diffs = [h["diff"] for h in hits12]
        assert diffs == sorted(diffs)
        # 系统价：1 格 15116522 → 非洲之心，价格差为 0
        hits2 = identify_item(conn, 1, 15_116_522)
        assert any(h["name"] == "非洲之心" and h["diff"] == 0 for h in hits2)
        # 不再返回现价（交易行价）条目：17384000 不应作为独立条目出现
        hits3 = identify_item(conn, 1, 17_384_000)
        assert not any(h["value"] == 17_384_000 for h in hits3)


def test_import_extra_games(test_env):
    init_db()
    import_catalog()
    import_games()
    # 32-43 局 12 条 + 45-51 局 6 条（47 与 46 重复被去重；37/38 与 13/27 红品相同但全场不同，保留）
    assert import_extra_games() == 18
    assert import_extra_games() == 0  # 幂等
    with db() as conn:
        total = conn.execute("SELECT COUNT(*) c FROM game_records").fetchone()["c"]
        assert total == 49
        g33 = conn.execute(
            "SELECT grid_combo, red_count FROM game_records WHERE game_no=33"
        ).fetchone()
        assert g33["grid_combo"] == "2+2+2+2+2+4"
        assert g33["red_count"] == 6
        assert conn.execute("SELECT COUNT(*) c FROM game_records WHERE game_no=47").fetchone()["c"] == 0
        assert conn.execute("SELECT COUNT(*) c FROM game_records WHERE game_no=45").fetchone()["c"] == 1
        assert conn.execute("SELECT COUNT(*) c FROM game_records WHERE game_no=37").fetchone()["c"] == 1
