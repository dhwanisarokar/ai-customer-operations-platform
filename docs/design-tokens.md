# Design tokens

The theme lives in `src/app/globals.css` as shadcn CSS variables (oklch), light and dark (follows OS).

- **Neutrals:** warm stone (hue 85, chroma <= 0.012). Off-white background, never pure white; off-black in dark mode.
- **Accent:** one deep teal (hue 185-190) for primary actions, focus rings, active nav. Do not add a second brand accent.
- **Semantics:** destructive is red; use chart-2 (amber), chart-4 (green) for warning/success states.
- **Shape:** one radius system, `--radius: 0.625rem` (buttons/inputs sm-md, cards lg).
- **Type:** Geist sans for everything, Geist Mono for IDs/code. No display serif.
- **Elevation:** borders over shadows; cards are `--card` with a 1px `--border`.
- **Contrast:** body text and primary-on-background meet WCAG AA in both themes; check any new color pairs.

Inspired by warm-neutral editorial dashboards (cream base, single accent), with our own accent so the product has its own identity.
