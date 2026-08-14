"""后台任务管理器。

取代原 main.py 中散落的 _bg_lock / _bg_tasks / _start_bg / _bg_retrain / _bg_cnn，
将任务去重、状态跟踪与线程执行收敛为一个可独立测试的类。
"""
from __future__ import annotations

import threading
from typing import Any, Callable


class BackgroundManager:
    """轻量后台任务管理器。

    状态约定：None=从未运行/已完成已清空，False=运行中，True=已完成。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tasks: dict[str, bool] = {}

    def start(self, name: str, fn: Callable[[], Any], force: bool = False) -> bool:
        """启动一个后台任务；同名任务运行中或已完成时默认不重复启动。

        force=True 时忽略已有状态（用于手动触发重新训练）。
        """
        with self._lock:
            if not force and self._tasks.get(name) is not None:
                return False
            self._tasks[name] = False
        threading.Thread(target=fn, daemon=True).start()
        return True

    def status(self, name: str) -> bool | None:
        """返回任务状态（None=未运行，False=运行中，True=已完成）。"""
        with self._lock:
            return self._tasks.get(name)

    def mark_done(self, name: str) -> None:
        """由任务回调在结束时调用，标记为已完成。"""
        with self._lock:
            self._tasks[name] = True


# 全局唯一实例（各路由共享）
bg = BackgroundManager()
