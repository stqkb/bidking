# 竞拍之王项目 — 交接文档

> 生成日期：2026-08-15 凌晨 · 由前一阶段 agent 撰写，供下一个 agent 快速接手
> 最近提交：`9238fb5`（视觉 P1）

---

## 1. 项目概览

**目标**：每局拍卖中，根据已知红品信息（均格、单件格数+价值）估算整局拍品总价值，并持续用对局结算数据学习提升精度。

**结构**（根目录 `E:\桌面\拍卖预测\竞拍之王项目`）：

```
backend/          FastAPI + SQLite + sklearn/GP + torch/CNN
  app/            main.py（启动自检）、routers/（catalog/ocr/estimate/vision/health）、
                  engine.py（规则引擎）、ml.py（ML 训练/预测）、vision.py（ResNet50 视觉匹配）、
                  ocr.py（RapidOCR 识别）、services/estimator.py（估值编排+缓存）、
                  services/matching.py（图鉴匹配）、core/（bg 后台线程/cache）
  tests/          pytest（31 过，1 个预存失败 test_run_estimate_basic）
frontend/         Vite + React + Tailwind（design token 深色主题）
  src/pages/      Dashboard/Estimate(向导)/Catalog/Records/Annotate(标注)/Ocr(截图识别)/Cnn/Model/Learn
data/             bidking.db（核心库）、models/（ml_full/cnn joblib）、captures/、crops/（视觉图库）
截图输入/         未处理截图（按格数分目录 + 测试集）
```

**技术栈**：Python 3.11、FastAPI、SQLite、sklearn（GP/HGB/Bayes）、PyTorch+torchvision（ResNet50）、RapidOCR+onnxruntime、OpenCV、Vite 7、React、Tailwind、ECharts。

---

## 2. 核心流程

### 估值流程（`/api/estimate`）
```
输入(red_avg/red_count/known_items) → 规则引擎蒙特卡洛(engine.run_estimate, ~1.9s)
  → ML 融合(ml.predict: GP+HGB+Bayes 等权, 50/50) → CNN 融合(仅 board 输入) → 4桶median校准
  → bid(recommended/risk/confidence/interval_method)
```

### 识别流程（`ocr.recognize_single` / `process_image`）
```
截图 → OCR(_full_texts, RapidOCR) → 配对(_board_items: 过滤玩家名/公告/结算区 + 序号剥离 + 水平碎片合并)
  → 名称匹配(matching.match_by_name: exact/alias/包含) → 视觉(match_crop, ResNet50 余弦, 阈值0.80)
  → 红品判定(red_ratio 颜色检测 + 图鉴确认)
```

### 学习流程
```
对局保存(save_summary/quick-archive) → bg 后台线程 train → ml.retrain(LOOCV) + cnn.train
```

---

## 3. 已完成工作（本阶段）

### 3.1 后端 Runbook（算法线）
| 项 | 结果 |
|---|---|
| **fast_gp** 重训加速 | LOOCV 中 GP 单次核优化，**8-9min → 78s**，精度相同 |
| **GP 原生置信区间** | 逐样本 std×conformal 校准；**90% 覆盖率：全场 90.9% / 红品 97%** |
| 估值 **LRU 缓存** | 相同输入+模型版本命中，1.9s → **0.001s**（~1900x），重训自动失效 |
| 封版字段 | `bid.confidence`（GP std 推算）+ `bid.interval_method`（gp_conformal） |
| **三项验证不采纳** | BMA 权重 collapse（MAPE 20.4→22.2）、特征v2 过拟合（→22.2）、LOESS 插值 nan——107 样本下等权 ensemble + 4桶 median 最稳健 |

### 3.2 数据采集（一键归档）
- `POST /api/quick-archive`：估值结果直接存对局。**兼容前端 `{input, result}` 嵌套结构**（async Request 解析）；known_items 兼容 `size`/`grid_cells`；锁定候选 `selected_red_grids/count` 优先。返回 `{ok, game_no, status}`。
- `POST /api/settle/{game_no}`：补充实际值 → status=settled → 触发重训
- `GET /api/pending-settlement`：待结算列表
- **防污染设计**：待结算局（估值当实际）经 `build_dataset` 的 `status!='pending_settlement'` 过滤**不进训练**，settle 后才进入。

### 3.3 冷启动优化（7.19s → 1.08s）
延迟导入重依赖（模块级 __getattr__ / 函数内 import）：
- `vision.py`：torch/torchvision → `_get_model`/`_encode` 内
- `ocr.py`：rapidocr_onnxruntime + GPU DLL 检测 → `get_ocr`/`_ensure_gpu_dlls` 内
- `ml.py`：sklearn → `_make_models` 内
- `cnn` 模块：从 main/estimate/estimator 顶层改为惰性

### 3.4 OCR 待确认修复
- **根因**：`list_tasks()` 返回全部任务（含 confirmed 历史），前端 `tasks.length` 当待确认数 → 16 个全是 confirmed 历史任务被误显示。
- 修复：`/api/ocr/status` 新增 `pending_count`（仅 status=pending），App.tsx 改用；新增 `POST /api/ocr/clear-pending`；标注页顶部加「待确认 OCR 任务」区域 + 全部清除按钮。

### 3.5 视觉识别修复（P0 + P1）
**P0 玩家名/公告误识别**（`_board_items` 四项增强）：
1. 序号前缀剥离（`1顺意相伴蘑菇汤`→`顺意相伴蘑菇汤`，此前误删）
2. `_BANNER_KEYWORDS` 公告横幅过滤（恭喜/运气爆棚/收获百万）
3. 结算区锚点过滤（拍得者/成交价/收益标签 y 区域的玩家昵称）
4. 低置信丢弃（conf<0.6 且图鉴不匹配）

**P1 碎片/匹配**：
1. P1-a 水平碎片合并（同一行 x 相邻框：`蓝锥`+`矿晶体`→`蓝锥矿晶体`）
2. P1-b 视觉补名（match_crop 阈值 0.85→0.80，视觉高置信≥0.80 用图鉴标准名/格数/价值覆盖 OCR 碎片名）
3. P1-c 包含匹配（`ocr_prefix` 子串：`蓝锥`⊂`蓝锥矿晶体`）
4. is_red 阈值：视觉高置信确认时 0.30→0.15

**效果**：61 张截图图鉴确认率提升到 **68.9%**（226/328），视觉高置信 98 个；红品识别 4→5 张（7→10 件）。

### 3.6 前端
- 遗留页 **131 处旧色值**（slate/indigo/emerald/rose）迁移到 design token 语义类（content-*/gold-*/jade-*/vermilion-*），**删除 index.css 旧类名兼容映射段**
- 前端新类全在 tailwind.config.js colors（ink/gold/jade/vermilion/amber/content）

---

## 4. 当前状态

### 指标
| 指标 | 值 |
|---|---|
| LOOCV 全场 MAPE | **20.9%**（红品 36.9%） |
| 90% 区间覆盖率 | 全场 90.9% / 红品 97% |
| 重训耗时 | 78s（fast_gp） |
| 冷启动 | 1.08s |
| 重复估值延迟 | 0.001s（缓存命中） |

### 数据量
- game_records：127 条（可训练 121）
- ocr_tasks：20 · ocr_samples：198
- 图鉴 catalog_items：200 个
- 训练样本门槛 MIN_SAMPLES：见 `ml.py`（~50 左右，满则自动重训）

### 服务
- 后端 http://127.0.0.1:8000（`backend/run.py`，单进程 + bg 线程）
- 前端 vite dev（`frontend/` 下 `npx vite`）

---

## 5. 遗留问题与下一步建议（按优先级）

1. **前端 pending-settlement 提醒**：后端已就绪（`GET /api/pending-settlement`），Dashboard/TopBar 尚未轮询展示待结算对局（"一键归档"后用户需知道还有 N 局待结算）。
2. **数据采集效率**：每次采集提升 > 算法优化。重点：截图导入简化、自动保存、结算后置补录。
3. **训练样本不足（核心杠杆）**：121 可训练样本 → 目标 250（MAPE ~17%）。当前视觉识别对**红品局新截图**入库质量已可用（图鉴名标准化），但对旧 61 张非红品居多的截图提升有限——**样本增长靠新对局数据**。
4. **P2 红品判定区域自适应**：`_red_cell_ratio` 依赖名称框上方 0.6h 小区域，矮框时测不到红（可能导致红品漏判）。已验证视觉确认藏品可辅助放宽阈值。
5. **图库重建**：`ocr_samples` 已有 198 条（含少量碎片名脏数据）。若触发 `collect_crops` 重建图库，建议先清洗碎片名或用 matched_name 标准化。
6. **测试**：`test_run_estimate_basic` 是预存失败（断言 976420 vs 289…，与库数据变化相关，非本次引入），其余 31 个全过。

---

## 6. 运维命令

```bash
# 启动后端（后台）
cd "E:/桌面/拍卖预测/竞拍之王项目" && python backend/run.py

# 后端测试（Windows 用 python -m）
cd backend && python -m pytest tests/ -q

# 冷启动/耗时验证
python -c "import time;t=time.time();from app.main import app;print(time.time()-t)"

# 前端构建
cd frontend && npx vite build

# 重训（数据变化后）
python -c "from app import ml;from app.db import get_conn;print(ml.retrain(get_conn()))"

# Git 推送（直连可能失败，用代理）
git push origin master   # 失败时: export HTTPS_PROXY=http://127.0.0.1:12450
```

**注意**：
- Windows 用 `python -m pytest`，避免 shebang 问题
- 推送 GitHub 网络不稳定，直连失败改用代理 12450
- `data/bidking.db` 是运行时数据，用户操作会持续修改，提交时注意区分代码/数据
- 后台线程 `bg`（train）串行执行 ML→CNN，`bg.mark_done` 更新状态

---

## 7. 关键文件索引

| 文件 | 职责 |
|---|---|
| `backend/app/ml.py` | ML 训练/预测/区间；FEATURES(9)；fast_gp；build_dataset 排除待结算 |
| `backend/app/services/estimator.py` | 估值编排；LRU 缓存；bid 字段补全；惰性 cnn |
| `backend/app/ocr.py` | OCR 识别；_board_items 过滤/合并；视觉补名；结算解析 |
| `backend/app/vision.py` | ResNet50 特征；match_crop；惰性 torch；图库 |
| `backend/app/services/matching.py` | 名称匹配三级打分（exact/alias/包含） |
| `backend/app/routers/catalog.py` | quick-archive / settle / pending-settlement |
| `backend/app/routers/ocr.py` | ocr_status(pending_count) / clear-pending |
| `frontend/src/index.css` | design token + 组件类（无旧色值映射） |
| `frontend/src/App.tsx` | OCR 待确认轮询（pending_count） |
