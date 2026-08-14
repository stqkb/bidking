/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 深色高级主题（带温度的近黑）
        ink: {
          950: "#111114", // 主背景
          900: "#1a1a1f", // 卡片/面板背景
          850: "#1a1a1f",
          800: "#222228", // 输入框/hover 背景
          700: "#2a2a32", // 极细边框
          600: "#3a3a44", // 焦点边框
          500: "#4a4a54",
        },
        // 唯一强调色：暖金
        accent: {
          DEFAULT: "#c9a962",
          soft: "rgba(201,169,98,0.12)",
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
    },
  },
  plugins: [],
};
