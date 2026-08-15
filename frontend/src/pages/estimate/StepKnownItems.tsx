import type { WizardContext } from "./wizardTypes";
import { fmtInputNum, parseNum } from "./wizardTypes";
import { fmtMoney } from "../../utils";

export function StepKnownItems({ ctx }: { ctx: WizardContext }) {
  const { state, dispatch } = ctx;

  /* ── Info density calculation ── */
  const avgNum = parseNum(state.avg);
  const countNum = parseNum(state.countEst);
  const knownGrids = state.knownItems.reduce((sum, k) => {
    const s = parseNum(k.size);
    return sum + (s ?? 0);
  }, 0);
  const totalRedGrids = avgNum !== null && countNum !== null ? avgNum * countNum : null;
  const infoDensity = totalRedGrids && totalRedGrids > 0 ? Math.min(100, (knownGrids / totalRedGrids) * 100) : 0;

  return (
    <div className="space-y-5">
      <div className="card p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium tracking-wide" style={{ color: "var(--text-secondary)" }}>
              已知红品
            </h3>
            <p className="mt-0.5 text-xs" style={{ color: "var(--text-tertiary)" }}>
              可选 — 信息越多，预测越准
            </p>
          </div>
        </div>

        {/* ── Info density bar ── */}
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span style={{ color: "var(--text-secondary)" }}>信息密度</span>
            <span
              className="font-mono tabular-nums font-semibold"
              style={{
                color:
                  infoDensity >= 67
                    ? "var(--jade-400)"
                    : infoDensity >= 33
                      ? "var(--amber-400)"
                      : "var(--vermilion-400)",
              }}
            >
              {infoDensity.toFixed(0)}%
            </span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full"
            style={{ background: "var(--bg-input)" }}
          >
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${infoDensity}%`,
                background:
                  infoDensity >= 67
                    ? "var(--jade-400)"
                    : infoDensity >= 33
                      ? "var(--amber-400)"
                      : "var(--vermilion-400)",
              }}
            />
          </div>
          <div className="mt-1 text-[10px]" style={{ color: "var(--text-tertiary)" }}>
            {totalRedGrids
              ? `已知格数 ${knownGrids} / 预估总红品格数 ${totalRedGrids.toFixed(0)}`
              : "填写红品件数预估以计算信息密度"}
          </div>
        </div>

        {/* ── Known items list ── */}
        <div className="space-y-2.5">
          {state.knownItems.map((k, idx) => (
            <div
              key={k.key}
              className="rounded-xl p-3"
              style={{ background: "var(--bg-input)", border: "1px solid var(--border-subtle)" }}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                  已知红品 {idx + 1}
                </span>
                {state.knownItems.length > 1 && (
                  <button
                    className="text-xs transition hover:opacity-80"
                    style={{ color: "var(--vermilion-400)" }}
                    onClick={() => dispatch({ type: "REMOVE_KNOWN", key: k.key })}
                  >
                    ✕ 移除
                  </button>
                )}
              </div>

              <select
                className="input"
                value={k.id}
                onChange={(e) => {
                  const id = e.target.value === "" ? "" : Number(e.target.value);
                  if (id === "") {
                    dispatch({ type: "UPDATE_KNOWN", key: k.key, patch: { id: "", name: null, size: "", value: "" } });
                  } else {
                    const it = ctx.items.find((x) => x.id === id);
                    dispatch({
                      type: "UPDATE_KNOWN",
                      key: k.key,
                      patch: it
                        ? { id, name: it.name, size: String(it.grid_cells), value: fmtInputNum(String(it.value)) }
                        : { id, name: null, size: "", value: "" },
                    });
                  }
                }}
              >
                <option value="">— 从图鉴选择（可留空）—</option>
                {ctx.items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name}（{it.grid_cells}格）
                  </option>
                ))}
              </select>

              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <label className="field-label">格数</label>
                  <input
                    className="input"
                    type="number"
                    min="1"
                    placeholder="如 8"
                    value={k.size}
                    onChange={(e) =>
                      dispatch({ type: "UPDATE_KNOWN", key: k.key, patch: { size: e.target.value } })
                    }
                  />
                </div>
                <div>
                  <label className="field-label">价值</label>
                  <input
                    className="input"
                    type="text"
                    inputMode="numeric"
                    placeholder="如 900,000"
                    value={k.value}
                    onChange={(e) =>
                      dispatch({ type: "UPDATE_KNOWN", key: k.key, patch: { value: fmtInputNum(e.target.value) } })
                    }
                  />
                </div>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <button
                  className="btn-ghost !h-7 !px-3 text-xs"
                  onClick={() => ctx.onIdentify(k.key)}
                  disabled={ctx.identifyBusy}
                >
                  {ctx.identifyBusy && ctx.identifyFor === k.key ? "识别中…" : "识别藏品"}
                </button>
                <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                  只填格数即按价值从低到高展示
                </span>
                {k.name && (
                  <span className="text-xs" style={{ color: "var(--jade-400)" }}>
                    已识别：{k.name}
                  </span>
                )}
              </div>

              {/* Identify hits */}
              {ctx.identifyFor === k.key && ctx.identifyHits && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {ctx.identifyHits.length === 0 && (
                    <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                      该格数下暂无图鉴藏品，可手动选择下拉框
                    </span>
                  )}
                  {ctx.identifyHits.map((m, i) => (
                    <button
                      key={`${m.name}-${i}`}
                      onClick={() => ctx.onPickIdentify(k.key, m)}
                      className="rounded-lg border px-2.5 py-1 text-xs transition hover:opacity-80"
                      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-elevated)", color: "var(--text-secondary)" }}
                    >
                      {m.name}（{m.grid_cells}格 · {fmtMoney(m.value)}
                      {m.match ? ` · ${m.match}` : ""}）
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

          <button
            className="w-full rounded-xl border border-dashed p-2 text-xs font-medium transition hover:opacity-80"
            style={{
              borderColor: "var(--border-default)",
              background: "transparent",
              color: "var(--gold-300)",
            }}
            onClick={() => dispatch({ type: "ADD_KNOWN" })}
          >
            ＋ 添加已知红品
          </button>
        </div>

        {state.savedMsg && (
          <div
            className="mt-3 rounded-lg border px-3 py-2 text-sm"
            style={{
              borderColor: "rgba(74, 154, 106, 0.3)",
              background: "var(--jade-soft)",
              color: "var(--jade-400)",
            }}
          >
            {state.savedMsg}
          </div>
        )}
      </div>

      {/* ── Navigation ── */}
      <div className="flex items-center justify-between">
        <button className="btn-ghost" onClick={() => dispatch({ type: "PREV_STEP" })}>
          ← 上一步
        </button>
        <button
          className="btn-primary"
          onClick={() => ctx.onRunEstimate()}
          disabled={ctx.state.loading || !state.avg}
        >
          {ctx.state.loading ? "计算中…" : "开始估值 →"}
        </button>
      </div>

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
    </div>
  );
}
