import { useState, useMemo, useEffect, useCallback } from "react";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from "recharts";

// ═══════════════════════════════════════════════
// PROVINCE TAX DATA
// ═══════════════════════════════════════════════
const PROVINCES = {
  Ontario:        { bpa:11865, brackets:[[53891,.0505],[107785,.0915],[150000,.1116],[220000,.1216],[Infinity,.1316]] },
  "British Columbia": { bpa:12932, brackets:[[47937,.0506],[95875,.077],[110076,.105],[133664,.1229],[Infinity,.205]] },
  Alberta:        { bpa:22769, brackets:[[61200,.1],[122399,.12],[163258,.13],[245087,.14],[Infinity,.15]] },
  Saskatchewan:   { bpa:20381, brackets:[[54532,.105],[155805,.125],[Infinity,.145],[Infinity,.145],[Infinity,.145]] },
  Manitoba:       { bpa:15780, brackets:[[47000,.108],[100000,.1275],[200000,.174],[Infinity,.205],[Infinity,.205]] },
  Quebec:         { bpa:18056, brackets:[[54345,.14],[108680,.19],[132245,.24],[Infinity,.2575],[Infinity,.2575]] },
  "New Brunswick":{ bpa:13396, brackets:[[52333,.094],[104666,.14],[176225,.16],[Infinity,.195],[Infinity,.195]] },
  "Nova Scotia":  { bpa:11481, brackets:[[30995,.0879],[61991,.1495],[97417,.1667],[157124,.175],[Infinity,.21]] },
  PEI:            { bpa:13500, brackets:[[33928,.095],[65820,.1347],[106890,.1637],[142250,.182],[Infinity,.187]] },
  Newfoundland:   { bpa:11067, brackets:[[44678,.087],[89354,.145],[159528,.158],[223340,.178],[Infinity,.218]] },
};

const FED_BRACKETS_DEFAULT = { bpa:16429, brackets:[[58523,.14],[117045,.205],[181440,.26],[258482,.29],[Infinity,.33]] };

function calcProgressiveTax(income, bpa, brackets) {
  const taxable = Math.max(0, income - bpa);
  let tax = 0, prev = 0;
  for (const [threshold, rate] of brackets) {
    const bracketTop = threshold - bpa;
    const inBracket = Math.max(0, Math.min(taxable - prev, bracketTop - prev));
    tax += inBracket * rate;
    prev = bracketTop;
    if (taxable <= bracketTop) break;
  }
  return tax;
}

// ═══════════════════════════════════════════════
// TAX RATE HELPERS
// ═══════════════════════════════════════════════
function getMarginalRate(income, bpa, brackets) {
  const taxable = Math.max(0, income - bpa);
  for (const [threshold, rate] of brackets) {
    if (taxable <= threshold - bpa) return rate;
  }
  return brackets[brackets.length - 1][1];
}

function getCombinedMarginalRate(income, fedBpa, fedBrackets, provBpa, provBrackets) {
  return getMarginalRate(income, fedBpa, fedBrackets) + getMarginalRate(income, provBpa, provBrackets);
}

function estimateTerminalTaxRate(rrspBal, provData, fedBrackets, infFactor) {
  // At death the full RRSP balance is deemed taxable income
  const fedBpa = fedBrackets.bpa * infFactor;
  const fedBrk = fedBrackets.brackets.map(([t, r]) => [t * infFactor, r]);
  const provBpa = provData.bpa * infFactor;
  const provBrk = provData.brackets.map(([t, r]) => [t * infFactor, r]);
  return getCombinedMarginalRate(rrspBal, fedBpa, fedBrk, provBpa, provBrk);
}

// ═══════════════════════════════════════════════
// CORE PROJECTION ENGINE
// ═══════════════════════════════════════════════
function runProjection(inputs, strategy = "optimize") {
  const { currentAge, retirementAge, lifeExpectancy, province,
    rrspBal, tfsaBal, nonRegBal, savingsBal,
    rrspContrib, tfsaContrib, nonRegContrib, savingsContrib,
    activeIncome, slowdownIncome, inactiveIncome,
    pensionIncome, pensionBridge, otherIncome,
    preGrowth, postGrowth, inflation,
    cppAt65, oasAt65, oasClawbackThreshold,
    fedBrackets } = inputs;

  const provData = PROVINCES[province] || PROVINCES.Ontario;

  // CPP optimization (ages 60-70)
  const cppOptions = [];
  for (let age = 60; age <= 70; age++) {
    let adj;
    if (age < 65) adj = cppAt65 * (1 - 0.006 * (65 - age) * 12);
    else if (age === 65) adj = cppAt65;
    else adj = cppAt65 * (1 + 0.007 * (age - 65) * 12);
    const lifetime = adj * Math.max(0, lifeExpectancy - age);
    cppOptions.push({ age, annual: adj, lifetime });
  }
  const optCpp = cppOptions.reduce((a, b) => b.lifetime > a.lifetime ? b : a);

  // OAS optimization (ages 65-70)
  const oasOptions = [];
  for (let age = 65; age <= 70; age++) {
    let adj = age === 65 ? oasAt65 : oasAt65 * (1 + 0.006 * (age - 65) * 12);
    const lifetime = adj * Math.max(0, lifeExpectancy - age);
    oasOptions.push({ age, annual: adj, lifetime });
  }
  const optOas = oasOptions.reduce((a, b) => b.lifetime > a.lifetime ? b : a);

  // Year-by-year projection
  const rows = [];
  let rrsp = rrspBal, tfsa = tfsaBal, nonReg = nonRegBal, savings = savingsBal;

  for (let year = 1; year <= (lifeExpectancy - currentAge + 1); year++) {
    const age = currentAge + year - 1;
    if (age > lifeExpectancy) break;
    const infFactor = Math.pow(1 + inflation, year);
    const isRetired = age >= retirementAge;
    const phase = !isRetired ? "Accumulation" : age < 70 ? "Active" : age < 85 ? "Slowdown" : "Inactive";
    const growthRate = isRetired ? postGrowth : preGrowth;

    // Government benefits
    const cpp = age >= optCpp.age ? optCpp.annual * infFactor : 0;
    const oasGross = age >= optOas.age ? optOas.annual * infFactor : 0;

    // Pension and bridge are fixed nominal amounts (most DB pensions are not indexed to inflation)
    // Other income (rental, part-time, etc.) is inflation-adjusted
    const pension = isRetired ? pensionIncome : 0;
    const bridge = (isRetired && age < 65) ? pensionBridge : 0;
    const other = isRetired ? otherIncome * infFactor : 0;

    // Desired income (nominal)
    let desiredBase = 0;
    if (isRetired) {
      desiredBase = age < 70 ? activeIncome : age < 85 ? slowdownIncome : inactiveIncome;
    }
    const desiredNominal = desiredBase * infFactor;

    // Portfolio need from savings (after all guaranteed income sources)
    const portfolioNeed = Math.max(0, desiredNominal - cpp - oasGross - pension - bridge - other);

    // Available balances (with growth applied)
    const rrspAvail = rrsp * (1 + growthRate);
    const tfsaAvail = tfsa * (1 + growthRate);
    const nonRegAvail = nonReg * (1 + growthRate);
    const savAvail = savings; // no growth on cash

    // OAS clawback threshold (nominal)
    const oasThreshNom = oasClawbackThreshold * infFactor;

    // Tax bracket info for this year
    const fedBpa = fedBrackets.bpa * infFactor;
    const fedBrk = fedBrackets.brackets.map(([t, r]) => [t * infFactor, r]);
    const provBpa = provData.bpa * infFactor;
    const provBrk = provData.brackets.map(([t, r]) => [t * infFactor, r]);

    let savWd = 0, nrWd = 0, rrspWd = 0, tfsaWd = 0;
    if (isRetired) {
      // ── Tax-aware withdrawal allocation ──

      // Step 1: Cash savings first (no growth, no tax cost)
      // For spend_down mode, drain cash aggressively (no floor needed since goal is full depletion)
      // For other modes, maintain a cash floor of 2 months' spending as a safety net
      const cashFloor = strategy === "spend_down" ? 0 : (desiredNominal / 12) * 2;
      const savAvailAfterFloor = Math.max(0, savAvail - cashFloor);
      savWd = Math.min(savAvailAfterFloor, portfolioNeed);
      let rem = portfolioNeed - savWd;

      // Step 2: Determine RRSP withdrawal target
      const lockedIncome = cpp + oasGross + pension + bridge + other;
      const maxRrspForOas = Math.max(0, oasThreshNom - lockedIncome);
      const yearsToEnd = Math.max(1, lifeExpectancy - age);

      if (strategy === "optimize" || strategy === "max_estate") {
        // Smooth RRSP drawdown: spread remaining RRSP evenly across remaining years.
        // This keeps taxable income in lower brackets rather than filling to the
        // OAS threshold every year then cliff-dropping to zero when RRSP runs out.
        // The spending shortfall beyond the smooth RRSP target is filled by TFSA.
        const annualTarget = rrspAvail / yearsToEnd;
        const smoothRrsp = Math.min(annualTarget, maxRrspForOas);
        rrspWd = Math.min(rrspAvail, smoothRrsp);
      } else {
        // spend_down: simple fill up to OAS threshold
        rrspWd = Math.min(rrspAvail, rem, maxRrspForOas);
      }
      rem -= Math.min(rrspWd, rem);

      // Step 3: Non-registered (50% capital gains inclusion — moderate tax cost)
      nrWd = Math.min(nonRegAvail, rem);
      rem -= nrWd;

      // Step 4: TFSA (tax-free — blends with RRSP to smooth tax burden)
      tfsaWd = Math.min(tfsaAvail, rem);
      rem -= tfsaWd;

      // Step 5: If still short, dip into the cash floor as a last resort
      if (rem > 0) {
        const extraSav = Math.min(savAvail - savWd, rem);
        savWd += extraSav;
        rem -= extraSav;
      }
    }

    // Update balances
    if (isRetired) {
      const extraCash = Math.max(0, (savWd + nrWd + rrspWd + tfsaWd) - portfolioNeed);
      rrsp = Math.max(0, rrspAvail - rrspWd);
      tfsa = Math.max(0, tfsaAvail - tfsaWd);
      nonReg = Math.max(0, nonRegAvail - nrWd);
      savings = Math.max(0, savAvail - savWd + extraCash); // excess goes to cash
    } else {
      rrsp = rrsp * (1 + preGrowth) + rrspContrib;
      tfsa = tfsa * (1 + preGrowth) + tfsaContrib;
      nonReg = nonReg * (1 + preGrowth) + nonRegContrib;
      savings = savings + savingsContrib;
    }

    const totalPortfolio = rrsp + tfsa + nonReg + savings;

    // Taxable income: RRSP withdrawal + CPP + OAS + pension + bridge + other + NonReg growth (50% inclusion)
    const taxableIncome = isRetired ? rrspWd + cpp + oasGross + pension + bridge + other + Math.max(0, nonRegAvail * postGrowth * 0.5) : 0;

    // Tax calculation
    const fedTax = isRetired ? calcProgressiveTax(taxableIncome, fedBpa, fedBrk) : 0;
    const provTax = isRetired ? calcProgressiveTax(taxableIncome, provBpa, provBrk) : 0;
    const totalTax = fedTax + provTax;

    // OAS clawback
    const oasClawback = isRetired ? Math.min(oasGross, Math.max(0, (taxableIncome - oasThreshNom) * 0.15)) : 0;

    // Net income
    const netIncome = isRetired ? savWd + nrWd + rrspWd + tfsaWd + cpp + oasGross + pension + bridge + other - totalTax - oasClawback : 0;

    rows.push({
      year, age, phase, rrsp, tfsa, nonReg, savings,
      cpp, oasGross, pension, bridge, other, totalPortfolio,
      contribution: isRetired ? 0 : rrspContrib + tfsaContrib + nonRegContrib + savingsContrib,
      desiredNominal, savWd, nrWd, rrspWd, tfsaWd,
      taxableIncome, totalTax, oasClawback, netIncome,
      realPortfolio: totalPortfolio / infFactor,
    });
  }

  // Plan status
  const retRow = rows.find(r => r.age === retirementAge);
  const portfolioAtRet = retRow ? retRow.totalPortfolio : 0;

  // Surplus and estate value
  const lastRow = rows[rows.length - 1];
  const hasSurplus = lastRow && lastRow.totalPortfolio > 0;

  // Post-tax estate value estimate
  let estateValue = null;
  if (lastRow) {
    const finalInfFactor = Math.pow(1 + inflation, rows.length);
    const termRate = estimateTerminalTaxRate(lastRow.rrsp, provData, fedBrackets, finalInfFactor);
    const nrTaxRate = termRate * 0.5; // 50% inclusion on capital gains
    estateValue = {
      tfsa: lastRow.tfsa,
      savings: lastRow.savings,
      nonReg: lastRow.nonReg * (1 - nrTaxRate * 0.3), // approximate: ~30% of balance is gains
      rrsp: lastRow.rrsp * (1 - termRate),
      total: 0,
    };
    estateValue.total = estateValue.tfsa + estateValue.savings + estateValue.nonReg + estateValue.rrsp;
  }

  // Total lifetime tax: retirement taxes + terminal RRSP tax at death
  const retirementTax = rows.filter(r => r.age >= retirementAge).reduce((s, r) => s + r.totalTax + r.oasClawback, 0);
  const terminalRrspTax = lastRow ? (() => {
    const finalInfFactor = Math.pow(1 + inflation, rows.length);
    const rate = estimateTerminalTaxRate(lastRow.rrsp, provData, fedBrackets, finalInfFactor);
    return lastRow.rrsp * rate;
  })() : 0;
  const totalLifetimeTax = retirementTax + terminalRrspTax;

  return {
    rows, cppOptions, oasOptions, optCpp, optOas,
    portfolioAtRet, hasSurplus, estateValue,
    totalLifetimeTax, retirementTax, terminalRrspTax,
    activeYears: Math.max(0, Math.min(70, lifeExpectancy) - retirementAge),
    slowdownYears: Math.max(0, Math.min(85, lifeExpectancy) - Math.max(70, retirementAge)),
    inactiveYears: Math.max(0, lifeExpectancy - Math.max(85, retirementAge)),
  };
}

// ═══════════════════════════════════════════════
// SURPLUS MODE FUNCTIONS
// ═══════════════════════════════════════════════
function runBoostSpending(inputs) {
  // Binary search for a spending multiplier that depletes portfolio at life expectancy
  // Use "spend_down" strategy to skip RRSP top-up — the goal is smooth spending, not tax optimization
  let lo = 1.0, hi = 5.0;
  let bestResult = null;

  for (let i = 0; i < 25; i++) {
    const mid = (lo + hi) / 2;
    const boostedInputs = {
      ...inputs,
      activeIncome: inputs.activeIncome * mid,
      slowdownIncome: inputs.slowdownIncome * mid,
      inactiveIncome: inputs.inactiveIncome * mid,
    };
    const result = runProjection(boostedInputs, "spend_down");
    const endBal = result.rows[result.rows.length - 1]?.totalPortfolio ?? 0;

    if (endBal > 1000) { // small buffer to avoid oscillation
      lo = mid;
      bestResult = result;
    } else {
      hi = mid;
    }
  }

  const multiplier = (lo + hi) / 2;
  // Run final projection at the converged multiplier
  const finalInputs = {
    ...inputs,
    activeIncome: inputs.activeIncome * multiplier,
    slowdownIncome: inputs.slowdownIncome * multiplier,
    inactiveIncome: inputs.inactiveIncome * multiplier,
  };
  const finalResult = runProjection(finalInputs, "spend_down");

  return {
    ...finalResult,
    surplusMode: "boost_spending",
    hasSurplus: true,
    spendingMultiplier: multiplier,
    boostedActiveIncome: inputs.activeIncome * multiplier,
    boostedSlowdownIncome: inputs.slowdownIncome * multiplier,
    boostedInactiveIncome: inputs.inactiveIncome * multiplier,
  };
}

function runMaxEstate(inputs) {
  const result = runProjection(inputs, "max_estate");
  return {
    ...result,
    surplusMode: "max_estate",
    hasSurplus: true,
  };
}

// Find the max spending multiplier — this IS the funding ratio
// 1.0 = exactly funded, 1.3 = can spend 30% more, 0.7 = can only afford 70%
function findFundingRatio(inputs) {
  let lo = 0.0, hi = 5.0;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const testInputs = {
      ...inputs,
      activeIncome: inputs.activeIncome * mid,
      slowdownIncome: inputs.slowdownIncome * mid,
      inactiveIncome: inputs.inactiveIncome * mid,
    };
    const result = runProjection(testInputs);
    const endBal = result.rows[result.rows.length - 1]?.totalPortfolio ?? 0;
    if (endBal > 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

// ═══════════════════════════════════════════════
// FORMATTING HELPERS
// ═══════════════════════════════════════════════
const fmt = (n) => {
  if (n == null || isNaN(n)) return "$0";
  return "$" + Math.round(n).toLocaleString("en-CA");
};
const fmtK = (n) => {
  if (n == null || isNaN(n)) return "$0";
  if (Math.abs(n) >= 1000000) return "$" + (n / 1000000).toFixed(1) + "M";
  if (Math.abs(n) >= 1000) return "$" + (n / 1000).toFixed(0) + "K";
  return "$" + Math.round(n);
};
const pct = (n) => (n * 100).toFixed(1) + "%";

// ═══════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════

// Styled input field
function Field({ label, value, onChange, type = "currency", min, max, step, hint }) {
  const handleChange = (e) => {
    let v = e.target.value;
    if (type === "currency") v = parseFloat(v.replace(/[^0-9.-]/g, "")) || 0;
    else if (type === "percent") v = parseFloat(v) / 100 || 0;
    else v = parseInt(v) || 0;
    onChange(v);
  };
  const displayVal = type === "currency" ? value : type === "percent" ? (value * 100).toFixed(1) : value;
  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-slate-300 mb-1.5 tracking-wide">{label}</label>
      <div className="relative">
        {type === "currency" && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-amber-400/60 text-sm">$</span>}
        <input
          type="number"
          value={displayVal}
          onChange={handleChange}
          min={min} max={max} step={step || (type === "percent" ? 0.1 : type === "number" ? 1 : 1000)}
          className="w-full bg-slate-800/80 border border-slate-600/50 rounded-lg px-3 py-2.5 text-white text-right focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400/50 transition-all"
          style={type === "currency" ? { paddingLeft: "1.5rem" } : type === "percent" ? { paddingRight: "2rem" } : {}}
        />
        {type === "percent" && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-amber-400/60 text-sm">%</span>}
      </div>
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-slate-300 mb-1.5 tracking-wide">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full bg-slate-800/80 border border-slate-600/50 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-amber-400/50 transition-all appearance-none">
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-xl p-5 text-center">
      <div className="text-xs uppercase tracking-widest text-slate-400 mb-2">{label}</div>
      <div className={`text-2xl font-bold ${accent ? "text-amber-400" : "text-white"}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

function SectionTitle({ icon, title, subtitle }) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-3xl">{icon}</span>
        <h2 className="text-2xl font-bold text-white" style={{ fontFamily: "'Playfair Display', serif" }}>{title}</h2>
      </div>
      {subtitle && <p className="text-slate-400 text-sm leading-relaxed max-w-2xl">{subtitle}</p>}
    </div>
  );
}

function Explanation({ children }) {
  return (
    <div className="bg-slate-800/40 border-l-2 border-amber-400/40 rounded-r-lg px-4 py-3 my-4">
      <p className="text-sm text-slate-300 leading-relaxed">{children}</p>
    </div>
  );
}

// ═══════════════════════════════════════════════
// PAGES
// ═══════════════════════════════════════════════

function Page1_Personal({ inputs, setField }) {
  return (
    <div>
      <SectionTitle icon="🍁" title="Let's Plan Your Retirement"
        subtitle="We'll start with some basics about you. These determine the time horizon for your savings to grow and how long your retirement income needs to last." />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
        <div>
          <Field label="Your Current Age" value={inputs.currentAge} onChange={v => setField("currentAge", v)} type="number" min={18} max={80} hint="How old are you today?" />
          <Field label="Desired Retirement Age" value={inputs.retirementAge} onChange={v => setField("retirementAge", v)} type="number" min={50} max={75} hint="When do you want to stop working?" />
          <Field label="Life Expectancy" value={inputs.lifeExpectancy} onChange={v => setField("lifeExpectancy", v)} type="number" min={70} max={105} hint="Plan conservatively — the average Canadian lives to 82" />
        </div>
        <div>
          <SelectField label="Province of Residence" value={inputs.province} onChange={v => setField("province", v)} options={Object.keys(PROVINCES)} />
          <Explanation>
            Your province determines your tax brackets, which directly affect how much of your retirement income you keep. Tax optimization is one of the most impactful levers in retirement planning.
          </Explanation>
          <div className="mt-6 bg-gradient-to-br from-slate-800/60 to-slate-900/60 border border-slate-700/30 rounded-xl p-5">
            <div className="text-xs uppercase tracking-widest text-amber-400/70 mb-3">Planning Horizon</div>
            <div className="flex justify-between items-end">
              <div><div className="text-3xl font-bold text-white">{inputs.retirementAge - inputs.currentAge}</div><div className="text-xs text-slate-400">years to save</div></div>
              <div className="text-slate-600 text-2xl">→</div>
              <div><div className="text-3xl font-bold text-amber-400">{inputs.lifeExpectancy - inputs.retirementAge}</div><div className="text-xs text-slate-400">years in retirement</div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Page2_Balances({ inputs, setField }) {
  const total = inputs.rrspBal + inputs.tfsaBal + inputs.nonRegBal + inputs.savingsBal;
  const totalContrib = inputs.rrspContrib + inputs.tfsaContrib + inputs.nonRegContrib + inputs.savingsContrib;
  return (
    <div>
      <SectionTitle icon="💰" title="Your Savings Today"
        subtitle="Enter your current account balances and how much you contribute each year. Each account type has different tax treatment, which we'll optimize for you." />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
        <div>
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-4">Current Balances</h3>
          <Field label="RRSP" value={inputs.rrspBal} onChange={v => setField("rrspBal", v)} hint="Tax-deferred growth, taxable on withdrawal" />
          <Field label="TFSA" value={inputs.tfsaBal} onChange={v => setField("tfsaBal", v)} hint="Tax-free growth and withdrawal" />
          <Field label="Non-Registered Investment" value={inputs.nonRegBal} onChange={v => setField("nonRegBal", v)} hint="Investment growth taxed as capital gains (50% inclusion)" />
          <Field label="Savings Account (Cash)" value={inputs.savingsBal} onChange={v => setField("savingsBal", v)} hint="No investment growth — just cash" />
          <div className="border-t border-slate-700/50 pt-3 mt-2 flex justify-between">
            <span className="text-sm text-slate-400">Total Savings</span>
            <span className="text-lg font-bold text-white">{fmt(total)}</span>
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-4">Annual Contributions</h3>
          <Field label="RRSP" value={inputs.rrspContrib} onChange={v => setField("rrspContrib", v)} />
          <Field label="TFSA" value={inputs.tfsaContrib} onChange={v => setField("tfsaContrib", v)} />
          <Field label="Non-Registered" value={inputs.nonRegContrib} onChange={v => setField("nonRegContrib", v)} />
          <Field label="Savings Account" value={inputs.savingsContrib} onChange={v => setField("savingsContrib", v)} />
          <div className="border-t border-slate-700/50 pt-3 mt-2 flex justify-between">
            <span className="text-sm text-slate-400">Total Contributions</span>
            <span className="text-lg font-bold text-white">{fmt(totalContrib)}/yr</span>
          </div>
        </div>
      </div>
      <Explanation>
        We use a tax-aware withdrawal strategy: cash savings first (no growth benefit), then RRSP to fill low tax brackets (capped at the OAS clawback threshold), then non-registered (50% capital gains inclusion), and TFSA last (preserving tax-free compounding). If your current marginal tax rate is lower than the projected rate at death, extra RRSP is drawn now to reduce the future tax burden on your estate.
      </Explanation>
    </div>
  );
}

function Page3_Income({ inputs, setField }) {
  return (
    <div>
      <SectionTitle icon="🏖️" title="Your Retirement Lifestyle"
        subtitle="How much annual income do you need in retirement? Most people spend more in early retirement (travel, hobbies) and less as they age." />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        {[
          { key: "activeIncome", label: "Active Phase", ages: `${inputs.retirementAge}–70`, icon: "✈️", desc: "Travel, dining out, new hobbies" },
          { key: "slowdownIncome", label: "Slowdown Phase", ages: "70–85", icon: "🏡", desc: "Quieter lifestyle, less travel" },
          { key: "inactiveIncome", label: "Inactive Phase", ages: "85+", icon: "🪑", desc: "Mostly home-based, possible care costs" },
        ].map(p => (
          <div key={p.key} className="bg-slate-800/50 border border-slate-700/40 rounded-xl p-5">
            <div className="text-2xl mb-2">{p.icon}</div>
            <div className="text-sm font-semibold text-white mb-1">{p.label} <span className="text-slate-500 font-normal">({p.ages})</span></div>
            <div className="text-xs text-slate-400 mb-3">{p.desc}</div>
            <Field label="Annual Income (Today's $)" value={inputs[p.key]} onChange={v => setField(p.key, v)} />
          </div>
        ))}
      </div>
      <Explanation>
        These amounts are in today's dollars — the model automatically adjusts for inflation each year. A common rule of thumb is 70% of pre-retirement income, declining about 20% per phase.
      </Explanation>
    </div>
  );
}

function Page4_Rates({ inputs, setField }) {
  const provData = PROVINCES[inputs.province] || PROVINCES.Ontario;
  return (
    <div>
      <SectionTitle icon="📊" title="Growth & Tax Assumptions"
        subtitle="These rates drive the compounding engine of your plan. Small differences in growth rate or inflation compound dramatically over 30+ years." />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
        <div>
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-4">Growth Rates</h3>
          <Field label="Pre-Retirement Growth Rate" value={inputs.preGrowth} onChange={v => setField("preGrowth", v)} type="percent" hint="Typically 5–8% for a balanced portfolio" />
          <Field label="Post-Retirement Growth Rate" value={inputs.postGrowth} onChange={v => setField("postGrowth", v)} type="percent" hint="Usually lower (3–5%) as you shift to conservative" />
          <Field label="Expected Inflation Rate" value={inputs.inflation} onChange={v => setField("inflation", v)} type="percent" hint="Bank of Canada targets 2%" />
          <div className="bg-slate-800/40 rounded-lg p-4 mt-2">
            <div className="flex justify-between text-sm"><span className="text-slate-400">Real return (pre-retirement)</span><span className="text-white font-medium">{pct(inputs.preGrowth - inputs.inflation)}</span></div>
            <div className="flex justify-between text-sm mt-1"><span className="text-slate-400">Real return (post-retirement)</span><span className="text-white font-medium">{pct(inputs.postGrowth - inputs.inflation)}</span></div>
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-4">Tax Brackets — {inputs.province}</h3>
          <div className="bg-slate-800/40 rounded-lg p-4 text-xs space-y-1.5">
            <div className="text-slate-500 uppercase tracking-wider mb-2 font-semibold">Federal (2026)</div>
            {inputs.fedBrackets.brackets.map(([t, r], i) => (
              <div key={i} className="flex justify-between"><span className="text-slate-400">{t === Infinity ? "Above" : `Up to ${fmt(t)}`}</span><span className="text-white">{(r * 100).toFixed(1)}%</span></div>
            ))}
            <div className="text-slate-500 uppercase tracking-wider mb-2 mt-4 font-semibold pt-3 border-t border-slate-700/40">Provincial — {inputs.province}</div>
            <div className="flex justify-between"><span className="text-slate-400">Personal amount</span><span className="text-amber-400">{fmt(provData.bpa)}</span></div>
            {provData.brackets.map(([t, r], i) => (
              <div key={i} className="flex justify-between"><span className="text-slate-400">{t === Infinity ? "Above" : `Up to ${fmt(t)}`}</span><span className="text-white">{(r * 100).toFixed(2)}%</span></div>
            ))}
          </div>
          <Explanation>
            Brackets are automatically inflation-adjusted in the projection. Both federal and provincial taxes are calculated progressively — you only pay the higher rate on income within that bracket, not on all your income.
          </Explanation>
        </div>
      </div>
    </div>
  );
}

function Page5_CPP({ inputs, setField, results }) {
  const showBridge = inputs.retirementAge < 65;
  return (
    <div>
      <SectionTitle icon="🏛️" title="CPP, OAS & Pension"
        subtitle="Government benefits and employer pensions form the foundation of your retirement income. We'll find the optimal age to start collecting CPP and OAS based on your life expectancy." />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 mb-6">
        <div>
          <Field label="CPP Annual Amount at Age 65 (Today's $)" value={inputs.cppAt65} onChange={v => setField("cppAt65", v)} hint="2025 max: $17,196. Check your My Service Canada Account for your estimate." />
          <Field label="OAS Annual Amount at Age 65 (Today's $)" value={inputs.oasAt65} onChange={v => setField("oasAt65", v)} hint="2026 max: ~$8,908 (age 65–74)" />
          <Field label="OAS Clawback Threshold (Today's $)" value={inputs.oasClawbackThreshold} onChange={v => setField("oasClawbackThreshold", v)} hint="2026: $95,323. Above this, 15¢ per dollar is clawed back." />
        </div>
        <div>
          <div className="bg-gradient-to-br from-amber-900/20 to-slate-800/60 border border-amber-400/20 rounded-xl p-5">
            <div className="text-xs uppercase tracking-widest text-amber-400/70 mb-4">Optimal Start Ages</div>
            <div className="grid grid-cols-2 gap-4">
              <div className="text-center">
                <div className="text-4xl font-bold text-amber-400">{results.optCpp.age}</div>
                <div className="text-xs text-slate-400 mt-1">CPP Start Age</div>
                <div className="text-sm text-white mt-1">{fmt(results.optCpp.annual)}/yr</div>
              </div>
              <div className="text-center">
                <div className="text-4xl font-bold text-amber-400">{results.optOas.age}</div>
                <div className="text-xs text-slate-400 mt-1">OAS Start Age</div>
                <div className="text-sm text-white mt-1">{fmt(results.optOas.annual)}/yr</div>
              </div>
            </div>
          </div>
          <Explanation>
            CPP decreases by 0.6%/month before 65 (max –36% at 60) and increases by 0.7%/month after 65 (max +42% at 70). OAS increases by 0.6%/month after 65 (max +36% at 70). With your life expectancy of {inputs.lifeExpectancy}, delaying to {results.optCpp.age} maximizes your total lifetime CPP benefits.
          </Explanation>
        </div>
      </div>
      <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-widest mb-3">CPP Amount by Start Age</h3>
      <div className="grid grid-cols-11 gap-1 text-center text-xs">
        {results.cppOptions.map(o => (
          <div key={o.age} className={`rounded-lg p-2 ${o.age === results.optCpp.age ? "bg-amber-400/20 border border-amber-400/40" : "bg-slate-800/40"}`}>
            <div className="text-slate-400">Age {o.age}</div>
            <div className={`font-bold ${o.age === results.optCpp.age ? "text-amber-400" : "text-white"}`}>{fmt(o.annual)}</div>
            <div className="text-slate-500">{fmtK(o.lifetime)}</div>
          </div>
        ))}
      </div>

      {/* Pension & Other Income */}
      <div className="mt-8">
        <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-4">Pension & Other Retirement Income</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
          <div>
            <Field label="Annual Pension Income (Today's $)" value={inputs.pensionIncome} onChange={v => setField("pensionIncome", v)} hint="Employer defined-benefit pension. Taxed as regular income. Not adjusted for inflation." />
            {showBridge && (
              <Field label="Pension Bridge Benefit (Today's $)" value={inputs.pensionBridge} onChange={v => setField("pensionBridge", v)} hint={`Extra annual amount paid from retirement until age 65 to cover the gap before CPP/OAS. Taxed as regular income. Not adjusted for inflation.`} />
            )}
          </div>
          <div>
            <Field label="Other Annual Retirement Income (Today's $)" value={inputs.otherIncome} onChange={v => setField("otherIncome", v)} hint="Rental income, part-time work, annuities, etc. Taxed as regular income. Adjusted for inflation." />
            <Explanation>
              Pension and other income are taxed the same as RRSP withdrawals (fully taxable as regular income). They also count toward the OAS clawback threshold.
              {showBridge && " The bridge benefit is only paid until age 65, when CPP and OAS typically begin."}
            </Explanation>
          </div>
        </div>
      </div>
    </div>
  );
}

function Page6_Results({ inputs, results, surplusMode, setSurplusMode }) {
  const status = results.fundingRatio >= 1 ? { icon: "✅", text: "Plan is On Track", color: "text-emerald-400" }
    : results.fundingRatio >= 0.7 ? { icon: "⚠️", text: "Needs Improvement", color: "text-amber-400" }
    : { icon: "❌", text: "Plan is Unrealistic", color: "text-red-400" };

  const retRows = results.rows.filter(r => r.age >= inputs.retirementAge);
  const totalTaxPaid = retRows.reduce((s, r) => s + r.totalTax, 0);
  const totalClawback = retRows.reduce((s, r) => s + r.oasClawback, 0);
  const lastRow = results.rows[results.rows.length - 1];

  return (
    <div>
      <SectionTitle icon="📋" title="Your Retirement Summary"
        subtitle="Here's the big picture — how your plan holds up across all the years ahead." />

      {/* Status banner */}
      <div className={`rounded-xl p-6 mb-8 text-center border ${results.fundingRatio >= 1 ? "bg-emerald-900/20 border-emerald-400/30" : results.fundingRatio >= 0.7 ? "bg-amber-900/20 border-amber-400/30" : "bg-red-900/20 border-red-400/30"}`}>
        <div className="text-4xl mb-2">{status.icon}</div>
        <div className={`text-2xl font-bold ${status.color}`}>{status.text}</div>
        <div className="text-slate-400 text-sm mt-1">Funding Ratio: <span className="text-white font-semibold">{Math.round(results.fundingRatio * 100)}%</span></div>
      </div>

      {/* Surplus mode toggle */}
      {results.hasSurplus && (
        <div className="bg-slate-800/60 border border-amber-400/30 rounded-xl p-5 mb-8">
          <div className="text-sm font-semibold text-amber-400 mb-1">
            Your plan has a surplus — choose how to use it:
          </div>
          <div className="text-xs text-slate-400 mb-4">Your savings outlast your retirement. You can spend more each year or leave a larger inheritance.</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { key: "max_estate", label: "Maximize Estate", icon: "🏠", desc: "Optimize withdrawals to leave the largest possible post-tax inheritance" },
              { key: "boost_spending", label: "Increase Spending", icon: "✈️", desc: "Proportionally increase retirement income so funds are fully used by end of life" },
            ].map(opt => (
              <button key={opt.key}
                onClick={() => setSurplusMode(opt.key)}
                className={`rounded-lg p-4 border text-left transition-all ${
                  surplusMode === opt.key
                    ? "bg-amber-400/15 border-amber-400/50 text-white"
                    : "bg-slate-800/40 border-slate-700/40 text-slate-400 hover:border-slate-600"
                }`}>
                <div className="text-lg mb-1">{opt.icon}</div>
                <div className="text-sm font-semibold">{opt.label}</div>
                <div className="text-xs mt-1 leading-relaxed">{opt.desc}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Boosted spending display */}
      {surplusMode === "boost_spending" && results.spendingMultiplier && (
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-3">Boosted Retirement Income (Today's $)</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard label={`Active Phase (${inputs.retirementAge}–70)`}
              value={fmt(Math.round(results.boostedActiveIncome))}
              sub={`was ${fmt(inputs.activeIncome)} (+${Math.round((results.spendingMultiplier - 1) * 100)}%)`} accent />
            <StatCard label="Slowdown Phase (70–85)"
              value={fmt(Math.round(results.boostedSlowdownIncome))}
              sub={`was ${fmt(inputs.slowdownIncome)} (+${Math.round((results.spendingMultiplier - 1) * 100)}%)`} accent />
            <StatCard label="Inactive Phase (85+)"
              value={fmt(Math.round(results.boostedInactiveIncome))}
              sub={`was ${fmt(inputs.inactiveIncome)} (+${Math.round((results.spendingMultiplier - 1) * 100)}%)`} accent />
          </div>
          <Explanation>
            By increasing your spending by {Math.round((results.spendingMultiplier - 1) * 100)}% across all phases, your portfolio is projected to be fully utilized by age {inputs.lifeExpectancy}. These amounts are in today's dollars and will be inflation-adjusted each year.
          </Explanation>
        </div>
      )}

      {/* Estate value display */}
      {surplusMode === "max_estate" && results.estateValue && (
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-3">Estimated Post-Tax Estate Value</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="TFSA (tax-free)" value={fmtK(results.estateValue.tfsa)} accent />
            <StatCard label="Cash Savings" value={fmtK(results.estateValue.savings)} />
            <StatCard label="Non-Reg (after tax)" value={fmtK(results.estateValue.nonReg)} />
            <StatCard label="RRSP (after tax)" value={fmtK(results.estateValue.rrsp)} />
            <StatCard label="Total Estate" value={fmtK(results.estateValue.total)} accent />
          </div>
          <Explanation>
            The estate strategy aggressively draws down your RRSP during retirement at lower tax brackets, preserving your TFSA (which passes tax-free to beneficiaries). At death, any remaining RRSP is fully taxable as income on the final tax return. Estate values shown are after estimated taxes. Actual values depend on factors like surviving spouse (RRSP rollover), province of death, and executor decisions.
          </Explanation>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        <StatCard label="Portfolio at Retirement" value={fmtK(results.portfolioAtRet)} accent />
        <StatCard label="Portfolio at End" value={fmtK(lastRow?.totalPortfolio)} sub={`Age ${inputs.lifeExpectancy}`} />
        <StatCard label="Tax During Retirement" value={fmtK(results.retirementTax)} sub="Income tax + clawback" />
        <StatCard label="Tax at Death (RRSP)" value={fmtK(results.terminalRrspTax)} sub={`On ${fmtK(lastRow?.rrsp)} remaining`} />
        <StatCard label="Total Lifetime Tax" value={fmtK(results.totalLifetimeTax)} sub="Retirement + terminal" accent />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-3">Tax-Optimized Withdrawal Strategy</h3>
          <div className="space-y-2 text-sm text-slate-300">
            <div className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">1.</span><span><strong className="text-white">Cash savings first</strong> — no growth benefit, so spend it early</span></div>
            <div className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">2.</span><span><strong className="text-white">RRSP smoothed over remaining years</strong> — spread evenly to stay in lower tax brackets, capped at OAS clawback threshold to avoid losing OAS</span></div>
            <div className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">3.</span><span><strong className="text-white">Non-registered next</strong> — only 50% of capital gains are taxable</span></div>
            <div className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">4.</span><span><strong className="text-white">TFSA fills the gap</strong> — blends with RRSP to meet spending needs while keeping taxes smooth</span></div>
          </div>
        </div>
        <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-3">Guaranteed Income</h3>
          <div className="space-y-2 text-sm text-slate-300">
            <div className="flex justify-between"><span>CPP starts at age</span><span className="text-white font-semibold">{results.optCpp.age}</span></div>
            <div className="flex justify-between"><span>CPP annual (today's $)</span><span className="text-white font-semibold">{fmt(results.optCpp.annual)}</span></div>
            <div className="flex justify-between"><span>OAS starts at age</span><span className="text-white font-semibold">{results.optOas.age}</span></div>
            <div className="flex justify-between"><span>OAS annual (today's $)</span><span className="text-white font-semibold">{fmt(results.optOas.annual)}</span></div>
            {inputs.pensionIncome > 0 && <div className="flex justify-between"><span>Pension (today's $)</span><span className="text-white font-semibold">{fmt(inputs.pensionIncome)}/yr</span></div>}
            {inputs.pensionBridge > 0 && inputs.retirementAge < 65 && <div className="flex justify-between"><span>Bridge until 65 (today's $)</span><span className="text-white font-semibold">{fmt(inputs.pensionBridge)}/yr</span></div>}
            {inputs.otherIncome > 0 && <div className="flex justify-between"><span>Other income (today's $)</span><span className="text-white font-semibold">{fmt(inputs.otherIncome)}/yr</span></div>}
            <div className="flex justify-between border-t border-slate-700/40 pt-2"><span>Combined at 65+ (today's $)</span><span className="text-amber-400 font-semibold">{fmt(results.optCpp.annual + results.optOas.annual + inputs.pensionIncome + inputs.otherIncome)}/yr</span></div>
          </div>
        </div>
      </div>
      <Explanation>
        The funding ratio shows how much of your desired retirement spending your savings can support. 100% means your portfolio exactly covers your lifestyle through life expectancy. Above 100% means you could spend more or leave an estate. Below 100% means you'll need to reduce spending or save more.
      </Explanation>
    </div>
  );
}

function Page7_Charts({ inputs, results, surplusMode, setSurplusMode }) {
  const retAge = inputs.retirementAge;
  const chartData = results.rows.map(r => ({
    age: r.age, portfolio: r.totalPortfolio, real: r.realPortfolio,
    rrsp: r.rrsp, tfsa: r.tfsa, nonReg: r.nonReg, savings: r.savings,
    cpp: r.cpp, oas: r.oasGross, pension: r.pension, bridge: r.bridge, other: r.other,
    savWd: r.savWd, nrWd: r.nrWd, rrspWd: r.rrspWd, tfsaWd: r.tfsaWd,
    tax: r.totalTax, clawback: r.oasClawback, net: r.netIncome, desired: r.desiredNominal,
  }));
  const retData = chartData.filter(d => d.age >= retAge);
  const ttStyle = { backgroundColor: "#1e293b", border: "1px solid #334155", borderRadius: "8px", fontSize: 12 };
  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={ttStyle} className="p-3 shadow-xl">
        <div className="text-amber-400 font-semibold mb-1">Age {label}</div>
        {payload.map((p, i) => (
          <div key={i} className="flex justify-between gap-4">
            <span style={{ color: p.color }}>{p.name}</span>
            <span className="text-white font-medium">{fmtK(p.value)}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div>
      <SectionTitle icon="📈" title="Detailed Projections"
        subtitle="Visual breakdowns of how your wealth grows, where your retirement income comes from, and how tax optimization protects your money." />

      {/* Sticky surplus mode toggle */}
      {results.hasSurplus && (
        <div className="sticky top-[52px] z-40 -mx-4 px-4 py-3 bg-slate-900/95 backdrop-blur border-b border-slate-800/60 mb-6">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-400">Viewing projections for:</span>
            <div className="flex gap-2">
              {[
                { key: "max_estate", label: "Maximize Estate", icon: "🏠" },
                { key: "boost_spending", label: "Increase Spending", icon: "✈️" },
              ].map(opt => (
                <button key={opt.key}
                  onClick={() => setSurplusMode(opt.key)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${
                    surplusMode === opt.key
                      ? "bg-amber-400/15 text-amber-400 border border-amber-400/40"
                      : "bg-slate-800/60 text-slate-400 border border-slate-700/40 hover:text-white hover:border-slate-600"
                  }`}>
                  <span>{opt.icon}</span>
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Chart 1: Portfolio */}
      <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-5 mb-8">
        <h3 className="text-sm font-semibold text-white mb-1">Portfolio Value Over Time</h3>
        <p className="text-xs text-slate-400 mb-4">Nominal value and inflation-adjusted (real) value in today's dollars</p>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="gPort" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#2563eb" stopOpacity={0.3}/><stop offset="95%" stopColor="#2563eb" stopOpacity={0}/></linearGradient>
              <linearGradient id="gReal" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#22c55e" stopOpacity={0.3}/><stop offset="95%" stopColor="#22c55e" stopOpacity={0}/></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="age" tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <YAxis tickFormatter={fmtK} tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="portfolio" name="Nominal" stroke="#2563eb" fill="url(#gPort)" />
            <Area type="monotone" dataKey="real" name="Real (Today's $)" stroke="#22c55e" fill="url(#gReal)" />
          </AreaChart>
        </ResponsiveContainer>
        <Explanation>The gap between nominal and real value shows the erosive effect of inflation. Even at 2%, your purchasing power is roughly halved over 35 years.</Explanation>
      </div>

      {/* Chart 2: Account Breakdown */}
      <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-5 mb-8">
        <h3 className="text-sm font-semibold text-white mb-1">Account Breakdown</h3>
        <p className="text-xs text-slate-400 mb-4">How your wealth is distributed across account types over time</p>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="age" tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <YAxis tickFormatter={fmtK} tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="rrsp" name="RRSP" stackId="1" stroke="#1e3a5f" fill="#1e3a5f" />
            <Area type="monotone" dataKey="tfsa" name="TFSA" stackId="1" stroke="#2563eb" fill="#2563eb" />
            <Area type="monotone" dataKey="nonReg" name="Non-Reg" stackId="1" stroke="#22c55e" fill="#22c55e" />
            <Area type="monotone" dataKey="savings" name="Savings" stackId="1" stroke="#eab308" fill="#eab308" />
          </AreaChart>
        </ResponsiveContainer>
        <Explanation>Notice how cash savings and non-registered funds are depleted first in retirement, while TFSA is preserved longest — maximizing tax-free compounding.</Explanation>
      </div>

      {/* Chart 3: Income Sources */}
      <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-5 mb-8">
        <h3 className="text-sm font-semibold text-white mb-1">Retirement Income Sources</h3>
        <p className="text-xs text-slate-400 mb-4">Where your retirement income comes from each year</p>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={retData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="age" tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <YAxis tickFormatter={fmtK} tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="cpp" name="CPP" stackId="1" fill="#1e3a5f" />
            <Bar dataKey="oas" name="OAS" stackId="1" fill="#2563eb" />
            <Bar dataKey="pension" name="Pension" stackId="1" fill="#0891b2" />
            <Bar dataKey="bridge" name="Bridge" stackId="1" fill="#06b6d4" />
            <Bar dataKey="other" name="Other" stackId="1" fill="#8b5cf6" />
            <Bar dataKey="savWd" name="Savings" stackId="1" fill="#eab308" />
            <Bar dataKey="nrWd" name="Non-Reg" stackId="1" fill="#22c55e" />
            <Bar dataKey="rrspWd" name="RRSP" stackId="1" fill="#dc2626" />
            <Bar dataKey="tfsaWd" name="TFSA" stackId="1" fill="#a855f7" />
          </BarChart>
        </ResponsiveContainer>
        <Explanation>CPP, OAS, pension, and other guaranteed income form the foundation. The bridge benefit covers the gap before age 65. Portfolio withdrawals fill the remainder, with the tax-optimized strategy keeping RRSP withdrawals moderate to avoid OAS clawback.</Explanation>
      </div>

      {/* Chart 4: Tax Impact */}
      <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-5 mb-8">
        <h3 className="text-sm font-semibold text-white mb-1">Tax & OAS Clawback</h3>
        <p className="text-xs text-slate-400 mb-4">Annual combined federal + provincial taxes and any OAS recovery tax</p>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={retData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="age" tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <YAxis tickFormatter={fmtK} tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="tax" name="Fed + Prov Tax" stackId="1" fill="#dc2626" />
            <Bar dataKey="clawback" name="OAS Clawback" stackId="1" fill="#f97316" />
          </BarChart>
        </ResponsiveContainer>
        <Explanation>The withdrawal strategy keeps your taxable income below the OAS clawback threshold ({fmt(inputs.oasClawbackThreshold)} in today's dollars), preserving your full OAS benefit. Without optimization, high-income retirees can lose thousands per year to clawback.</Explanation>
      </div>

      {/* Year by Year Table */}
      <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-white mb-4">Year-by-Year Projection</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 border-b border-slate-700/50">
                {["Age","Phase","Portfolio","CPP","OAS",
                  ...(inputs.pensionIncome > 0 ? ["Pension"] : []),
                  ...(inputs.pensionBridge > 0 && inputs.retirementAge < 65 ? ["Bridge"] : []),
                  ...(inputs.otherIncome > 0 ? ["Other"] : []),
                  "Sav Wd","NR Wd","RRSP Wd","TFSA Wd","Taxable","Tax","Clawback","Net Income"].map(h => (
                  <th key={h} className="px-2 py-2 text-right font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.rows.filter(r => r.age >= retAge).map(r => (
                <tr key={r.age} className="border-b border-slate-800/50 hover:bg-slate-700/20">
                  <td className="px-2 py-1.5 text-white font-medium">{r.age}</td>
                  <td className="px-2 py-1.5 text-slate-400">{r.phase}</td>
                  {[r.totalPortfolio,r.cpp,r.oasGross,
                    ...(inputs.pensionIncome > 0 ? [r.pension] : []),
                    ...(inputs.pensionBridge > 0 && inputs.retirementAge < 65 ? [r.bridge] : []),
                    ...(inputs.otherIncome > 0 ? [r.other] : []),
                    r.savWd,r.nrWd,r.rrspWd,r.tfsaWd,r.taxableIncome,r.totalTax,r.oasClawback,r.netIncome].map((v,i) => (
                    <td key={i} className="px-2 py-1.5 text-right text-slate-300">{fmtK(v)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════
const DEFAULTS = {
  currentAge: 35, retirementAge: 65, lifeExpectancy: 90, province: "Ontario",
  rrspBal: 50000, tfsaBal: 40000, nonRegBal: 20000, savingsBal: 15000,
  rrspContrib: 10000, tfsaContrib: 7000, nonRegContrib: 5000, savingsContrib: 3000,
  activeIncome: 70000, slowdownIncome: 55000, inactiveIncome: 40000,
  pensionIncome: 0, pensionBridge: 0, otherIncome: 0,
  preGrowth: 0.06, postGrowth: 0.04, inflation: 0.02,
  cppAt65: 17196, oasAt65: 8908, oasClawbackThreshold: 95323,
  fedBrackets: FED_BRACKETS_DEFAULT,
};

const PAGES = [
  { title: "Personal", icon: "🍁" },
  { title: "Savings", icon: "💰" },
  { title: "Income", icon: "🏖️" },
  { title: "Rates", icon: "📊" },
  { title: "CPP & OAS", icon: "🏛️" },
  { title: "Results", icon: "📋" },
  { title: "Charts", icon: "📈" },
];

const STORAGE_KEY = "retirement-planner-inputs";
const SURPLUS_STORAGE_KEY = "retirement-planner-surplus-mode";
const PAGE_STORAGE_KEY = "retirement-planner-page";

function loadSavedInputs() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Merge with defaults so new fields are always present
      return { ...DEFAULTS, ...parsed, fedBrackets: DEFAULTS.fedBrackets };
    }
  } catch (e) { /* ignore corrupt data */ }
  return DEFAULTS;
}

function loadSurplusMode() {
  try {
    const saved = localStorage.getItem(SURPLUS_STORAGE_KEY);
    if (saved === "boost_spending" || saved === "max_estate") return saved;
  } catch (e) { /* ignore */ }
  return "max_estate";
}

export default function App() {
  const [page, setPage] = useState(() => {
    try {
      const saved = parseInt(localStorage.getItem(PAGE_STORAGE_KEY));
      if (saved >= 0 && saved < PAGES.length) return saved;
    } catch (e) { /* ignore */ }
    return 0;
  });
  const [inputs, setInputs] = useState(loadSavedInputs);
  const [surplusMode, setSurplusMode] = useState(loadSurplusMode);

  // Persist inputs to localStorage
  useEffect(() => {
    try {
      const { fedBrackets, ...rest } = inputs;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
    } catch (e) { /* storage full or unavailable */ }
  }, [inputs]);

  // Persist surplus mode
  useEffect(() => {
    try {
      localStorage.setItem(SURPLUS_STORAGE_KEY, surplusMode);
    } catch (e) { /* ignore */ }
  }, [surplusMode]);

  // Persist current page
  useEffect(() => {
    try {
      localStorage.setItem(PAGE_STORAGE_KEY, page);
    } catch (e) { /* ignore */ }
  }, [page]);

  const setField = useCallback((key, value) => {
    setInputs(prev => ({ ...prev, [key]: value }));
  }, []);

  const results = useMemo(() => {
    const fundingRatio = findFundingRatio(inputs);
    const base = runProjection(inputs);

    if (!base.hasSurplus) {
      return { ...base, surplusMode: null, fundingRatio };
    }
    if (surplusMode === "boost_spending") {
      return { ...runBoostSpending(inputs), fundingRatio };
    }
    // Default: maximize estate
    return { ...runMaxEstate(inputs), fundingRatio };
  }, [inputs, surplusMode]);

  const pages = [
    <Page1_Personal inputs={inputs} setField={setField} />,
    <Page2_Balances inputs={inputs} setField={setField} />,
    <Page3_Income inputs={inputs} setField={setField} />,
    <Page4_Rates inputs={inputs} setField={setField} />,
    <Page5_CPP inputs={inputs} setField={setField} results={results} />,
    <Page6_Results inputs={inputs} results={results} surplusMode={surplusMode} setSurplusMode={setSurplusMode} />,
    <Page7_Charts inputs={inputs} results={results} surplusMode={surplusMode} setSurplusMode={setSurplusMode} />,
  ];

  return (
    <div className="min-h-screen bg-slate-900 text-white" style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />

      {/* Progress bar */}
      <div className="sticky top-0 z-50 bg-slate-900/90 backdrop-blur border-b border-slate-800/80">
        <div className="max-w-5xl mx-auto px-4 py-3">
          <div className="flex items-center gap-1">
            {PAGES.map((p, i) => (
              <button key={i} onClick={() => setPage(i)}
                className={`flex-1 flex items-center justify-center gap-1 py-2 rounded-lg text-xs font-medium transition-all ${i === page ? "bg-amber-400/15 text-amber-400 border border-amber-400/30" : i < page ? "text-slate-400 hover:text-white" : "text-slate-600"}`}>
                <span className="hidden sm:inline">{p.icon}</span>
                <span className="hidden md:inline">{p.title}</span>
                <span className="md:hidden">{p.icon}</span>
              </button>
            ))}
          </div>
          <div className="mt-2 h-0.5 bg-slate-800 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-amber-400 to-amber-500 rounded-full transition-all duration-500" style={{ width: `${((page + 1) / PAGES.length) * 100}%` }} />
          </div>
        </div>
      </div>

      {/* Page content */}
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div key={page} className="animate-fadeIn">{pages[page]}</div>

        {/* Navigation */}
        <div className="flex justify-between mt-10 pt-6 border-t border-slate-800/60">
          <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}
            className={`px-6 py-2.5 rounded-lg font-medium text-sm transition-all ${page === 0 ? "text-slate-600 cursor-not-allowed" : "text-slate-300 hover:text-white hover:bg-slate-800"}`}>
            ← Back
          </button>
          <button onClick={() => setPage(Math.min(PAGES.length - 1, page + 1))} disabled={page === PAGES.length - 1}
            className={`px-6 py-2.5 rounded-lg font-medium text-sm transition-all ${page === PAGES.length - 1 ? "text-slate-600 cursor-not-allowed" : "bg-amber-400 text-slate-900 hover:bg-amber-300"}`}>
            {page === PAGES.length - 2 ? "See Results →" : "Next →"}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fadeIn { animation: fadeIn 0.4s ease-out; }
        input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
        select { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2394a3b8' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; }
      `}</style>
    </div>
  );
}
