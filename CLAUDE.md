# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start development server (Vite)
npm run build     # Production build
npm run preview   # Preview production build
```

No test or lint scripts are configured.

## Architecture

This is a single-page Canadian retirement planning calculator built as a **single monolithic React component** in `src/App.jsx` (~755 lines). There is no routing, no backend, and no external state management.

### Data flow

All state lives in `App` via `useState`. `runProjection(inputs)` is memoized with `useMemo` and recomputes whenever any input changes. The result flows down as props to each page component.

### Key sections in App.jsx (in order)

1. **Province/federal tax data** (lines 7–33) — static objects for 10 Canadian provinces plus federal brackets; `calcProgressiveTax()` implements progressive bracket math.

2. **`runProjection(inputs)`** (lines 38–187) — the core financial engine:
   - Optimizes CPP start age (60–70) and OAS start age (65–70) by simulating all options and picking the one maximizing lifetime benefits given the user's life expectancy.
   - Runs a year-by-year loop from current age to life expectancy tracking four account types: RRSP, TFSA, Non-Reg, Cash/Savings.
   - Withdrawal sequencing: Cash → Non-Reg → RRSP (capped at OAS clawback threshold) → TFSA.
   - Calculates federal + provincial tax with OAS clawback (15% above threshold) each year.

3. **Formatting helpers** (lines 192–202) — `fmt()`, `fmtK()`, `pct()`.

4. **Shared UI primitives** (lines ~204–282) — `Field`, `SelectField`, `StatCard`, `SectionTitle`, `Explanation`.

5. **Seven page components** (lines ~284–660):
   - Page 1: Personal (age, province)
   - Page 2: Savings (RRSP/TFSA/Non-Reg/Cash balances and contributions)
   - Page 3: Income (three retirement spending phases: active/slowdown/inactive)
   - Page 4: Rates (growth, inflation; shows province tax brackets)
   - Page 5: CPP & OAS (benefit amounts, optimal claiming ages table)
   - Page 6: Results (plan status, key metrics, withdrawal strategy summary)
   - Page 7: Charts (four Recharts visualizations + year-by-year table)

6. **Main `App` component** (lines ~685–754) — sticky progress bar, page navigation, default input values.

### Tech stack

- **React 18** with hooks (`useState`, `useMemo`, `useCallback`)
- **Vite 5** for dev/build
- **Tailwind CSS 3** for styling (dark slate theme, amber accents)
- **Recharts** for the four interactive charts on Page 7
- Google Fonts: Playfair Display (headings) + DM Sans (body)

### Default inputs (defined around line 665)

Age 35 → retire 65 → life expectancy 90; RRSP $50K, TFSA $40K, Non-Reg $20K, Cash $15K; 6% pre-retirement / 4% post-retirement / 2% inflation; CPP $17,196/yr at 65, OAS $8,908/yr at 65, clawback threshold $95,323.
