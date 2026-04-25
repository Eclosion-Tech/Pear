import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}", "./public/**/*.{html,js}"],
  darkMode: "class",
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
