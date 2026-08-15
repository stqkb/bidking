import { useState } from "react";
import type { Candidate } from "../../types";
import { fmtWan } from "../../utils";

interface CandidateListProps {
  candidates: Candidate[];
  lockedCand: { red_grids: number; red_count: number } | null;
  avg: string;
  hasKnown: boolean;
  onSelect: (cand: { red_grids: number; red_count: number } | null) => void;
  onSizePop: (s: number) => void;
}

export function CandidateList({
  candidates,
  lockedCand,
  avg,
  hasKnown,
  onSelect,
  onSizePop,
}: CandidateListProps) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div>
      <div className="mb-3 text-xs" style={{ color: "var(--text-secondary)" }}>
        点击候选可锁定并按该组合重算估值与出价（均格 {avg}，1 位小数 · ±0.05 宽容匹配）
      </div>

      {lockedCand && (
        <div
          className="mb-3 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs"
          style={{
            background: "var(--jade-soft)",
            border: "1px solid rgba(74, 154, 106, 0.3)",
            color: "var(--jade-400)",
          }}
        >
          <span>
            当前估值已锁定为 {lockedCand.red_grids} 格 / {lockedCand.red_count} 件，出价按该组合重算
          </span>
          <button
            className="rounded-md px-2 py-0.5 transition hover:opacity-80"
            style={{ border: "1px solid rgba(74, 154, 106, 0.4)" }}
            onClick={() => onSelect(null)}
          >
            恢复综合估值
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {candidates.map((c, i) => {
          const isLocked =
            lockedCand !== null &&
            lockedCand.red_grids === c.red_grids &&
            lockedCand.red_count === c.red_count;
          const isExpanded = expanded === i;

          let borderColor: string;
          let bgColor: string;
          let textColor: string;

          if (isLocked) {
            borderColor = "rgba(74, 154, 106, 0.6)";
            bgColor = "var(--jade-soft)";
            textColor = "var(--jade-400)";
          } else if (i === 0) {
            borderColor = "rgba(201, 169, 98, 0.5)";
            bgColor = "var(--gold-soft)";
            textColor = "var(--gold-300)";
          } else {
            borderColor = "var(--border-subtle)";
            bgColor = "var(--bg-input)";
            textColor = "var(--text-secondary)";
          }

          return (
            <div
              key={`${c.red_grids}-${c.red_count}`}
              className="min-w-[160px] flex-1 rounded-xl border p-3 transition-all"
              style={{
                borderColor,
                background: bgColor,
                boxShadow: isLocked ? `0 0 0 1px ${borderColor}` : undefined,
              }}
            >
              <button
                className="w-full text-left font-semibold tabular-nums transition hover:opacity-80"
                style={{ color: textColor }}
                onClick={() => {
                  if (isLocked) {
                    onSelect(null);
                  } else {
                    onSelect({ red_grids: c.red_grids, red_count: c.red_count });
                  }
                }}
                title={isLocked ? "取消锁定，恢复综合估值" : "点击后按此格数组合重算估值与出价"}
              >
                {c.red_grids} 格 / {c.red_count} 件
                {isLocked && <span className="ml-1.5 text-[10px]">已锁定</span>}
                {i === 0 && !isLocked && <span className="ml-1.5 text-[10px]">最可能</span>}
              </button>

              {c.estimate && (
                <div className="mt-1 font-mono text-xs tabular-nums" style={{ color: "var(--gold-300)" }}>
                  红品期望 {fmtWan(c.estimate.ev)}
                  <span style={{ color: "var(--text-tertiary)" }}>
                    {" "}({fmtWan(c.estimate.p10)} ~ {fmtWan(c.estimate.p90)})
                  </span>
                  {hasKnown && c.estimate.remaining_ev !== undefined && (
                    <span className="ml-1" style={{ color: "var(--jade-400)" }}>
                      · 其余 {fmtWan(c.estimate.remaining_ev)}
                    </span>
                  )}
                </div>
              )}

              {c.compositions && c.compositions.length > 0 && (
                <button
                  className="mt-1.5 text-[11px] transition hover:opacity-80"
                  style={{ color: "var(--text-tertiary)" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpanded(isExpanded ? null : i);
                  }}
                >
                  {isExpanded ? "收起组合 ▲" : `${c.compositions.length} 种组合 ▼`}
                </button>
              )}

              {isExpanded && c.compositions && (
                <div className="mt-1.5 space-y-1">
                  {c.compositions.slice(0, 5).map((comp, j) => (
                    <div key={j} className="flex flex-wrap items-center gap-1 font-mono text-xs tabular-nums">
                      {comp.map((s, k) => (
                        <span key={k} className="flex items-center gap-1">
                          {k > 0 && <span style={{ color: "var(--text-tertiary)" }}>+</span>}
                          <button
                            className="rounded-md px-1.5 py-0.5 transition hover:opacity-80"
                            style={{ border: "1px solid var(--border-subtle)", color: "var(--gold-300)" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              onSizePop(s);
                            }}
                            title={`查看 ${s} 格藏品预期价格`}
                          >
                            {s}
                          </button>
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}
