from app.db import db, init_db
from app.importers import import_catalog, import_games
from app.ml import build_dataset, model_status, predict, retrain


def _setup():
    init_db()
    import_catalog()
    import_games()


def test_build_dataset(test_env):
    _setup()
    with db() as conn:
        feats, y_red, y_full = build_dataset(conn)
    assert len(feats) == 31
    assert all(f["red_avg"] > 0 for f in feats)
    assert len(y_red) == len(y_full) == 31


def test_retrain_and_predict(test_env):
    _setup()
    with db() as conn:
        res = retrain(conn)
    assert res["ok"] is True
    assert res["n"] == 31
    assert "loocv" in res and "chrono" in res
    assert res["loocv"]["coverage_pct"] >= 0
    with db() as conn:
        st = model_status(conn)
    assert st["trained"] is True
    with db() as conn:
        rule = {
            "candidates": [{"red_grids": 11, "red_count": 5}],
            "red": {"ev": 900_000.0},
            "full": {"ev": 1_220_000.0},
        }
        inputs = {"red_avg": 2.2, "red_count": 5, "red_grids": 11,
                  "known_size": 1, "known_value": 150_000}
        p = predict(conn, inputs, rule)
    assert p["available"] is True
    assert p["full"]["ev"] > 0
    assert p["full"]["p10"] <= p["full"]["p50"] <= p["full"]["p90"]
