import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Card } from "../components/Card";
import type { CatalogItem, OcrTask } from "../types";

export default function LearnPage() {
  const [tasks, setTasks] = useState<OcrTask[]>([]);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [pick, setPick] = useState<number | "">("");
  const [uploadPath, setUploadPath] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [nameMode, setNameMode] = useState<"catalog" | "custom">("catalog");
  const [learnShow, setLearnShow] = useState<"all" | "learned" | "not">("all");
  const [name, setName] = useState("");
  const [cells, setCells] = useState("");
  const [box, setBox] = useState<[number, number, number, number] | null>(null);
  const [drag, setDrag] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null);
  const [msg, setMsg] = useState("");
  const [learned, setLearned] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<{ name: string; cells: number }[]>([]);
  const [autoClip, setAutoClip] = useState(false);
  const [autoNext, setAutoNext] = useState(true);
  const lastClipHash = useRef("");
  const firstPeek = useRef(true);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const initRef = useRef(false);

  useEffect(() => {
    api.ocrStatus().then((r) => setTasks(r.tasks.filter((t) => t.kind === "grid"))).catch(() => {});
    api.catalogItems().then((r) => setItems(r.items)).catch(() => {});
    api.visionGallery().then((r) => {
      setLearned(new Set(r.items.filter((x) => x.has_learn).map((x) => x.name)));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (initRef.current || items.length === 0) return;
    initRef.current = true;
    const raw = sessionStorage.getItem("learnQueue");
    if (raw) {
      sessionStorage.removeItem("learnQueue");
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) {
          const first = arr[0];
          setQueue(arr.slice(1));
          setName(first.name);
          setCells(String(first.cells || ""));
          setNameMode(items.some((it) => it.name === first.name) ? "catalog" : "custom");
          setMsg(`从图鉴带入：${first.name}，框选图标后保存`);
        }
      } catch { /* ignore */ }
    }
  }, [items]);

  useEffect(() => {
    if (!autoClip) return;
    firstPeek.current = true;
    const loadClip = async () => {
      try {
        const r = await fetch("/api/clipboard", { method: "POST" });
        const j = await r.json();
        if (!j.ok) return;
        if (firstPeek.current) {
          // 只记录当前剪贴板哈希，不加载旧图
          firstPeek.current = false;
          lastClipHash.current = j.hash;
          return;
        }
        if (j.ok && j.hash && j.hash !== lastClipHash.current) {
          lastClipHash.current = j.hash;
          setUploadPath(j.path);
          setPick("");
          setBox(null);
          setImageUrl(`/api/vision/uploaded?path=${encodeURIComponent(j.path)}`);
          setMsg("已自动采样剪贴板截图，请框选藏品图标");
        }
      } catch { /* ignore */ }
    };
    loadClip();
    const timer = setInterval(loadClip, 2000);
    return () => clearInterval(timer);
  }, [autoClip]);

  const sampleClip = async () => {
    const r = await fetch("/api/clipboard", { method: "POST" });
    const j = await r.json();
    if (!j.ok) {
      setMsg(j.error ?? "剪贴板没有图片");
      return;
    }
    lastClipHash.current = j.hash;
    setUploadPath(j.path);
    setPick("");
    setBox(null);
    setImageUrl(`/api/vision/uploaded?path=${encodeURIComponent(j.path)}`);
    setMsg("已采样剪贴板截图，请框选藏品图标");
  };

  const imgIdx = pick !== "" ? tasks.findIndex((t) => t.id === pick) : -1;
  const goImage = (delta: number) => {
    if (tasks.length === 0) return;
    const base = imgIdx === -1 ? 0 : imgIdx;
    const next = (base + delta + tasks.length) % tasks.length;
    selectTask(tasks[next].id);
  };

  const selectTask = (id: number | "") => {
    setPick(id);
    setUploadPath("");
    setBox(null);
    setImageUrl(id === "" ? "" : `/api/ocr/image/${id}`);
  };

  const upload = async (f: File | undefined) => {
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    const r = await fetch("/api/vision/upload", { method: "POST", body: fd });
    const j = await r.json();
    setUploadPath(j.path);
    setPick("");
    setBox(null);
    setImageUrl(`/api/vision/uploaded?path=${encodeURIComponent(j.path)}`);
  };

  const capture = async () => {
    setMsg("正在截取游戏画面…");
    const r = await fetch("/api/capture", { method: "POST" });
    const j = await r.json();
    if (!j.ok) {
      setMsg(j.error ?? "截图失败");
      return;
    }
    setUploadPath(j.path);
    setPick("");
    setBox(null);
    setImageUrl(`/api/vision/uploaded?path=${encodeURIComponent(j.path)}`);
    setMsg(
      `已截取画面（${j.source === "game_window" ? `游戏窗口：${j.window_title ?? ""}` : "全屏"}），请框选藏品图标`,
    );
  };

  const down = (e: React.MouseEvent) => {
    if (!imgRef.current) return;
    const ir = imgRef.current.getBoundingClientRect();
    setDrag({ sx: e.clientX - ir.left, sy: e.clientY - ir.top, ex: e.clientX - ir.left, ey: e.clientY - ir.top });
  };
  const move = (e: React.MouseEvent) => {
    if (!drag || !imgRef.current) return;
    const ir = imgRef.current.getBoundingClientRect();
    setDrag({ ...drag, ex: e.clientX - ir.left, ey: e.clientY - ir.top });
  };
  const up = () => {
    if (!drag || !imgRef.current) return;
    const scaleX = imgRef.current.naturalWidth / imgRef.current.width;
    const scaleY = imgRef.current.naturalHeight / imgRef.current.height;
    const x0 = Math.min(drag.sx, drag.ex) * scaleX;
    const y0 = Math.min(drag.sy, drag.ey) * scaleY;
    const x1 = Math.max(drag.sx, drag.ex) * scaleX;
    const y1 = Math.max(drag.sy, drag.ey) * scaleY;
    setBox([Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)]);
    setDrag(null);
  };

  const doSave = async () => {
    if (!box || !name.trim()) {
      setMsg("请先框选区域并填写藏品名称");
      return null;
    }
    const imagePath = uploadPath || `task:${pick}`;
    const r = await api.visionLearn(imagePath, box, name.trim(), Number(cells) || 0);
    setBox(null);
    setLearned((prev) => new Set(prev).add(r.name));
    return r.name;
  };

  const handleSave = async () => {
    const n = await doSave();
    if (!n) return;
    const learnedNow = new Set(learned);
    learnedNow.add(n);
    setLearned(learnedNow);
    if (!autoNext) {
      setMsg(`已学习：${n}（${Number(cells) || "?"}格），可继续多拍几张同一藏品`);
      return;
    }
    // 显式队列优先
    if (queue.length === 0) {
      const candidates = (cells
        ? items.filter((it) => it.grid_cells === Number(cells))
        : items
      ).filter((it) => !learnedNow.has(it.name));
      if (candidates.length === 0) {
        setMsg(`已学习：${n}，当前${cells ? `格数 ${cells} ` : ""}下没有未学习的藏品了`);
        return;
      }
      const next = candidates[0];
      setName(next.name);
      setCells(String(next.grid_cells));
      setNameMode("catalog");
      setMsg(`已学习：${n}，下一件：${next.name}（${next.grid_cells}格）—— 请切换图片后框选`);
      return;
    }
    const remaining = queue.length;
    const next = queue[0];
    setQueue(queue.slice(1));
    setName(next.name);
    setCells(String(next.cells || ""));
    setNameMode(items.some((it) => it.name === next.name) ? "catalog" : "custom");
    setMsg(`已学习：${n}，下一件：${next.name}（剩 ${remaining} 件）—— 请用 ◀/▶ 切换图片后框选`);
  };

  const filteredItems = (cells
    ? items.filter((it) => it.grid_cells === Number(cells))
    : items
  ).filter((it) => {
    if (learnShow === "learned") return learned.has(it.name);
    if (learnShow === "not") return !learned.has(it.name);
    return true;
  });

  const rect = drag
    ? { left: Math.min(drag.sx, drag.ex), top: Math.min(drag.sy, drag.ey), width: Math.abs(drag.ex - drag.sx), height: Math.abs(drag.ey - drag.sy) }
    : null;

  return (
    <div className="space-y-5">
      <Card title="图像学习" desc="鼠标框选藏品的图标区域 → 指定名称/格数 → 保存。同一藏品多拍几张，识别会越来越准">
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost !px-3 !py-2 text-sm" onClick={() => goImage(-1)} disabled={tasks.length === 0 || imgIdx <= 0}>
            ◀ 上一张
          </button>
          <select className="input w-72" value={pick} onChange={(e) => selectTask(e.target.value === "" ? "" : Number(e.target.value))}>
            <option value="">— 从已扫描图片选择 —</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.shape} · {t.path.split(/[\\/]/).pop()?.slice(0, 18)}
              </option>
            ))}
          </select>
          <button className="btn-ghost !px-3 !py-2 text-sm" onClick={() => goImage(1)} disabled={tasks.length === 0}>
            下一张 ▶
          </button>
          <span className="text-xs text-content-secondary">
            {imgIdx >= 0 ? `${imgIdx + 1} / ${tasks.length}` : ""}
          </span>
          <span className="text-xs text-content-secondary">或</span>
          <label className="btn-ghost !py-2 text-xs">
            上传新截图
            <input type="file" accept="image/*" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
          </label>
          <button className="btn-primary !py-2 text-xs" onClick={capture}>
            📷 截取游戏画面
          </button>
          <button className="btn-ghost !py-2 text-xs" onClick={sampleClip}>
            📋 采样剪贴板截图
          </button>
          <label className="flex items-center gap-1.5 text-xs text-content-secondary">
            <input
              type="checkbox"
              className="accent-indigo-500"
              checked={autoClip}
              onChange={(e) => setAutoClip(e.target.checked)}
            />
            自动采样 Win+Shift+S
          </label>
          <span className="text-xs text-content-secondary">截屏前请先切到游戏画面</span>
        </div>
        <p className="mt-2 text-[11px] text-content-secondary">
          提示：页面不会自动加载旧的剪贴板截图，只有新截的（Win+Shift+S）才会自动出现；如果显示不对，点「采样剪贴板截图」强制重载。
        </p>
      </Card>

      {(imageUrl || queue.length > 0) && (
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          {imageUrl ? (
            <Card title="框选藏品图标区域" desc="按住鼠标左键拖出矩形，包住藏品的图片部分">
              <div
                ref={wrapRef}
                className="relative max-h-[560px] w-full overflow-auto rounded-xl border border-ink-700 bg-ink-900"
                onMouseDown={down}
                onMouseMove={move}
                onMouseUp={up}
                onMouseLeave={() => setDrag(null)}
              >
                <div className="relative inline-block">
                  <img ref={imgRef} src={imageUrl} alt="" className="block max-w-full select-none" draggable={false} />
                  {rect && (
                    <div
                      className="pointer-events-none absolute border-2 border-fuchsia-400 bg-fuchsia-400/20"
                      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                    />
                  )}
                </div>
              </div>
              {box && (
                <div className="mt-2 text-xs text-jade-400">
                  已框选：{box[0]},{box[1]} → {box[2]},{box[3]}（原始坐标）
                </div>
              )}
            </Card>
          ) : (
            <Card title="选择图片" desc="请用上方下拉或 ◀/▶ 按钮选择一张包含该藏品的截图">
              <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-ink-700 text-sm text-content-secondary">
                尚未选择图片
              </div>
            </Card>
          )}

          <Card title="指定藏品" desc="选择图鉴里的名称，或手动输入新藏品">
            <div className="space-y-3">
              <div className="flex gap-2">
                <button
                  className={`rounded-lg border px-3 py-1.5 text-xs ${nameMode === "catalog" ? "border-gold-400/60 bg-gold-soft text-gold-400" : "border-ink-700 text-content-secondary"}`}
                  onClick={() => setNameMode("catalog")}
                >
                  从图鉴选
                </button>
                <button
                  className={`rounded-lg border px-3 py-1.5 text-xs ${nameMode === "custom" ? "border-gold-400/60 bg-gold-soft text-gold-400" : "border-ink-700 text-content-secondary"}`}
                  onClick={() => setNameMode("custom")}
                >
                  新藏品
                </button>
              </div>
              {nameMode === "catalog" ? (
                <>
                  <div className="flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-900 p-0.5 text-xs">
                    {([
                      ["all", `全部 ${items.length}`],
                      ["learned", `✓已学习 ${items.filter((x) => learned.has(x.name)).length}`],
                      ["not", `未学习 ${items.filter((x) => !learned.has(x.name)).length}`],
                    ] as const).map(([k, label]) => (
                      <button
                        key={k}
                        className={`rounded-md px-2 py-1 ${learnShow === k ? "bg-gold-soft text-gold-400" : "text-content-secondary hover:text-content-primary"}`}
                        onClick={() => setLearnShow(k)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <select
                    className="input"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      const it = items.find((x) => x.name === e.target.value);
                      if (it) setCells(String(it.grid_cells));
                    }}
                  >
                    <option value="">— 选择藏品 —</option>
                    {learnShow === "all" ? (
                      <>
                        <optgroup label="✓ 已学习">
                          {filteredItems.filter((it) => learned.has(it.name)).map((it) => (
                            <option key={it.id} value={it.name}>
                              {it.name}（{it.grid_cells}格）
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="未学习">
                          {filteredItems.filter((it) => !learned.has(it.name)).map((it) => (
                            <option key={it.id} value={it.name}>
                              {it.name}（{it.grid_cells}格）
                            </option>
                          ))}
                        </optgroup>
                      </>
                    ) : (
                      filteredItems.map((it) => (
                        <option key={it.id} value={it.name}>
                          {it.name}（{it.grid_cells}格）
                        </option>
                      ))
                    )}
                  </select>
                </>
              ) : (
                <input className="input" placeholder="新藏品名称" value={name} onChange={(e) => setName(e.target.value)} />
              )}
              <div>
                <label className="field-label">占用格数</label>
                <input
                  className="input"
                  type="number"
                  min="1"
                  value={cells}
                  onChange={(e) => {
                    setCells(e.target.value);
                    const c = Number(e.target.value);
                    if (c && !items.find((it) => it.name === name && it.grid_cells === c)) setName("");
                  }}
                  placeholder="如 4"
                />
              </div>
              <div className="text-[11px] text-content-secondary">
                当前格数下可选藏品 {filteredItems.length} 件；选项带 <span className="text-jade-400">✓已学</span> 表示已保存过学习样本
              </div>
              <button className="btn-primary w-full" onClick={handleSave} disabled={!box || !name.trim()}>
                {queue.length > 0
                  ? `保存并学习下一件（剩 ${queue.length}）`
                  : autoNext && items.some((it) => !learned.has(it.name))
                    ? "保存并学习下一件"
                    : "保存为学习样本"}
              </button>
              <label className="flex items-center gap-1.5 text-xs text-content-secondary">
                <input
                  type="checkbox"
                  className="accent-indigo-500"
                  checked={autoNext}
                  onChange={(e) => setAutoNext(e.target.checked)}
                />
                保存后自动跳下一件（关掉可继续给同一件多拍几张）
              </label>
              {name && learned.has(name) && (
                <button
                  className="btn-ghost w-full !py-1.5 text-xs text-vermilion-400"
                  onClick={async () => {
                    await api.visionDeleteLearn([name]);
                    setLearned((prev) => {
                      const s = new Set(prev);
                      s.delete(name);
                      return s;
                    });
                    setMsg(`已清除「${name}」的已学样本，可重新截图学习`);
                  }}
                >
                  清除「{name}」已学样本（重新学习）
                </button>
              )}
              {msg && <div className="rounded-xl border border-jade-400/30 bg-jade-soft px-3 py-2 text-xs text-jade-400">{msg}</div>}
              <p className="text-xs leading-relaxed text-content-secondary">
                保存后该区域会自动加入藏品图库：目录页能看到新图，后续拍卖截图按图匹配时会优先命中。
              </p>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
