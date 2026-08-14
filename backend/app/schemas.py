"""Pydantic 请求模型。"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class KnownItem(BaseModel):
    name: Optional[str] = None
    size: Optional[int] = Field(None, ge=1)
    value: Optional[float] = Field(None, gt=0)


class EstimateInput(BaseModel):
    red_avg: float = Field(..., gt=0, le=50, description="红品平均格数")
    red_count_est: Optional[int] = Field(None, ge=1, le=80)
    red_count: Optional[int] = Field(None, ge=1, le=80)
    red_grids: Optional[int] = Field(None, ge=1, le=50)
    selected_red_grids: Optional[int] = Field(None, ge=1, le=50, description="锁定候选总格数")
    selected_red_count: Optional[int] = Field(None, ge=1, le=80, description="锁定候选件数")
    known_name: Optional[str] = None
    known_size: Optional[int] = Field(None, ge=1)
    known_value: Optional[float] = Field(None, gt=0)
    known_items: Optional[list[KnownItem]] = None
    total_grids: Optional[int] = Field(None, ge=1)
    blue_grids: Optional[int] = Field(None, ge=0)
    wg_grids: Optional[int] = Field(None, ge=0)
    purple_grids: Optional[int] = Field(None, ge=0)
    gold_grids: Optional[int] = Field(None, ge=0)
    min_bid: Optional[float] = Field(None, ge=0)
    margin: float = Field(0.84, gt=0, le=1)
    use_calibration: bool = True
    board: Optional[list[list[int]]] = None


class RecordCreate(BaseModel):
    game_no: Optional[int] = None
    inputs: dict[str, Any] = {}
    prediction: Optional[dict[str, Any]] = None
    bid: Optional[float] = None
    status: str = "draft"
    note: Optional[str] = None


class RecordUpdate(BaseModel):
    bid: Optional[float] = None
    status: Optional[str] = None
    note: Optional[str] = None
    actual: Optional[dict[str, Any]] = None


class CnnPredictInput(BaseModel):
    board: list[list[int]]


# ---- 以下模型原内联在 main.py 路由文件中，重构时统一收敛到 schemas.py ----


class IdentifyInput(BaseModel):
    grid_cells: int
    price: Optional[float] = None


class ImportBody(BaseModel):
    path: Optional[str] = None


class OcrConfirmInput(BaseModel):
    items: list[dict[str, Any]] = []
    settlement: dict[str, Any] = {}


class OcrProcessCaptureInput(BaseModel):
    path: str


class OcrRecognizeMultiInput(BaseModel):
    paths: list[str]


class SummaryItemInput(BaseModel):
    name: str
    grid_cells: int = 0
    value: float = 0


class SaveSummaryInput(BaseModel):
    items: list[SummaryItemInput] = []
    settlement: dict[str, Any] = {}
    won: bool = False  # 是否本人竞拍成功（用于收益规律统计）


class GamePatchInput(BaseModel):
    won: bool | None = None  # 本人是否竞拍成功
    total_value: float | None = None  # 总价值（可选修改，改动后重算收益核验）
    deal_price: float | None = None  # 成交价
    profit: float | None = None  # 收益/盈亏


class CatalogDeleteInput(BaseModel):
    ids: list[int] = []


class LearnInput(BaseModel):
    image_path: str
    box: list[int]
    name: str
    grid_cells: int = 0


class AnnotateInput(BaseModel):
    image_path: str
    box: list[int]
    kind: str  # "red" | "total" | "deal" | "profit"
    name: str = ""
    grid_cells: int = 0
    value: Optional[float] = None


class OcrBoxInput(BaseModel):
    image_path: str
    box: list[int]


class ImagePathInput(BaseModel):
    image_path: str


class LearnDeleteInput(BaseModel):
    names: list[str] = []


class ImageDeleteInput(BaseModel):
    paths: list[str] = []


class TrimInput(BaseModel):
    max_per_name: int = 5
