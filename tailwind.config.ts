import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    // Product-mode radii — ETS logo tile keeps 0 via inline style
    borderRadius: {
      none: "0px",
      sm: "4px",
      DEFAULT: "8px",
      md: "8px",
      lg: "10px",   // cards
      xl: "12px",
      "2xl": "16px",
      full: "9999px",
    },
    // Inter for all UI; Poppins for display; Space Mono for data/code only
    fontFamily: {
      sans: ["Inter", "system-ui", "sans-serif"],
      display: ["Poppins", "system-ui", "sans-serif"],
      mono: ['"Space Mono"', "ui-monospace", "monospace"],
    },
    extend: {
      colors: {
        // ── ETS Product Light tokens ─────────────────────────────────
        // theme-aware: values live in src/index.css (light and dark)
        "app-bg":      "var(--app-bg)",
        "app-surface": "var(--app-surface)",
        "app-raised":  "var(--app-raised)",
        "app-border":  "var(--app-border)",
        "app-ink":     "var(--app-ink)",
        "app-ink-2":   "var(--app-ink-2)",
        "app-ink-3":   "var(--app-ink-3)",
        "on-volt":     "var(--on-volt)",
        // brand accent — fills/active only, black ink on top
        volt: "#FBFF00",
        // status
        ok:     "#1E9E62",
        warn:   "#C77D11",
        danger: "#D2402E",
        info:   "#2F6FE0",
        // ── shadcn compat ────────────────────────────────────────────
        background: "#FFFFFF",
        foreground: "#0A0A0A",
        card:     { DEFAULT: "#FFFFFF",  foreground: "#0A0A0A" },
        popover:  { DEFAULT: "#FFFFFF",  foreground: "#0A0A0A" },
        primary:  { DEFAULT: "#0A0A0A",  foreground: "#FFFFFF" },
        secondary:{ DEFAULT: "#F7F8FA",  foreground: "#0A0A0A" },
        muted:    { DEFAULT: "#F7F8FA",  foreground: "#565B62" },
        accent:   { DEFAULT: "#EEF1F4",  foreground: "#0A0A0A" },
        destructive: { DEFAULT: "#D2402E", foreground: "#FFFFFF" },
        border: "#E3E7EC",
        input:  "#E3E7EC",
        ring:   "#0A0A0A",
      },
      boxShadow: {
        card: "0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.04)",
        raised: "0 2px 4px rgba(16,24,40,.08), 0 1px 2px rgba(16,24,40,.04)",
      },
      letterSpacing: {
        display: "-0.01em",
        ui:   "0.12em",
        label: "0.18em",
      },
    },
  },
  plugins: [animate],
};

export default config;
