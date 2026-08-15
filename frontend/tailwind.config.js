/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /* ── 墨黑系（Ink）— 背景层 ── */
        ink: {
          950: "#0E0E12", // 全局画布
          900: "#16161C", // 卡片/面板
          850: "#1C1C24", // 弹出层/嵌套
          800: "#22222B", // 输入框/hover
          700: "#2E2E38", // 极细边框
          600: "#3A3A48", // 标准边框
          500: "#545466", // 禁用边框
        },
        /* ── 鎏金（Gold）— 品牌强调 ── */
        gold: {
          300: "#E8D4A0", // 浅金 hover
          400: "#D4B978", // 标准金
          500: "#C9A962", // 品牌金
          600: "#B8964E", // 深金 active
          soft: "rgba(201, 169, 98, 0.12)",
        },
        /* ── 翠绿（Jade）— 成功/盈利/低风险 ── */
        jade: {
          400: "#5BBA8A",
          500: "#4A9A6A",
          soft: "rgba(74, 154, 106, 0.12)",
        },
        /* ── 朱红（Vermilion）— 危险/亏损/高风险 ── */
        vermilion: {
          400: "#E06B6B",
          500: "#C44A4A",
          soft: "rgba(196, 74, 74, 0.12)",
        },
        /* ── 琥珀（Amber）— 警告/中风险/训练中 ── */
        amber: {
          400: "#E0B056",
          500: "#C99A3E",
          soft: "rgba(201, 154, 62, 0.12)",
        },
        /* ── 文字色 ── */
        content: {
          primary: "#ECE9E4",
          secondary: "#A8A4A0",
          tertiary: "#6E6B68",
          inverse: "#16161C",
          money: "#E8D4A0",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "Noto Sans SC",
          "PingFang SC",
          "Microsoft YaHei",
          "system-ui",
          "sans-serif",
        ],
        display: ["DM Sans", "Inter", "Noto Sans SC", "sans-serif"],
        mono: [
          "JetBrains Mono",
          "SF Mono",
          "Cascadia Code",
          "Consolas",
          "monospace",
        ],
      },
      borderRadius: {
        sm: "6px",
        md: "8px",
        lg: "12px",
        xl: "16px",
      },
      boxShadow: {
        sm: "0 1px 2px rgba(0, 0, 0, 0.4)",
        md: "0 4px 12px rgba(0, 0, 0, 0.5)",
        lg: "0 8px 24px rgba(0, 0, 0, 0.6)",
        xl: "0 16px 48px rgba(0, 0, 0, 0.7)",
        glow:
          "0 0 0 1px rgba(201, 169, 98, 0.12), 0 4px 16px rgba(201, 169, 98, 0.15)",
      },
      animation: {
        "fade-up": "fadeUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "fade-in": "fadeIn 0.3s ease-out forwards",
        "scale-in": "scaleIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "pulse-slow": "pulse 2s ease-in-out infinite",
      },
      keyframes: {
        fadeUp: {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        fadeIn: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        scaleIn: {
          from: { opacity: "0", transform: "scale(0.95)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        pulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
      },
      transitionTimingFunction: {
        out: "cubic-bezier(0.16, 1, 0.3, 1)",
        "in-out": "cubic-bezier(0.65, 0, 0.35, 1)",
        spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
    },
  },
  plugins: [],
};
