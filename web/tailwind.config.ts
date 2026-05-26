import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
    "./public/**/*.{html,js}",
    "../packages/pulp/src/**/*.{ts,tsx}",
  ],
  darkMode: "class",
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
