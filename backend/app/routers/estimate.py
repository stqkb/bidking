"""估值、ML/CNN 模型训练路由（/api/estimate、/api/model/*、/api/cnn/*）。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from .. import cnn as cnn_mod, ml, schemas
from ..core.bg import bg
from ..db import db
from ..services import estimator

router = APIRouter()


@router.post("/api/estimate")
def estimate(body: schemas.EstimateInput) -> dict[str, Any]:
    inputs = body.model_dump()
    rule = estimator.estimate(inputs, body.board)
    if "error" in rule:
        raise HTTPException(status_code=400, detail=rule["error"])
    return rule


@router.post("/api/model/retrain")
def model_retrain() -> dict[str, Any]:
    bg.start("ml", estimator.retrain_ml, force=True)
    return {"started": True}


@router.get("/api/model/status")
def model_status() -> dict[str, Any]:
    with db() as conn:
        return ml.model_status(conn)


@router.post("/api/cnn/train")
def cnn_train() -> dict[str, Any]:
    bg.start("cnn", estimator.retrain_cnn, force=True)
    return {"started": True}


@router.get("/api/cnn/status")
def cnn_status() -> dict[str, Any]:
    return cnn_mod.status()


@router.post("/api/cnn/predict")
def cnn_predict(body: schemas.CnnPredictInput) -> dict[str, Any]:
    return cnn_mod.predict_board(body.board)
