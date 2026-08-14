import { useEffect, useRef, useState, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// BidKing 电影式落地页：单页滚动揭示（Hero → 数据 → 三重引擎 → 信任 → CTA）
// 仅用 Intersection Observer + CSS 动画，不引入 GSAP/Framer Motion。
// ---------------------------------------------------------------------------

const HERO_TEXT = "你愿意为一件看不见底价的藏品，出多少钱？";

const CSS = `
.landing {
  --bg: #0a0a0f;
  --bg-deep: #0d0f1a;
  --ink: #e8e4da;
  --dim: #8a8578;
  --gold: #c9a962;
  --gold-soft: rgba(201, 169, 98, 0.5);
  background: var(--bg);
  color: var(--ink);
  font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-weight: 300;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
  position: relative;
  overflow-x: hidden;
}

/* 噪点纹理叠加（固定全屏，极淡） */
.landing.noise::after {
  content: "";
  position: fixed;
  inset: 0;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E") repeat;
  opacity: 0.035;
  pointer-events: none;
  z-index: 9999;
}

.landing .serif {
  font-family: "Playfair Display", "Noto Serif SC", serif;
}

.landing .mono {
  font-family: "SF Mono", "JetBrains Mono", "Cascadia Code", Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

/* 通用滚动揭示 */
.landing .reveal {
  opacity: 0;
  transform: translateY(30px);
  transition: opacity 0.9s cubic-bezier(0.16, 1, 0.3, 1),
    transform 0.9s cubic-bezier(0.16, 1, 0.3, 1),
    filter 0.9s cubic-bezier(0.16, 1, 0.3, 1);
  will-change: transform, opacity;
}
.landing .reveal.visible {
  opacity: 1;
  transform: translateY(0);
  filter: blur(0);
}

/* 数据屏：从模糊到清晰 */
.landing .blur-in {
  filter: blur(10px);
  opacity: 0;
  transform: translateY(14px);
  transition: filter 1.1s cubic-bezier(0.16, 1, 0.3, 1),
    opacity 1.1s cubic-bezier(0.16, 1, 0.3, 1),
    transform 1.1s cubic-bezier(0.16, 1, 0.3, 1);
  will-change: filter, opacity, transform;
}
.landing .blur-in.visible {
  filter: blur(0);
  opacity: 1;
  transform: translateY(0);
}

/* Hero 打字机 */
.landing .char {
  opacity: 0;
  transition: opacity 0.35s ease;
}
.landing .char.shown {
  opacity: 1;
}

/* 向下滚动提示：缓慢呼吸 */
@keyframes l-breath {
  0%, 100% { opacity: 0.25; transform: translateY(0); }
  50% { opacity: 0.9; transform: translateY(8px); }
}
.landing .scroll-hint {
  animation: l-breath 2.6s ease-in-out infinite;
}

/* 每屏 */
.landing .screen {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12vh 6vw;
  position: relative;
}

/* 数据屏背景过渡到藏蓝 */
.landing .screen-data {
  background: linear-gradient(180deg, var(--bg) 0%, var(--bg-deep) 100%);
}

/* 数据屏细线 */
.landing .hairline {
  height: 1px;
  width: 0;
  background: var(--gold-soft);
  transition: width 1.2s cubic-bezier(0.16, 1, 0.3, 1);
  margin: 3.5rem auto 0;
}
.landing .hairline.visible {
  width: min(480px, 60vw);
}

/* 能力屏模块 */
.landing .cap-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4rem;
  align-items: center;
  min-height: 52vh;
}
@media (max-width: 860px) {
  .landing .cap-row { grid-template-columns: 1fr; gap: 2rem; }
}

/* 视觉识别：暗色截图 + 识别框扫描 */
.landing .shot {
  position: relative;
  aspect-ratio: 16 / 10;
  background:
    repeating-linear-gradient(0deg, transparent 0 19px, rgba(255,255,255,0.045) 19px 20px),
    repeating-linear-gradient(90deg, transparent 0 19px, rgba(255,255,255,0.045) 19px 20px),
    linear-gradient(135deg, #14141c 0%, #0d0d14 100%);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 2px;
  overflow: hidden;
}
.landing .shot .beam {
  position: absolute;
  inset: 0;
  background: radial-gradient(120% 90% at 30% 20%, rgba(201,169,98,0.10) 0%, transparent 55%);
  opacity: 0;
  transition: opacity 1.6s ease 0.3s;
}
.landing .shot.visible .beam { opacity: 1; }
.landing .shot .frame {
  position: absolute;
  left: 22%;
  top: 28%;
  width: 34%;
  height: 30%;
  border: 1px solid var(--gold);
  border-radius: 1px;
  opacity: 0;
  transform: scale(0.6);
  transition: opacity 0.7s ease 0.6s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.6s;
  box-shadow: 0 0 22px rgba(201,169,98,0.25);
}
.landing .shot .frame::after {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  height: 2px;
  width: 100%;
  background: var(--gold);
  transform-origin: left;
  transform: scaleX(0);
  transition: transform 1.4s cubic-bezier(0.16,1,0.3,1) 1.3s;
}
.landing .shot.visible .frame { opacity: 1; transform: scale(1); }
.landing .shot.visible .frame::after { transform: scaleX(1); }
.landing .shot .scan {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
  opacity: 0;
  top: 0;
  transition: opacity 0.5s ease 1.5s;
}
.landing .shot.visible .scan {
  opacity: 0.7;
  animation: l-scan 3.2s ease-in-out 1.5s infinite;
}
@keyframes l-scan {
  0% { top: 0; }
  50% { top: 99%; }
  100% { top: 0; }
}

/* 识别结果逐行浮现 */
.landing .res-line {
  opacity: 0;
  transform: translateX(16px);
  transition: opacity 0.6s ease, transform 0.6s cubic-bezier(0.16,1,0.3,1);
}
.landing .res-line.visible { opacity: 1; transform: translateX(0); }
.landing .res-line .k { color: var(--dim); font-size: 0.75rem; letter-spacing: 0.12em; }

/* 概率估值：区间线条从左到右绘制 */
.landing .range-wrap { position: relative; height: 3px; background: rgba(255,255,255,0.08); }
.landing .range-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 72%;
  background: linear-gradient(90deg, rgba(201,169,98,0) 0%, var(--gold) 100%);
  transform-origin: left;
  transform: scaleX(0);
  transition: transform 1.6s cubic-bezier(0.16,1,0.3,1) 0.3s;
}
.landing .range-wrap.visible .range-fill { transform: scaleX(1); }
.landing .range-dot {
  position: absolute;
  left: 72%;
  top: 50%;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--gold);
  transform: translate(-50%, -50%) scale(0);
  transition: transform 0.5s ease 1.6s;
}
.landing .range-wrap.visible .range-dot { transform: translate(-50%, -50%) scale(1); }

/* 出价策略卡片：从下方滑入 */
.landing .bid-card {
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 2px;
  padding: 1.8rem 2rem;
  max-width: 420px;
}

/* 信任屏字幕 */
.landing .film-line {
  opacity: 0;
  transform: translateY(22px);
  transition: opacity 1s cubic-bezier(0.16,1,0.3,1), transform 1s cubic-bezier(0.16,1,0.3,1);
  will-change: transform, opacity;
}
.landing .film-line.visible { opacity: 1; transform: translateY(0); }

/* 统计条 */
.landing .stat-bar {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2.5rem;
  border-top: 1px solid rgba(255,255,255,0.08);
  padding-top: 2.5rem;
  width: 100%;
  max-width: 720px;
}
@media (max-width: 640px) { .landing .stat-bar { grid-template-columns: 1fr; gap: 1.4rem; } }

/* CTA 金线按钮：无边框，hover 底部金线 0→100% */
.landing .cta-link {
  position: relative;
  display: inline-block;
  padding: 0.5rem 0.1rem;
  color: var(--gold);
  font-size: 1.05rem;
  letter-spacing: 0.22em;
  text-decoration: none;
  border: none;
  background: none;
  cursor: pointer;
  font-weight: 400;
}
.landing .cta-link::after {
  content: "";
  position: absolute;
  left: 0;
  bottom: 0;
  height: 1px;
  width: 0;
  background: var(--gold);
  transition: width 0.5s cubic-bezier(0.16,1,0.3,1);
}
.landing .cta-link:hover::after { width: 100%; }

/* 大号流式字号 */
.landing .f-hero { font-size: clamp(1.9rem, 5vw, 4.2rem); line-height: 1.35; }
.landing .f-num { font-size: clamp(3rem, 8vw, 7rem); line-height: 1; }
.landing .f-sec { font-size: clamp(1.7rem, 4vw, 3.1rem); line-height: 1.3; }

/* 减少动态偏好：禁用动画 */
@media (prefers-reduced-motion: reduce) {
  .landing *,
  .landing *::before,
  .landing *::after {
    animation: none !important;
    transition: none !important;
  }
  .landing .reveal, .landing .blur-in, .landing .char,
  .landing .res-line, .landing .film-line {
    opacity: 1 !important;
    transform: none !important;
    filter: none !important;
  }
  .landing .hairline { width: min(480px, 60vw) !important; }
  .landing .range-fill { transform: scaleX(1) !important; }
  .landing .range-dot { transform: translate(-50%, -50%) scale(1) !important; }
  .landing .shot .frame { opacity: 1 !important; transform: scale(1) !important; }
  .landing .shot .beam, .landing .shot .scan { opacity: 1 !important; }
}
`;

// ------------------------------- 工具组件 ---------------------------------

function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setVis(true);
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={`reveal ${vis ? "visible" : ""} ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

function BlurIn({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setVis(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={`blur-in ${vis ? "visible" : ""} ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

function ShotVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setVis(true);
          io.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`shot ${vis ? "visible" : ""}`}>
      <div className="beam" />
      <div className="frame" />
      <div className="scan" />
    </div>
  );
}

function ResLine({ k, v, delay }: { k: string; v: string; delay: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setVis(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={`res-line ${vis ? "visible" : ""}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      <span className="k">{k}</span>{" "}
      <span className="text-[15px] tracking-wide">{v}</span>
    </div>
  );
}

function RangeVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setVis(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div className="py-6">
      <div className="mb-4 flex justify-between text-xs text-[var(--dim)]">
        <span className="mono">p10</span>
        <span className="mono">ev</span>
        <span className="mono">p90</span>
      </div>
      <div ref={ref} className={`range-wrap ${vis ? "visible" : ""}`}>
        <div className="range-fill" />
        <div className="range-dot" />
      </div>
      <div className="mt-4 flex justify-between text-xs text-[var(--dim)]">
        <span className="mono">120,400</span>
        <span className="mono" style={{ color: "var(--gold)" }}>
          289,700
        </span>
        <span className="mono">458,000</span>
      </div>
    </div>
  );
}

// ------------------------------- 页面本体 ---------------------------------

export default function LandingPage() {
  const [heroCount, setHeroCount] = useState(0);
  useEffect(() => {
    if (heroCount >= HERO_TEXT.length) return;
    const t = setTimeout(() => setHeroCount((c) => c + 1), 80);
    return () => clearTimeout(t);
  }, [heroCount]);

  return (
    <div className="landing noise">
      <style>{CSS}</style>

      {/* 第 1 屏：悬念开场 */}
      <section className="screen" style={{ background: "var(--bg)" }}>
        <div className="max-w-4xl text-center">
          <p className="serif f-hero leading-snug">
            {HERO_TEXT.split("").map((ch, i) => (
              <span key={i} className={`char ${i < heroCount ? "shown" : ""}`}>
                {ch}
              </span>
            ))}
          </p>
          <div
            className="scroll-hint mx-auto mt-16 text-sm"
            style={{ color: "var(--dim)" }}
          >
            ↓
          </div>
        </div>
      </section>

      {/* 第 2 屏：数据揭示 */}
      <section className="screen screen-data" style={{ flexDirection: "column" }}>
        <div className="grid w-full max-w-3xl grid-cols-1 gap-12 text-center sm:grid-cols-3">
          {[
            { n: "84", label: "局实战数据" },
            { n: "1,200+", label: "件藏品估值" },
            { n: "±15%", label: "预测精度" },
          ].map((d, i) => (
            <div key={i}>
              <BlurIn delay={i * 180}>
                <div className="mono f-num" style={{ color: "var(--gold)" }}>
                  {d.n}
                </div>
                <div className="mt-3 text-sm tracking-[0.18em] text-[var(--dim)]">
                  {d.label}
                </div>
              </BlurIn>
            </div>
          ))}
        </div>
        <div className="w-full text-center">
          <div className="hairline" ref={(el) => {
            if (el) {
              const io = new IntersectionObserver(
                ([e]) => {
                  if (e.isIntersecting) {
                    el.classList.add("visible");
                    io.disconnect();
                  }
                },
                { threshold: 0.5 },
              );
              io.observe(el);
            }
          }} />
        </div>
      </section>

      {/* 第 3 屏：能力展示（分步揭示） */}
      <section className="screen" style={{ background: "var(--bg)", flexDirection: "column", alignItems: "flex-start" }}>
        <Reveal className="mb-16">
          <h2 className="serif f-sec" style={{ color: "var(--ink)" }}>
            三重估值引擎
          </h2>
          <div className="mt-3 text-sm tracking-[0.16em] text-[var(--dim)]">
            THREE-VECTOR VALUATION
          </div>
        </Reveal>

        <div className="w-full space-y-28">
          {/* 模块 1：视觉识别 */}
          <Reveal>
            <div className="cap-row">
              <div>
                <ShotVisual />
              </div>
              <div className="space-y-5">
                <h3 className="serif text-2xl">视觉识别</h3>
                <ResLine k="藏品" v="萧何月白青花瓷瓶" delay={200} />
                <ResLine k="格数" v="2 × 2" delay={400} />
                <ResLine k="估价" v="¥ 114,988" delay={600} />
                <p className="text-sm text-[var(--dim)]">
                  ResNet50 视觉模型，0.3 秒识别棋盘布局
                </p>
              </div>
            </div>
          </Reveal>

          {/* 模块 2：概率估值 */}
          <Reveal>
            <div className="cap-row">
              <div>
                <h3 className="serif text-2xl">概率估值</h3>
                <p className="mt-4 max-w-md text-sm text-[var(--dim)]">
                  蒙特卡洛模拟 400 组组合，输出置信区间
                </p>
              </div>
              <RangeVisual />
            </div>
          </Reveal>

          {/* 模块 3：出价策略 */}
          <Reveal>
            <div className="cap-row">
              <div>
                <h3 className="serif text-2xl">出价策略</h3>
                <p className="mt-4 max-w-md text-sm text-[var(--dim)]">
                  基于 p10 保守估值，避免赢家诅咒
                </p>
              </div>
              <div className="bid-card" style={{ transform: "translateY(30px)" }}>
                <div className="text-xs tracking-[0.2em] text-[var(--dim)]">RECOMMENDED BID</div>
                <div className="mono mt-3 text-3xl" style={{ color: "var(--gold)" }}>
                  287,000
                </div>
                <div className="mt-5 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-[var(--dim)]">风险等级</span>
                    <span style={{ color: "var(--gold)" }}>中等</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--dim)]">最坏情况</span>
                    <span>+23%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--dim)]">置信区间</span>
                    <span className="mono">120K – 458K</span>
                  </div>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* 第 4 屏：信任建立 */}
      <section className="screen" style={{ background: "var(--bg-deep)", flexDirection: "column" }}>
        <div className="max-w-2xl space-y-10 text-center">
          {[
            "第 37 局，均格 4.2，系统建议放弃。实际成交价超出估值 340%。",
            "第 52 局，3 件红品，推荐出价 287,000。最终以 265,000 拍得。",
            "第 71 局，识别到 6 格红品，估值区间 180K-420K。成交价 295K。",
          ].map((line, i) => (
            <FilmLine key={i} delay={i * 150}>
              <p className="text-[clamp(1rem,2.2vw,1.1rem)] leading-loose">{line}</p>
            </FilmLine>
          ))}
        </div>
        <div className="mt-20 w-full text-center">
          <div className="stat-bar" style={{ margin: "0 auto" }}>
            {[
              ["平均回报率", "+23%"],
              ["识别准确率", "94%"],
              ["累计节省", "¥2.1M"],
            ].map(([k, v], i) => (
              <FilmLine key={k} delay={400 + i * 120}>
                <div className="text-xs tracking-[0.18em] text-[var(--dim)]">{k}</div>
                <div className="mono mt-1 text-2xl" style={{ color: "var(--gold)" }}>
                  {v}
                </div>
              </FilmLine>
            ))}
          </div>
        </div>
      </section>

      {/* 第 5 屏：行动召唤 */}
      <section className="screen" style={{ background: "var(--bg)", flexDirection: "column" }}>
        <Reveal>
          <p className="serif f-sec text-center">你的下一局，从这里开始。</p>
        </Reveal>
        <Reveal delay={250}>
          <div className="mt-10 text-center">
            <a href="/app" className="cta-link">
              开始估值
            </a>
          </div>
        </Reveal>
        <Reveal delay={450}>
          <div className="mt-8 text-center text-xs tracking-[0.14em] text-[var(--dim)]">
            免费使用 · 无需注册 · 本地运行
          </div>
        </Reveal>
      </section>
    </div>
  );
}

function FilmLine({
  children,
  delay = 0,
}: {
  children: ReactNode;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setVis(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={`film-line ${vis ? "visible" : ""}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
