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
