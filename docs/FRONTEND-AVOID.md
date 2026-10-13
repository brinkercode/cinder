# Frontend: what to avoid (the "vibe-coded" look)

Researched 2026-10-03. Visual design belongs to the designer. This note only sets the floor: nothing may ship that looks like an unedited default.

Core finding: no single default is the problem. The tell is many unedited defaults stacked together ("One default is harmless. Ten defaults together create the vibe coded look", [VibeMole](https://vibemole.com/resources/avoid-vibecoded-app-design)). Models regress to the statistical mean of tutorials and starter templates ([CodeMySpec](https://codemyspec.com/blog/vibe-coded-websites-look-the-same), [BrainGrid](https://www.braingrid.ai/blog/design-system-optimized-for-ai-coding)).

## 1. Comfort packages

| Package | Why it reads as AI-made |
|---|---|
| shadcn/ui (+ Radix/Base UI default styling) | The default for Lovable/v0/Bolt. HN: "when every LLM defaults to using this UI, it just makes mine look LLM generated" ([HN](https://news.ycombinator.com/item?id=47985052), [HN](https://news.ycombinator.com/item?id=48496483)) |
| Tailwind default palette/spacing (`indigo-500`, `slate-900`, `rounded-2xl`) | Adam Wathan publicly regretted making `bg-indigo-500` the Tailwind UI accent, now "every AI-generated interface on earth is purple" ([dev.to](https://dev.to/alanwest/why-every-ai-built-website-looks-the-same-blame-tailwinds-indigo-500-3h2p)) |
| lucide-react, Heroicons | The shadcn default icon set; first fix people suggest is to swap it ([X/@tomilola_ng](https://x.com/tomilola_ng/status/2080615247686017170), [The Crit](https://thecrit.co/resources/vibe-coding-design-guide)) |
| Inter, Geist (also Space Grotesk, Instrument Serif, DM Sans, Manrope) | Inter is the neutral fallback. Geist ships in Vercel/Next/shadcn templates ([Fontlark](https://fontlark.com/fonts-vibe-coded-apps-use/), [Developers Digest](https://www.developersdigest.tech/blog/ai-design-slop-and-how-to-spot-it)) |
| framer-motion / motion entrance fades | "Add animations" prompts give generic fade-ins ([UI Motion Prompts](https://uimotionprompts.com/blog/add-animations-to-vibe-coded-apps)) |
| sonner, recharts (defaults) | Part of the standard generated stack next to shadcn + framer-motion ([example](https://github.com/abhishekaj28/Focus-Flow), [example](https://github.com/roni-altshuler/SongAnalyzer)). Weaker evidence: this is common practice, not a named critique |
| v0 / Lovable / Bolt scaffolds | All emit React + Tailwind + shadcn, so every app starts from the same pixels ([BrainGrid](https://www.braingrid.ai/blog/design-system-optimized-for-ai-coding), [CodeMySpec](https://codemyspec.com/blog/vibe-coded-websites-look-the-same)) |

## 2. Visual clichés

- Purple-to-blue gradients, colored glows and box-shadows, blurred orbs, neon borders ([VibeMole](https://vibemole.com/resources/avoid-vibecoded-app-design), [Developers Digest](https://www.developersdigest.tech/blog/ai-design-slop-and-how-to-spot-it))
- Gradient hero text, centered hero with a pill badge above the H1 ([CodeMySpec](https://codemyspec.com/blog/vibe-coded-websites-look-the-same))
- Glassmorphism, backdrop-blur panels ([isthatvibecoded](https://isthatvibecoded.com/))
- Three identical `rounded-2xl` icon-on-top cards, "1-2-3" steps, stat banner rows, a cookie-cutter section order (hero, features, proof, pricing, FAQ) ([Developers Digest](https://www.developersdigest.tech/blog/ai-design-slop-and-how-to-spot-it), [dev.to](https://dev.to/alanwest/why-every-ai-built-website-looks-the-same-blame-tailwinds-indigo-500-3h2p))
- Emoji in headings or nav (🚀 ✨), all-caps eyebrow labels ([Developers Digest](https://www.developersdigest.tech/blog/ai-design-slop-and-how-to-spot-it))
- Permanent dark mode with grey body text that barely passes contrast ([Developers Digest](https://www.developersdigest.tech/blog/ai-design-slop-and-how-to-spot-it))
- Generic dashboard: sidebar, three stat cards, a chart nobody reads ([BrainGrid](https://www.braingrid.ai/blog/design-system-optimized-for-ai-coding))
- One-side colored card borders, nested cards, pulsing badges, moving gradients ([VibeMole](https://vibemole.com/resources/avoid-vibecoded-app-design))
- Copy like "Empower", "Unlock", "Seamless" ([CodeMySpec](https://codemyspec.com/blog/vibe-coded-websites-look-the-same))
- Shimmer skeletons everywhere: I found no strong source for this one. Treat it as house taste. Use skeletons only where the layout really shifts.

## 3. Lean base

- **Styling:** plain CSS with custom properties as the token layer, scoped with CSS Modules (built into Vite). Add vanilla-extract only if typed tokens prove necessary. The designer owns `tokens.css`.
- **Native first:** `<dialog>`, the Popover API, `<details>`, CSS anchor positioning (Baseline 2026: Chrome 125+, Safari 26, Firefox 147, per [refonte](https://www.refontelearning.com/blog/css-anchor-positioning-reaches-baseline)), View Transitions (React Router 7 `viewTransition`), `@starting-style`, `:has()`, container queries.
- **Accessibility:** use `react-aria` hooks only for widgets the platform lacks (combobox, grid, tree). Never a pre-styled kit.
- **Icons:** `react-icons/pi` (Phosphor, regular weight) only, imported per icon; `Shell` adds the `.ico` class and `aria-hidden` through `IconContext`. No other icon set or package.
- **Type:** a typeface the designer chooses on purpose, or a tuned system stack for UI chrome. Note: Anthropic's frontend-design guidance treats system fonts as a default too ([Claude blog](https://claude.com/blog/improving-frontend-design-through-skills)), so this is a decision to make, not a free pass.
- **Charts:** hand-rolled SVG for sparklines. A chart library only when needed, and fully themed.

## 4. CI-checkable rules

1. **package.json deny-list** (fails if any of these is a dependency): `tailwindcss`, `@tailwindcss/*`, `tailwind-merge`, `class-variance-authority`, `@radix-ui/*`, `@base-ui-components/*`, `lucide-react`, `@heroicons/react`, `react-icons`, `framer-motion`, `motion`, `sonner`, `react-hot-toast`, `recharts`, `@fontsource/inter`, `@fontsource-variable/inter`, `geist`, `@floating-ui/*`, `daisyui`.
2. **eslint `no-restricted-imports`** with the same names as `patterns`, plus `@/components/ui/*` (the shadcn path).
3. **No `components.json`** (shadcn config) and no `tailwind.config.*` in the repo.
4. **Stylelint/grep on CSS:** no `backdrop-filter`; no `background-clip: text`; color literals only in `tokens.css` (`color-no-hex` everywhere else); no `font-family` other than `var(--font-*)`.
5. **Copy grep** over `*.jsx`: no emoji in JSX text; no "Unlock", "Empower", "Seamless".
6. **Override file:** any exception needs an entry in `docs/FRONTEND-EXCEPTIONS` with a reason.


Icons come from `react-icons/pi` (the Phosphor family). This replaces the vendored SVGs and is the only icon package allowed.
