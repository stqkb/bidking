"""Excel 图鉴与对局 md 数据导入。"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import openpyxl

from .config import EXTRA_MD_FILES, MD_AGGREGATE, MD_SOURCES, XLSX_SOURCE
from .db import db, json_dumps

_CN_DIGITS = {"零": 0, "一": 1, "二": 2, "三": 3, "四": 4,
              "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def cn_num(s: str) -> int | None:
    """中文数字(1-99)转 int，如 '十二' -> 12, '三十一' -> 31。"""
    s = s.strip()
    if not s:
        return None
    if "十" in s:
        head, _, tail = s.partition("十")
        tens = _CN_DIGITS.get(head, 1)
        ones = _CN_DIGITS.get(tail, 0)
        return tens * 10 + ones
    return _CN_DIGITS.get(s)


def parse_num(v: Any) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    m = re.match(r"^([-+]?[\d,]+(?:\.\d+)?)", s)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", ""))
    except ValueError:
        return None


def _norm_label(s: str) -> str:
    return re.sub(r"[（(].*?[)）]", "", s).replace(" ", "").replace("：", "")


_LABEL_MAP = {
    "红色藏品个数": "red_count",
    "占用总格数": "red_grids",
    "平均格数": "red_avg",
    "红色藏品价值合计": "red_value",
    "红色藏品系统价格合计": "red_value",
    "已揭示全场总价值": "full_value",
    "全场总价值": "full_value",
    "本场成交价": "deal_price",
    "成交价": "deal_price",
    "最低出价": "min_bid",
    "收益": "profit",
    "得主": "winner",
    "格数组合": "grid_combo",
}


def _parse_kv_rows(rows: list[list[str]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for row in rows:
        if len(row) < 2:
            continue
        label = _norm_label(row[0])
        key = _LABEL_MAP.get(label)
        if key is None:
            continue
        val = row[1].strip()
        if key in ("red_count", "red_grids"):
            n = parse_num(val)
            out[key] = int(n) if n is not None else None
        elif key in ("red_avg", "red_value", "full_value", "deal_price",
                     "min_bid", "profit"):
            out[key] = parse_num(val)
        elif key == "grid_combo":
            out[key] = val
        else:
            out[key] = val if val and val != "—" and val != "-" else None
    return out


def _split_table_rows(lines: list[str], start: int) -> tuple[list[list[str]], int]:
    """从 start 起解析连续表格行，返回 (单元格行列表, 结束下标)。"""
    rows: list[list[str]] = []
    i = start
    while i < len(lines) and lines[i].strip().startswith("|"):
        cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
        rows.append(cells)
        i += 1
    return rows, i


def _section_blocks(lines: list[str]) -> list[tuple[int, str, int]]:
    """返回 [(section_start, 局号中文名, section_end)]，匹配 '第X局' 标题。"""
    blocks: list[tuple[int, str, int]] = []
    pat = re.compile(r"^#{2,3}\s*(第(\d+|[一二三四五六七八九十]+)局)")
    for i, line in enumerate(lines):
        m = pat.match(line.strip())
        if m:
            blocks.append((i, m.group(2), len(lines)))
    for idx in range(len(blocks) - 1):
        blocks[idx] = (blocks[idx][0], blocks[idx][1], blocks[idx + 1][0])
    return blocks


def parse_aggregate_md(path: Path) -> dict[int, dict[str, Any]]:
    """解析 平均格数归类整理.md 的各局聚合数据。"""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    games: dict[int, dict[str, Any]] = {}
    for start, title, end in _section_blocks(lines):
        no = int(title) if title.isdigit() else cn_num(title)
        if no is None:
            continue
        rows: list[list[str]] = []
        i = start
        while i < end:
            if lines[i].strip().startswith("|"):
                table, i = _split_table_rows(lines, i)
                # 两张列(项目/数据)的表才是聚合表
                if table and len(table[0]) >= 2 and len(table[0]) <= 3:
                    kv = _parse_kv_rows(table)
                    if kv.get("red_count") is not None or kv.get("red_avg") is not None:
                        games[no] = {**games.get(no, {}), **kv}
            else:
                i += 1
    return games


def parse_game_info_md(path: Path) -> dict[int, dict[str, Any]]:
    """解析 1-10/11-20/21-30局信息.md，提取每局条目列表与聚合。"""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    games: dict[int, dict[str, Any]] = {}
    for start, title, end in _section_blocks(lines):
        no = int(title) if title.isdigit() else cn_num(title)
        if no is None:
            continue
        items: list[dict[str, Any]] = []
        agg: dict[str, Any] = {}
        i = start
        while i < end:
            if lines[i].strip().startswith("|"):
                table, i = _split_table_rows(lines, i)
                if not table:
                    continue
                header = table[0]
                # 只认「序号」开头的条目表；总汇总表（首列「局」）不解析为条目
                if len(header) >= 5 and header[0].strip() == "序号" and any(
                    "藏品" in h or "物品" in h for h in header
                ):
                    for row in table[1:]:
                        if len(row) < 5 or not re.match(r"^\d+$", row[0].strip()):
                            continue
                        item: dict[str, Any] = {
                            "name": row[1],
                            "doc_name": row[2] if len(row) > 2 else "",
                            "category": row[3] if len(row) > 3 else "",
                            "grid_cells": parse_num(row[4]),
                        }
                        prices = [parse_num(c) for c in row[5:]]
                        prices = [p for p in prices if p is not None]
                        if prices:
                            item["sys_price"] = prices[0] if len(prices) > 1 else None
                            item["trade_price"] = prices[-1]
                        items.append(item)
                else:
                    kv = _parse_kv_rows(table)
                    if kv:
                        agg.update(kv)
            else:
                i += 1
        games[no] = {"items": items, **agg}
    return games


def import_catalog(xlsx_path: Path | None = None) -> int:
    """导入红色图鉴 Excel，返回导入条数。"""
    path = xlsx_path or XLSX_SOURCE
    if not path.exists():
        return 0
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    next(rows, None)  # 表头
    items = []
    for r in rows:
        name = r[1]
        if name is None:
            continue
        cells = parse_num(r[2])
        value = parse_num(r[3])
        current = parse_num(r[5]) if len(r) > 5 else None
        if cells is None or value is None:
            continue
        items.append((str(name).strip(), int(cells), value, current))
    wb.close()
    with db() as conn:
        conn.execute("DELETE FROM catalog_items")
        conn.executemany(
            "INSERT INTO catalog_items(name, grid_cells, value, current_value, source) VALUES (?,?,?,?,'excel')",
            items,
        )
    return len(items)


def import_games() -> int:
    """导入 31 局对局数据，返回局数。聚合以 平均格数归类整理.md 为准。"""
    games = parse_aggregate_md(MD_AGGREGATE)
    for md in MD_SOURCES:
        if md.exists():
            info = parse_game_info_md(md)
            for no, data in info.items():
                if no in games:
                    games[no]["items"] = data.get("items", [])
    with db() as conn:
        conn.execute("DELETE FROM game_records")
        for no in sorted(games):
            g = games[no]
            items = g.get("items", [])
            conn.execute(
                """INSERT INTO game_records
                   (game_no, grid_combo, red_count, red_grids, red_avg, red_value,
                    full_value, deal_price, min_bid, profit, winner, items_json)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    no,
                    g.get("grid_combo"),
                    g.get("red_count"),
                    g.get("red_grids"),
                    g.get("red_avg"),
                    g.get("red_value"),
                    g.get("full_value"),
                    g.get("deal_price"),
                    g.get("min_bid"),
                    g.get("profit"),
                    g.get("winner"),
                    json_dumps(items),
                ),
            )
    return len(games)


def _norm_name(s: str) -> str:
    return re.sub(r"[《》（）()·\s\-—–]", "", s or "")


def import_all_if_empty() -> dict[str, int]:
    """启动时自动导入：库为空才导入。返回 {catalog, games} 导入数量。"""
    with db() as conn:
        n_cat = conn.execute("SELECT COUNT(*) c FROM catalog_items").fetchone()["c"]
        n_games = conn.execute("SELECT COUNT(*) c FROM game_records").fetchone()["c"]
    cat_imported = import_catalog() if n_cat == 0 else 0
    games_imported = import_games() if n_games == 0 else 0
    return {"catalog": cat_imported, "games": games_imported}


def _game_signature(g: dict) -> tuple:
    items = g.get("items") or []
    return (
        round(g.get("red_avg"), 6) if g.get("red_avg") is not None else None,
        g.get("red_grids"),
        g.get("red_count"),
        g.get("red_value"),
        g.get("full_value"),
        g.get("deal_price"),
        tuple(sorted((it.get("name"), int(it.get("grid_cells") or 0)) for it in items)),
    )


def import_extra_games(paths: list[Path] | None = None) -> int:
    """导入补充对局（32-43局.md / 45-51局.md），局号 + 内容双重去重，可重复执行。"""
    paths = paths if paths is not None else EXTRA_MD_FILES
    n = 0
    with db() as conn:
        existing = {
            r["game_no"] for r in conn.execute("SELECT game_no FROM game_records").fetchall()
        }
        sigs = set()
        for r in conn.execute(
            "SELECT red_avg, red_grids, red_count, red_value, items_json FROM game_records"
        ).fetchall():
            g = dict(r)
            g["items"] = json.loads(r["items_json"] or "[]")
            sigs.add(_game_signature(g))
        for path in paths:
            if not path.exists():
                continue
            games = parse_game_info_md(path)
            for no in sorted(games):
                if no in existing:
                    continue
                g = games[no]
                if _game_signature(g) in sigs:
                    continue  # 内容完全相同的重复局（如 46/47）
                items = g.get("items") or []
                combo = (
                    "+".join(str(int(it["grid_cells"])) for it in sorted(items, key=lambda x: x["grid_cells"]))
                    if items else None
                )
                conn.execute(
                    """INSERT INTO game_records
                       (game_no, grid_combo, red_count, red_grids, red_avg, red_value,
                        full_value, deal_price, min_bid, profit, winner, items_json)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        no,
                        combo,
                        g.get("red_count"),
                        g.get("red_grids"),
                        g.get("red_avg"),
                        g.get("red_value"),
                        g.get("full_value"),
                        g.get("deal_price"),
                        g.get("min_bid"),
                        g.get("profit"),
                        g.get("winner"),
                        json_dumps(items),
                    ),
                )
                existing.add(no)
                sigs.add(_game_signature(g))
                n += 1
    return n


def identify_item(
    conn,
    grid_cells: int,
    price: float | None = None,
    limit: int = 30,
) -> list[dict]:
    """按格数识别红色藏品：
    - 只填格数：返回该格数全部图鉴藏品，按价值从低到高展示；
    - 填了价格：返回该格数全部图鉴藏品，按 |价格差| 从小到大优先展示（无 ±2% 过滤）。
    """
    results: list[dict] = []
    seen: set[tuple] = set()

    def add(name: str, grid: int, val: float | None, cur: float | None,
            source: str, match: str) -> None:
        if val is None:
            return
        key = (name, grid, round(val, 0))
        if key in seen:
            return
        seen.add(key)
        results.append({
            "name": name, "grid_cells": grid,
            "value": val, "current_value": cur,
            "source": source, "match": match,
            "diff": abs(val - price) if price is not None else 0.0,
        })

    for r in conn.execute(
        "SELECT name, grid_cells, value, current_value FROM catalog_items WHERE grid_cells=?"
    , (int(grid_cells),)).fetchall():
        v = r["value"]
        if v is None:
            continue
        if price is None:
            add(r["name"], r["grid_cells"], v, None, "图鉴", "")
        else:
            diff = abs(v - float(price))
            pct = diff / max(float(price), 1.0) * 100
            add(
                r["name"], r["grid_cells"], v, None,
                "图鉴", f"差 {diff:,.0f}（{pct:.1f}%）",
            )

    if price is not None:
        results.sort(key=lambda d: d["diff"])
    else:
        results.sort(key=lambda d: d["value"])
    return results[:limit]
