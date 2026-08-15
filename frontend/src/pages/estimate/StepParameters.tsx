import { useState } from "react";
import BoardEditor from "../../components/BoardEditor";
import type { WizardContext } from "./wizardTypes";

export function StepParameters({ ctx }: { ctx: WizardContext }) {
  const { state, dispatch } = ctx;
  const [ocrPick, setOcrPick] = useState<number | "">("");
  const [ocrZoom, setOcrZoom] = useState<number | null>(null);

  const pickedTask = ocrPick !== "" ? ctx.ocrTasks.find((x) => x.id === ocrPick) : null;

  return (
    <div className="space-y-5">
      {/* ── Core parameters ── */}
      <div className="card p-6">
        <h3 className="mb-4 text-sm font-medium tracking-wide" style={{ color: "var(--text-secondary)" }}>
          棋盘参数
        </h3>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="field-label">红品平均格数 *</label>
            <input
              className="input"
              type="number"
              step="0.1"
              min="0.01"
              max="50"
              placeholder="如 2.2"
              value={state.avg}
              onChange={(e) => dispatch({ type: "SET_FIELD", field: "avg", value: e.target.value })}
              onBlur={() => {
                const n = parseFloat(state.avg);
                if (!Number.isNaN(n)) dispatch({ type: "SET_FIELD", field: "avg", value: n.toFixed(1) });
              }}
            />
          </div>
          <div>
            <label className="field-label">红品件数预估</label>
            <input
              className="input"
              type="number"
              min="1"
              max="80"
              placeholder="可选"
              value={state.countEst}
              onChange={(e) => dispatch({ type: "SET_FIELD", field: "countEst", value: e.target.value })}
            />
          </div>
          <div>
            <label className="field-label">全场总格数 T</label>
            <input
              className="input"
              type="number"
              min="1"
              placeholder="可选"
              value={state.totalGrids}
              onChange={(e) => dispatch({ type: "SET_FIELD", field: "totalGrids", value: e.target.value })}
            />
          </div>
        </div>

        {/* ── Screenshot assist ── */}
        <div
          className="mt-4 rounded-xl p-3"
          style={{ background: "var(--bg-input)", border: "1px solid var(--border-subtle)" }}
        >
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium" style={{ color: "var(--gold-300)" }}>
              从截图识别（可选）：
            </span>
            <button
              className="btn-primary !h-7 !px-3 text-xs"
              onClick={ctx.onSampleClip}
              disabled={ctx.clipBusy}
            >
              {ctx.clipBusy ? "识别中…" : "采样剪贴板识别"}
            </button>
            <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
              <input
                type="checkbox"
                style={{ accentColor: "var(--gold-500)" }}
                checked={ctx.autoClipOn}
                onChange={(e) => ctx.onSetAutoClip(e.target.checked)}
              />
              自动采样 Win+Shift+S
            </label>
          </div>

          {ctx.ocrMsg && (
            <div
              className="mt-2 rounded-lg border px-2.5 py-1.5 text-xs"
              style={{
                borderColor: ctx.ocrWarn ? "rgba(201, 154, 62, 0.3)" : "rgba(74, 154, 106, 0.3)",
                background: ctx.ocrWarn ? "var(--amber-soft)" : "var(--jade-soft)",
                color: ctx.ocrWarn ? "var(--amber-400)" : "var(--jade-400)",
              }}
            >
              {ctx.ocrMsg}
            </div>
          )}

          {ctx.clipSettle &&
            (ctx.clipSettle.total_value != null ||
              ctx.clipSettle.deal_price != null ||
              ctx.clipSettle.profit != null) && (
              <div
                className="mt-2 grid grid-cols-3 gap-2 border-t pt-2 text-xs"
                style={{ borderColor: "var(--border-subtle)" }}
              >
                <div>
                  <div className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>藏品总价值</div>
                  <b style={{ color: "var(--jade-400)" }}>
                    {ctx.clipSettle.total_value != null ? ctx.clipSettle.total_value.toLocaleString() : "—"}
                  </b>
                </div>
                <div>
                  <div className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>成交价</div>
                  <b style={{ color: "var(--gold-300)" }}>
                    {ctx.clipSettle.deal_price != null ? ctx.clipSettle.deal_price.toLocaleString() : "—"}
                  </b>
                </div>
                <div>
                  <div className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>收益</div>
                  <b
                    style={{
                      color: (ctx.clipSettle.profit ?? 0) >= 0 ? "var(--jade-400)" : "var(--vermilion-400)",
                    }}
                  >
                    {ctx.clipSettle.profit != null ? ctx.clipSettle.profit.toLocaleString() : "—"}
                  </b>
                </div>
              </div>
            )}

          {ctx.clipCandidates.length > 0 && (
            <div className="mt-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                  识别到的红品候选（点击填入）：
                </span>
                <button
                  className="text-[11px] font-medium transition hover:opacity-80"
                  style={{ color: "var(--gold-300)" }}
                  onClick={ctx.onImportAllClip}
                >
                  全部填入（{ctx.clipCandidates.length}）
                </button>
              </div>
              {ctx.clipCandidates.map((c, i) => (
                <button
                  key={i}
                  className="flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition"
                  style={{
                    borderColor: "var(--border-subtle)",
                    background: "var(--bg-surface)",
                  }}
                  onClick={() => ctx.onFillFromClip(c)}
                >
                  <img
                    src={`/api/vision/crop_box?image_path=${encodeURIComponent(c.path)}&box=${c.box.join(",")}`}
                    alt=""
                    className="h-8 w-8 rounded border object-contain"
                    style={{ borderColor: "var(--border-subtle)", background: "var(--bg-canvas)" }}
                    onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs" style={{ color: "var(--text-primary)" }}>
                    {c.name}（{c.grid_cells}格）
                  </span>
                  <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
                    {Math.round(c.score * 100)}%
                  </span>
                  <span className="text-[11px]" style={{ color: "var(--gold-300)" }}>填入 →</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Advanced fields ── */}
        <button
          className="mt-4 text-xs font-medium transition hover:opacity-80"
          style={{ color: "var(--gold-300)" }}
          onClick={() => dispatch({ type: "TOGGLE_ADVANCED" })}
        >
          {state.advanced ? "收起高级字段 ▲" : "展开高级字段 ▼（件数/总格数/其他品质/最低出价）"}
        </button>

        {state.advanced && (
          <div
            className="mt-3 grid grid-cols-2 gap-3 rounded-xl p-3"
            style={{ background: "var(--bg-input)", border: "1px solid var(--border-subtle)" }}
          >
            {(
              [
                ["红品件数", "redCount"],
                ["红品总格数", "redGrids"],
                ["蓝色格数", "blueGrids"],
                ["白绿格数", "wgGrids"],
                ["紫色格数", "purpleGrids"],
                ["金色格数", "goldGrids"],
                ["游戏最低出价", "minBid"],
              ] as const
            ).map(([label, field]) => (
              <div key={field}>
                <label className="field-label">{label}</label>
                <input
                  className="input"
                  type="number"
                  placeholder="可选"
                  value={state[field] as string}
                  onChange={(e) =>
                    dispatch({ type: "SET_FIELD", field, value: e.target.value })
                  }
                />
              </div>
            ))}
          </div>
        )}

        {/* ── Margin slider ── */}
        <div className="mt-4">
          <label className="field-label">
            利润率 margin（推荐出价 = 保守下限 p10 × margin）：{(state.margin * 100).toFixed(0)}%
          </label>
          <input
            type="range"
            min="0.5"
            max="1"
            step="0.01"
            value={state.margin}
            onChange={(e) => dispatch({ type: "SET_FIELD", field: "margin", value: Number(e.target.value) })}
            className="w-full"
            style={{ accentColor: "var(--gold-500)" }}
          />
          <div className="flex justify-between text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            <span>保守 50%</span>
            <span>默认 85%</span>
            <span>激进 100%</span>
          </div>
        </div>

        {/* ── Toggles ── */}
        <div className="mt-4 space-y-2">
          <label className="flex items-center gap-2 text-sm" style={{ color: "var(--text-secondary)" }}>
            <input
              type="checkbox"
              style={{ accentColor: "var(--gold-500)" }}
              checked={state.useCalib}
              onChange={(e) => dispatch({ type: "SET_FIELD", field: "useCalib", value: e.target.checked })}
            />
            启用已知红品校准（实验性，实测会放大误差，默认关闭）
          </label>
          <label className="flex items-center gap-2 text-sm" style={{ color: "var(--text-secondary)" }}>
            <input
              type="checkbox"
              style={{ accentColor: "var(--gold-500)" }}
              checked={state.useBoard}
              onChange={(e) => dispatch({ type: "SET_FIELD", field: "useBoard", value: e.target.checked })}
            />
            附加棋盘布局（CNN 融合估值）
          </label>
          {state.useBoard && (
            <BoardEditor board={state.board} onChange={(b) => dispatch({ type: "SET_FIELD", field: "board", value: b })} />
          )}
        </div>
      </div>

      {/* ── OCR task selection (from scanned screenshots) ── */}
      {ctx.ocrTasks.length > 0 && (
        <div className="card p-6">
          <h3 className="mb-1 text-sm font-medium tracking-wide" style={{ color: "var(--text-secondary)" }}>
            截图辅助估值
          </h3>
          <p className="mb-3 text-xs" style={{ color: "var(--text-tertiary)" }}>
            从已扫描的图片自动填入表单
          </p>

          <select
            className="input"
            value={ocrPick}
            onChange={(e) => setOcrPick(e.target.value === "" ? "" : Number(e.target.value))}
          >
            <option value="">— 选择已扫描图片 —</option>
            {ctx.ocrTasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.shape} · {t.path.split(/[\\/]/).pop()?.slice(0, 16)}（{(t.result?.items ?? []).length}件）
              </option>
            ))}
          </select>

          {pickedTask && (
            <div className="mt-3 flex gap-3">
              <button
                className="group relative w-28 shrink-0 overflow-hidden rounded-lg border"
                style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}
                onClick={() => setOcrZoom(pickedTask.id)}
              >
                <img
                  src={`/api/ocr/image/${pickedTask.id}`}
                  alt=""
                  className="h-24 w-full object-contain transition group-hover:scale-105"
                />
              </button>
              <div className="min-w-0 space-y-1.5">
                {(pickedTask.result?.items ?? []).slice(0, 4).map((it, i) => (
                  <div key={i} className="text-xs" style={{ color: "var(--text-primary)" }}>
                    {it.name} · {it.price.toLocaleString()} · {it.grid_cells}格
                  </div>
                ))}
                <button
                  className="btn-ghost !h-7 !px-3 text-xs"
                  onClick={() => ctx.onApplyOcr(pickedTask)}
                >
                  识别并填入表单
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Navigation ── */}
      <div className="flex items-center justify-between">
        {state.error && (
          <div
            className="rounded-lg border px-3 py-2 text-sm"
            style={{
              borderColor: "rgba(196, 74, 74, 0.3)",
              background: "var(--vermilion-soft)",
              color: "var(--vermilion-400)",
            }}
          >
            {state.error}
          </div>
        )}
        <button
          className="btn-primary ml-auto"
          onClick={() => dispatch({ type: "NEXT_STEP" })}
          disabled={!state.avg}
        >
          下一步 →
        </button>
      </div>

      {/* ── OCR zoom modal ── */}
      {ocrZoom !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: "rgba(0, 0, 0, 0.85)" }}
          onClick={() => setOcrZoom(null)}
        >
          <img
            src={`/api/ocr/image/${ocrZoom}`}
            alt=""
            className="max-h-full max-w-full rounded-xl shadow-2xl"
          />
          <button
            className="absolute right-5 top-5 rounded-full px-3 py-1.5 text-sm"
            style={{ background: "var(--bg-elevated)", color: "var(--text-secondary)" }}
            onClick={() => setOcrZoom(null)}
          >
            ✕ 关闭
          </button>
        </div>
      )}
    </div>
  );
}
