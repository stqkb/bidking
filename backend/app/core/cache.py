"""轻量内存缓存：读多写少的图鉴/统计结果缓存在内存，写操作后显式失效。

不使用 TTL（避免脏数据），采用「显式失效」约定：
所有修改 catalog_items / game_records 的代码路径，都必须在写完后调用
invalidate_catalog() / invalidate_games()。漏调会导致读到旧数据，
新增写点时必须同步补失效调用。
"""
from __future__ import annotations

import threading
from typing import Any, Callable, TypeVar

T = TypeVar("T")


class _Cache:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._slots: dict[str, Any] = {}

    def get(self, key: str, loader: Callable[[], T]) -> T:
        """命中直接返回；未命中持锁执行 loader 填充并返回。"""
        with self._lock:
            if key in self._slots:
                return self._slots[key]
            val = loader()
            self._slots[key] = val
            return val

    def invalidate(self, *keys: str) -> None:
        """清空指定缓存；不传 key 时清空全部。"""
        with self._lock:
            if not keys:
                self._slots.clear()
            else:
                for k in keys:
                    self._slots.pop(k, None)


_cache = _Cache()

# 缓存 key
KEY_CATALOG_ROWS = "catalog_rows"      # catalog_items 全表（匹配服务用）
KEY_CATALOG_INDEX = "catalog_index"    # 按归一化名称索引的图鉴（匹配服务用，避免每次匹配重复归一化）
KEY_ALIAS_MAP = "alias_map"            # 图鉴别名映射（匹配服务用）
KEY_CATALOG_STATS = "catalog_stats"    # 按格数统计（估值引擎用）
KEY_BLENDED_STATS = "blended_stats"    # 截尾均值统计（估值引擎用）
KEY_COUNT_PRIOR = "count_prior"        # 红品件数先验（估值引擎用）
KEY_FULL_RATIO = "full_ratio"          # 全场/红品价值倍率（估值引擎用）


def invalidate_catalog() -> None:
    """图鉴数据变化后调用：导入 Excel、删除藏品、OCR 确认新增/覆盖价格。"""
    _cache.invalidate(KEY_CATALOG_ROWS, KEY_CATALOG_INDEX, KEY_CATALOG_STATS, KEY_BLENDED_STATS)


def invalidate_games() -> None:
    """对局数据变化后调用：导入对局、确认归档、保存汇总。"""
    _cache.invalidate(KEY_ALIAS_MAP, KEY_COUNT_PRIOR, KEY_FULL_RATIO)


def invalidate_all() -> None:
    """全部缓存失效（如测试环境切换）。"""
    _cache.invalidate()
