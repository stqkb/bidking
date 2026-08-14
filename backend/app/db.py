"""SQLite 数据访问层。"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator

from .config import DB_PATH, ensure_dirs


def get_conn() -> sqlite3.Connection:
    ensure_dirs()
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # WAL 模式：允许一个写者 + 多个读者并发，减少后台训练/请求间的锁竞争
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS catalog_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    grid_cells INTEGER NOT NULL,
    value REAL NOT NULL,
    current_value REAL,
    source TEXT DEFAULT 'excel'
);

CREATE TABLE IF NOT EXISTS game_records (
    game_no INTEGER PRIMARY KEY,
    grid_combo TEXT,
    red_count INTEGER,
    red_grids INTEGER,
    red_avg REAL,
    red_value REAL,
    full_value REAL,
    deal_price REAL,
    min_bid REAL,
    profit REAL,
    winner TEXT,
    items_json TEXT,
    won INTEGER
);

CREATE TABLE IF NOT EXISTS user_records (
    id TEXT PRIMARY KEY,
    game_no INTEGER,
    created_at TEXT,
    updated_at TEXT,
    inputs_json TEXT,
    prediction_json TEXT,
    bid REAL,
    actual_json TEXT,
    status TEXT DEFAULT 'draft',
    note TEXT
);

CREATE TABLE IF NOT EXISTS model_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT,
    kind TEXT,
    n_samples INTEGER,
    metrics_json TEXT
);

CREATE TABLE IF NOT EXISTS ocr_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    kind TEXT DEFAULT 'grid',
    shape TEXT,
    status TEXT DEFAULT 'pending',
    result_json TEXT,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS ocr_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    name TEXT,
    grid_cells INTEGER,
    price REAL,
    matched_name TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS vision_annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_path TEXT NOT NULL,
    box TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT,
    grid_cells INTEGER,
    value REAL,
    created_at TEXT
);
"""


def init_db() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)
        cols = [r[1] for r in conn.execute("PRAGMA table_info(catalog_items)").fetchall()]
        if "current_value" not in cols:
            conn.execute("ALTER TABLE catalog_items ADD COLUMN current_value REAL")
        gcols = [r[1] for r in conn.execute("PRAGMA table_info(game_records)").fetchall()]
        if "won" not in gcols:
            conn.execute("ALTER TABLE game_records ADD COLUMN won INTEGER")


def rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]


def json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)
