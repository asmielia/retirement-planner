# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start development server (Vite)
npm run build        # Run tests + production build
npm run preview      # Preview production build
npm test             # Run tests only (vitest)
npm run test:watch   # Run tests in watch mode
```

## Architecture

This is a single-page Canadian retirement planning calculator. The codebase is modular — the core engine, tax logic, constants, and UI are split across separate files. There is no routing, no backend, and no external state management.

### Key files

| File | Purpose |
|------|---------|
| `src/App.jsx` (~246 lines) | Main component. State management (`useState`), page navigation, wires inputs to projection engines. |
| `src/projection.js` (~433 lines) | **Single-person projection engine.** CPP/OAS optimization, year-by-year loop, iterative net-income targeting, withdrawal allocation, RRIF minimums, RRSP meltdown, tax credits. |
| `src/couple.js` (~561 lines) | **Couple projection engine.** Mirrors `projection.js` for two people with proportional withdrawal splitting, pension income splitting, and per-person tax. |
| `src/tax.js` (~91 lines) | Province/federal tax data for 10 provinces, progressive bracket math (`calcProgressiveTax`), marginal rate helpers, pension income credit, age amount credit, `calcTotalTaxAndClawback`. |
| `src/constants.js` (~58 lines) | Default values, RRIF minimum withdrawal table, page definitions, storage keys. |
| `src/surplus.js` / `src/coupleSurplus.js` | Surplus mode strategies: boost spending, max estate, retire early. |
| `src/share.js` | URL-based sharing (encode/decode), localStorage save/load. |
| `src/t4Parser.js` / `src/T4UploadButton.jsx` | T4 tax slip upload and parsing via Claude Vision API. |
| `src/components.jsx` | Shared UI primitives: `Field`, `SelectField`, `StatCard`, `SectionTitle`, `Explanation`. |
| `src/formatters.js` | Number/currency formatting helpers: `fmt()`, `fmtK()`, `pct()`. |
| `src/pages/Page1-7_*.jsx` | Seven page components (Personal, Savings, CPP & OAS, Rates, Income, Results, Charts). |
| `src/projection.test.js` | 100 tests covering tax math, CPP/OAS optimization, withdrawal sequencing, net-income targeting, RRIF minimums, tax credits, and more. |

### Data flow

All state lives in `App` via `useState`. `runProjection(inputs)` (single) or `runCoupleProjection(inputs)` (couple mode) is memoized with `useMemo` and recomputes whenever any input changes. Results flow down as props to page components.

### Projection engine design

The engines use **iterative net-income targeting**: the user specifies desired net income (after tax + OAS clawback), and the engine iterates to find the gross withdrawal amount that delivers that net. Key features:

- **Withdrawal sequencing**: Cash → RRSP (capped at OAS threshold when receiving OAS, uncapped pre-OAS) → Non-Reg → TFSA
- **RRSP meltdown**: Draws extra RRSP when current marginal rate < terminal tax rate (estimated at death). Pre-OAS years are uncapped for aggressive meltdown.
- **RRIF minimums**: Mandatory withdrawals at age 72+ (5.28% rising to 20% at 95+) enforced as floor on RRSP withdrawals.
- **OAS 75+ enhancement**: OAS automatically increases 10% at age 75.
- **Tax credits**: Pension income credit ($2,000 at 65+) and age amount credit ($9,028 at 65+, clawed back above ~$44K).
- **Pension income splitting** (couples): Optimizes split of eligible RRIF/pension income between spouses at 65+.
- **Three spending phases**: Active (retirement–70), Slowdown (70–85), Inactive (85+) with smooth transitions.

### Tech stack

- **React 18** with hooks (`useState`, `useMemo`, `useCallback`)
- **Vite 5** for dev/build
- **Vitest** for testing (100 tests)
- **Tailwind CSS 3** for styling (dark slate theme, amber accents)
- **Recharts** for interactive charts on Page 7
- Google Fonts: Playfair Display (headings) + DM Sans (body)

### Default inputs (in `src/constants.js`)

Age 35 → retire 65 → life expectancy 90; RRSP $50K, TFSA $40K, Non-Reg $20K, Cash $15K; 6% pre-retirement / 4% post-retirement / 2% inflation; CPP $17,196/yr at 65, OAS $8,908/yr at 65, clawback threshold $95,323.
