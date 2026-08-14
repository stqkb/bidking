"""棋盘布局 CNN：合成数据预训练 + 真实对局校准（辅助估值模块）。"""
from __future__ import annotations

import json
import math
from collections import Counter
from datetime import datetime
from typing import Any

import joblib
import numpy as np

from .config import CNN_BOARD, CNN_EPOCHS, CNN_SYNTH_N, CNN_BATCH, MODELS_DIR

try:
    import torch
    import torch.nn as nn
    TORCH_OK = True
except Exception:  # pragma: no cover
    TORCH_OK = False

MODEL_PATH = MODELS_DIR / "cnn.joblib"


def _factor_pairs(s: int) -> list[tuple[int, int]]:
    pairs = []
    for h in range(1, min(s, CNN_BOARD) + 1):
        if s % h == 0:
            w = s // h
            if 1 <= w <= CNN_BOARD:
                pairs.append((h, w))
    return pairs


def _place(board: np.ndarray, h: int, w: int, rng) -> bool:
    for _ in range(60):
        r = rng.integers(0, CNN_BOARD - h + 1)
        c = rng.integers(0, CNN_BOARD - w + 1)
        if not board[r:r + h, c:c + w].any():
            board[r:r + h, c:c + w] = 1.0
            return True
    return False


def _render_combo(sizes: list[int], seed: int = 0, ordered: bool = False) -> np.ndarray:
    board = np.zeros((CNN_BOARD, CNN_BOARD), dtype=np.float32)
    rng = np.random.default_rng(seed)
    for s in sizes:
        pairs = _factor_pairs(int(s))
        if not pairs:
            continue
        h, w = pairs[int(rng.integers(0, len(pairs)))]
        if not ordered:
            _place(board, h, w, rng)
    return board


def _render_ordered(sizes: list[int]) -> np.ndarray:
    """真实对局校准用：按大小降序、逐行贪心摆放。"""
    board = np.zeros((CNN_BOARD, CNN_BOARD), dtype=np.float32)
    row = 0
    col = 0
    for s in sorted(sizes, reverse=True):
        pairs = sorted(_factor_pairs(int(s)), key=lambda p: abs(p[0] - p[1]))
        h, w = pairs[0] if pairs else (1, int(s))
        placed = False
        for _ in range(CNN_BOARD * 4):
            if col + w <= CNN_BOARD and not board[row:row + h, col:col + w].any():
                board[row:row + h, col:col + w] = 1.0
                col += w
                placed = True
                break
            col = 0
            row += 1
            if row + h > CNN_BOARD:
                break
        if not placed:
            continue
    return board


def synth_dataset(conn, n: int = CNN_SYNTH_N) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    items = conn.execute("SELECT grid_cells, value FROM catalog_items WHERE value > 0").fetchall()
    if not items:
        return np.zeros((0, 1, CNN_BOARD, CNN_BOARD)), np.zeros(0), np.zeros(0)
    cells = np.asarray([r["grid_cells"] for r in items], dtype=int)
    values = np.asarray([float(r["value"]) for r in items], dtype=float)
    cnt_rows = conn.execute("SELECT red_count FROM game_records WHERE red_count > 0").fetchall()
    if cnt_rows:
        counts = [int(r["red_count"]) for r in cnt_rows]
        c = Counter(counts)
        pool_b = list(c.elements())
    else:
        pool_b = [1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 5, 5, 6, 7]
    rng = np.random.default_rng(2026)
    X = np.zeros((n, 1, CNN_BOARD, CNN_BOARD), dtype=np.float32)
    yv = np.zeros(n, dtype=np.float32)
    yc = np.zeros(n, dtype=np.float32)
    idx = np.arange(len(cells))
    for i in range(n):
        b = pool_b[int(rng.integers(0, len(pool_b)))]
        pick = rng.choice(idx, size=min(b, len(idx)), replace=True)
        board = np.zeros((CNN_BOARD, CNN_BOARD), dtype=np.float32)
        total = 0.0
        placed = 0
        for p in pick:
            pairs = _factor_pairs(int(cells[p]))
            if not pairs:
                continue
            h, w = pairs[int(rng.integers(0, len(pairs)))]
            if _place(board, h, w, rng):
                total += float(values[p])
                placed += 1
        X[i, 0] = board
        yv[i] = math.log(total) if total > 0 else 0.0
        yc[i] = placed / 16.0
    return X, yv, yc


class _Net(nn.Module):
    def __init__(self):
        super().__init__()
        self.body = nn.Sequential(
            nn.Conv2d(1, 16, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
            nn.Conv2d(16, 32, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
            nn.Conv2d(32, 64, 3, padding=1), nn.ReLU(),
        )
        self.head = nn.Sequential(
            nn.Flatten(),
            nn.Linear(64 * 4 * 4, 128), nn.ReLU(),
            nn.Linear(128, 2),
        )

    def forward(self, x):
        return self.head(self.body(x))


def _calibrate_on_games(conn, model) -> dict[str, Any]:
    rows = conn.execute(
        "SELECT grid_combo, red_value FROM game_records WHERE grid_combo IS NOT NULL AND red_value > 0"
    ).fetchall()
    if len(rows) < 3:
        return {"ok": False, "n": len(rows), "error": "真实对局不足，跳过校准"}
    model.eval()
    preds, actuals = [], []
    with torch.no_grad():
        for r in rows:
            sizes = [int(x) for x in str(r["grid_combo"]).split("+")]
            board = _render_ordered(sizes)
            x = torch.from_numpy(board[None, None]).float()
            out = model(x)[0, 0].item()
            preds.append(out)
            actuals.append(math.log(float(r["red_value"])))
    slope, intercept = np.polyfit(preds, actuals, 1)
    return {
        "ok": True,
        "n": len(rows),
        "slope": float(slope),
        "intercept": float(intercept),
        "corr": float(np.corrcoef(preds, actuals)[0, 1]),
    }


def train(conn) -> dict[str, Any]:
    if not TORCH_OK:
        return {"ok": False, "error": "PyTorch 未安装，CNN 模块不可用"}
    device = "cuda" if torch.cuda.is_available() else "cpu"
    X, yv, yc = synth_dataset(conn)
    n = len(X)
    if n == 0:
        return {"ok": False, "error": "无图鉴数据，无法生成合成布局"}
    split = int(n * 0.9)
    Xtr = torch.from_numpy(X[:split]).float().to(device)
    ytr = torch.stack([
        torch.from_numpy(yv[:split]).float(),
        torch.from_numpy(yc[:split]).float(),
    ], dim=1).to(device)
    Xte = torch.from_numpy(X[split:]).float().to(device)
    yte = torch.stack([
        torch.from_numpy(yv[split:]).float(),
        torch.from_numpy(yc[split:]).float(),
    ], dim=1).to(device)
    model = _Net().to(device)
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = nn.MSELoss()
    steps = (len(Xtr) + CNN_BATCH - 1) // CNN_BATCH
    for epoch in range(CNN_EPOCHS):
        perm = torch.randperm(len(Xtr))
        total_loss = 0.0
        for s in range(steps):
            idx = perm[s * CNN_BATCH:(s + 1) * CNN_BATCH]
            xb, yb = Xtr[idx], ytr[idx]
            opt.zero_grad()
            loss = loss_fn(model(xb), yb)
            loss.backward()
            opt.step()
            total_loss += loss.item() * len(idx)
        epoch_loss = total_loss / len(Xtr)
    model.eval()
    with torch.no_grad():
        te_loss = float(loss_fn(model(Xte), yte))
    model.cpu()
    calib = _calibrate_on_games(conn, model)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(
        {"model": model, "calib": calib, "trained_at": datetime.now().isoformat(timespec="seconds"),
         "n_synth": n, "epochs": CNN_EPOCHS, "te_loss": te_loss},
        MODEL_PATH,
    )
    return {
        "ok": True, "n_synth": n, "epochs": CNN_EPOCHS,
        "te_loss": te_loss, "calib": calib,
        "trained_at": datetime.now().isoformat(timespec="seconds"),
    }


def status() -> dict[str, Any]:
    payload = _load()
    if payload is None:
        return {"trained": False, "torch": TORCH_OK}
    return {
        "trained": True,
        "torch": TORCH_OK,
        "n_synth": payload["n_synth"],
        "epochs": payload["epochs"],
        "te_loss": payload["te_loss"],
        "calib": payload["calib"],
        "trained_at": payload["trained_at"],
    }


def _load() -> dict[str, Any] | None:
    if not MODEL_PATH.exists():
        return None
    try:
        return joblib.load(MODEL_PATH)
    except Exception:
        return None


def predict_board(board: list[list[int]]) -> dict[str, Any]:
    payload = _load()
    if payload is None or not TORCH_OK:
        return {"ok": False, "error": "CNN 未训练，请先在「棋盘CNN」页训练"}
    arr = np.asarray(board, dtype=np.float32)
    if arr.shape != (CNN_BOARD, CNN_BOARD):
        return {"ok": False, "error": f"棋盘尺寸须为 {CNN_BOARD}x{CNN_BOARD}"}
    model = payload["model"]
    model.eval()
    with torch.no_grad():
        out = model(torch.from_numpy(arr[None, None]).float())[0]
    raw_log = float(out[0].item())
    count = float(out[1].item()) * 16.0
    calib = payload.get("calib") or {}
    if calib.get("ok"):
        value = math.exp(calib["slope"] * raw_log + calib["intercept"])
        return {"ok": True, "value": value, "count": round(count, 1),
                "raw_log": raw_log, "calibrated": True}
    return {"ok": True, "value": math.exp(raw_log), "count": round(count, 1),
            "calibrated": False}
