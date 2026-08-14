"""测试共用夹具：使用独立临时数据库与模型目录。"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

# 使 backend/ 可被导入
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# 必须在导入 app.* 之前设置，config 在 import 时读取环境变量
_TMP = Path(tempfile.mkdtemp(prefix="bidking_test_"))
os.environ["BIDKING_DB"] = str(_TMP / "test.db")
os.environ["BIDKING_MODELS"] = str(_TMP / "models")


@pytest.fixture(scope="session")
def test_env():
    return _TMP
