import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bull: {
          green: "#a8f080",
          gold: "#d6b75f",
          bg: "#0a0b0a",
          surface: "#111310",
          raised: "#161916",
          dim: "#344035",
          muted: "#92978f",
          edge: "#292d28",
          ink: "#f2f1e9",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
