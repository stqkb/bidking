import { useState } from "react";

const SIZES = [1, 2, 3, 4, 6, 8, 9, 12, 15, 16];
const N = 16;

function factorPairs(s: number): [number, number][] {
  const out: [number, number][] = [];
  for (let h = 1; h <= Math.min(s, N); h++) {
    if (s % h === 0) {
      const w = s / h;
      if (w >= 1 && w <= N) out.push([h, w]);
    }
  }
  out.sort((a, b) => Math.abs(a[0] - a[1]) - Math.abs(b[0] - b[1]));
  return out;
}

interface Props {
  board: number[][];
  onChange: (b: number[][]) => void;
}

export default function BoardEditor({ board, onChange }: Props) {
  const [size, setSize] = useState(4);
  const [erase, setErase] = useState(false);
  const [history, setHistory] = useState<number[][][]>([]);

  const clone = () => board.map((r) => [...r]);

  const placeAt = (r: number, c: number) => {
    if (erase) {
      const next = clone();
      next[r][c] = 0;
      onChange(next);
      return;
    }
    const pairs = factorPairs(size);
    let placed = false;
    for (const [h, w] of pairs) {
      if (r + h <= N && c + w <= N) {
        let ok = true;
        for (let i = r; i < r + h; i++) {
          for (let j = c; j < c + w; j++) {
            if (board[i][j]) {
              ok = false;
              break;
            }
          }
          if (!ok) break;
        }
        if (ok) {
          const next = clone();
          for (let i = r; i < r + h; i++) {
            for (let j = c; j < c + w; j++) next[i][j] = 1;
          }
          setHistory((hst) => [...hst.slice(-19), board]);
          onChange(next);
          placed = true;
          break;
        }
      }
    }
    if (!placed && !erase) {
      // 尝试其他旋转/形状
      for (const [h, w] of pairs.slice(1)) {
        if (r + h <= N && c + w <= N) {
          let ok = true;
          for (let i = r; i < r + h; i++) {
            for (let j = c; j < c + w; j++) {
              if (board[i][j]) {
                ok = false;
                break;
              }
            }
            if (!ok) break;
          }
          if (ok) {
            const next = clone();
            for (let i = r; i < r + h; i++) {
              for (let j = c; j < c + w; j++) next[i][j] = 1;
            }
            setHistory((hst) => [...hst.slice(-19), board]);
            onChange(next);
            break;
          }
        }
      }
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input w-28"
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          disabled={erase}
        >
          {SIZES.map((s) => (
            <option key={s} value={s}>
              {s} 格
            </option>
          ))}
        </select>
        <button
          className={`rounded-lg border px-3 py-1.5 text-xs transition ${
            erase
              ? "border-vermilion-400/50 bg-vermilion-soft text-vermilion-400"
              : "border-ink-700 bg-ink-800 text-content-primary hover:text-content-primary"
          }`}
          onClick={() => setErase(!erase)}
        >
          {erase ? "橡皮擦开" : "橡皮擦"}
        </button>
        <button
          className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs text-content-primary transition hover:text-content-primary"
          onClick={() => {
            setHistory((hst) => [...hst.slice(-19), board]);
            onChange(Array.from({ length: N }, () => Array(N).fill(0)));
          }}
        >
          清空
        </button>
        <button
          className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs text-content-primary transition hover:text-content-primary disabled:opacity-40"
          disabled={history.length === 0}
          onClick={() => {
            const prev = history[history.length - 1];
            setHistory((hst) => hst.slice(0, -1));
            onChange(prev);
          }}
        >
          撤销
        </button>
        <span className="ml-auto text-xs text-content-secondary">点击格子摆放 {size} 格矩形 · 自动匹配形状</span>
      </div>
      <div
        className="grid w-fit gap-[3px] rounded-xl border border-ink-700 bg-ink-900 p-2"
        style={{ gridTemplateColumns: `repeat(${N}, minmax(0, 1fr))` }}
      >
        {board.map((row, r) =>
          row.map((v, c) => (
            <button
              key={`${r}-${c}`}
              onClick={() => placeAt(r, c)}
              className={`h-[22px] w-[22px] rounded-[4px] transition ${
                v
                  ? "bg-gradient-to-br from-indigo-500 to-fuchsia-500 shadow-md shadow-indigo-500/30"
                  : "bg-ink-800 hover:bg-ink-700"
              }`}
            />
          )),
        )}
      </div>
    </div>
  );
}
