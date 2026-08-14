"""全局路径与常量配置。"""
from __future__ import annotations

import os
from pathlib import Path

# backend/app/config.py -> backend -> 项目根
BASE_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = BASE_DIR / "data"
MODELS_DIR = Path(os.environ.get("BIDKING_MODELS", str(DATA_DIR / "models")))
SYNTH_DIR = DATA_DIR / "synthetic"
DB_PATH = Path(os.environ.get("BIDKING_DB", str(DATA_DIR / "bidking.db")))

# 用户数据源（只读）
SOURCE_DIR = BASE_DIR / "对局数据"
XLSX_SOURCE = SOURCE_DIR / "红色品质物品汇总表(原价版).xlsx"
MD_SOURCES = [
    SOURCE_DIR / "1-10局信息.md",
    SOURCE_DIR / "11-20局信息.md",
    SOURCE_DIR / "21-30局信息.md",
]
MD_AGGREGATE = SOURCE_DIR / "平均格数归类整理.md"
EXTRA_MD_FILES = [
    SOURCE_DIR / "32-43局.md",
    SOURCE_DIR / "45-51局.md",
]

# 规则引擎默认单格价（可调）
DEFAULT_PRICES = {
    "v_wg": 100.0,   # 白绿
    "v_b": 800.0,    # 蓝
    "v_p": 2000.0,   # 紫
    "v_g": 10000.0,  # 金
}

# 出价安全系数：推荐出价 = 保守下限(p10) × 安全系数
# 0.85 = 在 p10 下限基础上再留 15% 利润空间，即使最坏情况也不亏
# 旧版 0.84 是"期望价值 × margin"，因估值误差 27-41% 导致赢家诅咒，已废弃
DEFAULT_MARGIN = 0.85

# 不建议出价的不确定性阈值：p10/ev 低于此值说明估值太不可靠
BID_UNCERTAINTY_THRESHOLD = 0.35

# 全仓/红品价值比例兜底（导入数据后按实际均值覆盖）
DEFAULT_FULL_RATIO = 1.36

# 红品反推参数
MAX_RED_GRIDS = 50
MAX_RED_COUNT = 80

# CNN
CNN_BOARD = 16
CNN_EPOCHS = 8
CNN_SYNTH_N = 40000
CNN_BATCH = 256

# OCR 扫描目录
SCAN_DIR = BASE_DIR / "截图输入"
OCR_PROCESSED_DIR = SCAN_DIR / "已处理"
OCR_FAILED_DIR = SCAN_DIR / "失败"
AUCTION_DIR = BASE_DIR / "拍卖结果图"
AUCTION_DONE_DIR = AUCTION_DIR / "已处理"
CROPS_DIR = DATA_DIR / "crops"


def ensure_dirs() -> None:
    for d in (DATA_DIR, MODELS_DIR, SYNTH_DIR):
        d.mkdir(parents=True, exist_ok=True)
