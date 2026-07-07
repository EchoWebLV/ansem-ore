import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bull: {
          green: "#35e07a",
          gold: "#e8c452",
          bg: "#0b0b0e",
          dim: "#2c4034",
          muted: "#8a8a93",
          edge: "#23232a",
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
