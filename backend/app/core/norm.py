"""统一名称归一化。

此前 ocr._norm_name / importers._norm_name / vision._norm 三处实现规则
高度相似但不完全一致，容易在匹配逻辑上产生隐性分歧。统一收敛到本模块。
"""
from __future__ import annotations

import re

# 覆盖三处旧实现字符集：书名号、括号、省略号、空白、连接符等干扰字符
_NORM_RE = re.compile(r"[·…\s《》（）()\-—–]")


def norm_name(s: str | None) -> str:
    """去除名称中的干扰字符，用于图鉴名称匹配。"""
    return _NORM_RE.sub("", s or "")
