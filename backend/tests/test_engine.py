import pytest

from app.db import db, init_db
from app.engine import (
    calibration_factor,
    count_compositions,
    find_candidates,
    get_catalog_stats,
    risk_level,
    run_estimate,
)
from app.importers import import_catalog, import_games


def _setup():
    init_db()
    import_catalog()
    import_games()


def test_find_candidates():
    assert (11, 5) in find_candidates(2.2)
    assert (14, 5) in find_candidates(2.8)
    assert (13, 10) in find_candidates(1.3)  # 精确 1.30
    assert (4, 3) in find_candidates(1.3, tol=0.05)
    assert (6, 3) in find_candidates(2.0)
    assert (4, 4) in find_candidates(1.0)


def test_count_compositions():
    # 4 格 2 件：1+3 / 3+1 / 2+2
    assert count_compositions(4, 2, (1, 2, 3, 4, 6, 8, 9, 12, 15, 16)) == 3
    assert count_compositions(11, 5, (1, 2, 3, 4, 6, 8, 9, 12, 15, 16)) > 0
    assert count_compositions(5, 3, (2, 4)) == 0


def test_calibration_factor():
    stats = {1: {"mean": 100.0}}
    assert calibration_factor(stats, 1, 50.0) == 1.0  # 默认关闭校准
    assert calibration_factor(stats, 1, 1000.0) == 1.0
    assert calibration_factor(stats, 1, 50.0, blend=0.4) == pytest.approx(0.8)
    assert calibration_factor(stats, 1, 1000.0, blend=0.4) == pytest.approx(1.4)
    assert calibration_factor(stats, 1, 130.0, blend=0.4) == pytest.approx(1.12)
    assert calibration_factor(stats, None, 100.0) == 1.0


def test_risk_level():
    assert risk_level({"p10": 90, "p50": 100, "p90": 110})[0] == "低"
    assert risk_level({"p10": 40, "p50": 100, "p90": 200})[0] == "中"
    assert risk_level({"p10": 40, "p50": 100, "p90": 400})[0] == "高"


def test_run_estimate_basic(test_env):
    _setup()
    with db() as conn:
        stats = get_catalog_stats(conn)
        assert 1 in stats
        result = run_estimate(conn, {"red_avg": 2.2, "margin": 0.84})
    assert "error" not in result
    assert result["red"]["ev"] > 0
    assert result["red"]["p10"] <= result["red"]["p50"] <= result["red"]["p90"]
    assert result["full"]["ev"] > result["red"]["ev"]
    assert result["bid"]["recommended"] == pytest.approx(result["full"]["ev"] * 0.84)
    assert result["bid"]["risk"] in ("低", "中", "高")
    assert any(c["red_grids"] == 11 and c["red_count"] == 5 for c in result["candidates"])


def test_run_estimate_known_item(test_env):
    _setup()
    with db() as conn:
        result = run_estimate(conn, {"red_avg": 2.2, "known_size": 1, "known_value": 1_500_000})
    # 校准默认关闭（测试集验证开校准会放大误差）
    assert result["calibration"]["factor"] == 1.0
    assert result["warnings"]


def test_run_estimate_known_size_in_compositions(test_env):
    _setup()
    with db() as conn:
        result = run_estimate(conn, {"red_avg": 2.2, "known_size": 8, "known_value": 900_000})
    assert "error" not in result
    assert result["candidates"], "应至少保留一个候选"
    for cand in result["candidates"]:
        assert cand["red_grids"] >= 8
        assert cand.get("compositions"), "每个候选都应给出组合样例"
        for comp in cand["compositions"][:3]:
            assert 8 in comp, f"{cand['red_grids']}格/{cand['red_count']}件的组合 {comp} 缺少已知的 8 格红品"
    # 均格 2.2 下 9 格/4 件、11 格/5 件无法容纳 8 格红品，应被过滤
    assert not any(c["red_grids"] in (9, 11) for c in result["candidates"])


def test_run_estimate_multi_known_items(test_env):
    _setup()
    with db() as conn:
        result = run_estimate(
            conn,
            {
                "red_avg": 2.2,
                "known_items": [
                    {"name": "红A", "size": 8, "value": 900_000},
                    {"name": "红B", "size": 2, "value": 120_000},
                ],
            },
        )
    assert "error" not in result
    assert result["known"]["count"] == 2
    assert result["known"]["sizes"] == [8, 2]
    assert result["known"]["value_total"] == 1_020_000
    for cand in result["candidates"]:
        assert cand["red_grids"] >= 10
        assert cand.get("compositions"), "每个候选都应给出组合样例"
        for comp in cand["compositions"][:3]:
            assert comp.count(8) >= 1, f"组合 {comp} 缺少已知 8 格红品"
            assert comp.count(2) >= 1, f"组合 {comp} 缺少已知 2 格红品"
        assert cand["estimate"]["remaining_ev"] > 0


def test_known_value_counts_into_estimate(test_env):
    _setup()
    with db() as conn:
        result = run_estimate(
            conn,
            {"red_avg": 4.5, "known_items": [{"name": "越王勾践剑", "size": 8, "value": 1_280_000}]},
        )
    assert "error" not in result
    for cand in result["candidates"]:
        assert cand["estimate"]["ev"] >= 1_280_000, (
            f"{cand['red_grids']}格/{cand['red_count']}件的期望 {cand['estimate']['ev']:,.0f} "
            "低于已知 8 格红品的价值 1,280,000"
        )


def test_run_estimate_errors(test_env):
    _setup()
    with db() as conn:
        assert "error" in run_estimate(conn, {})
        assert "error" in run_estimate(conn, {"red_avg": 99})
