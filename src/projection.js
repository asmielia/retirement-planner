import { PROVINCES, calcProgressiveTax, getCombinedMarginalRate, estimateTerminalTaxRate } from "./tax.js";

// ═══════════════════════════════════════════════
// INCOME SMOOTHING
// ═══════════════════════════════════════════════
export function getSmoothedIncome(age, activeIncome, slowdownIncome, inactiveIncome) {
  if (age < 65) return activeIncome;
  if (age < 70) {
    const t = (age - 65) / 5;
    return activeIncome + (slowdownIncome - activeIncome) * t;
  }
  if (age < 80) return slowdownIncome;
  if (age < 85) {
    const t = (age - 80) / 5;
    return slowdownIncome + (inactiveIncome - slowdownIncome) * t;
  }
  return inactiveIncome;
}

export function getPhaseLabel(age, isRetired) {
  if (!isRetired) return "Accumulation";
  if (age < 65) return "Active";
  if (age < 70) return "Active \u2192 Slow";
  if (age < 80) return "Slowdown";
  if (age < 85) return "Slow \u2192 Inactive";
  return "Inactive";
}

// ═══════════════════════════════════════════════
// CORE PROJECTION ENGINE
// ═══════════════════════════════════════════════
export function runProjection(inputs, strategy = "optimize") {
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
    const phase = getPhaseLabel(age, isRetired);
    const growthRate = isRetired ? postGrowth : preGrowth;

    // Government benefits
    const cpp = age >= optCpp.age ? optCpp.annual * infFactor : 0;
    const oasGross = age >= optOas.age ? optOas.annual * infFactor : 0;

    // Pension and bridge are fixed nominal amounts (most DB pensions are not indexed to inflation)
    // Other income (rental, part-time, etc.) is inflation-adjusted
    const pension = isRetired ? pensionIncome : 0;
    const bridge = (isRetired && age < 65) ? pensionBridge : 0;
    const other = isRetired ? otherIncome * infFactor : 0;

    // Desired income (nominal) — smoothed transitions between phases
    let desiredBase = 0;
    if (isRetired) {
      desiredBase = getSmoothedIncome(age, activeIncome, slowdownIncome, inactiveIncome);
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
      const cashFloor = strategy === "spend_down" ? 0 : (desiredNominal / 12) * 2;
      const savAvailAfterFloor = Math.max(0, savAvail - cashFloor);
      savWd = Math.min(savAvailAfterFloor, portfolioNeed);
      let rem = portfolioNeed - savWd;

      // Step 2: RRSP — fill low tax brackets up to OAS clawback threshold
      const lockedIncome = cpp + oasGross + pension + bridge + other;
      const rrspRoom = Math.max(0, oasThreshNom - lockedIncome);
      rrspWd = Math.min(rrspAvail, rem, rrspRoom);
      rem -= rrspWd;

      // Step 3: Non-registered (50% capital gains inclusion — moderate tax cost)
      nrWd = Math.min(nonRegAvail, rem);
      rem -= nrWd;

      // Step 4: TFSA last (preserve tax-free compounding)
      tfsaWd = Math.min(tfsaAvail, rem);
      rem -= tfsaWd;

      // Step 5: If still short, dip into the cash floor as a last resort
      if (rem > 0) {
        const extraSav = Math.min(savAvail - savWd, rem);
        savWd += extraSav;
        rem -= extraSav;
      }

      // ── RRSP top-up: draw extra RRSP if current marginal rate < terminal rate ──
      if (strategy === "optimize" || strategy === "max_estate") {
        const yearsToEnd = lifeExpectancy - age;
        const currentRrspIncome = lockedIncome + rrspWd;
        const currentMarginal = getCombinedMarginalRate(currentRrspIncome, fedBpa, fedBrk, provBpa, provBrk);
        const rrspAfterWd = rrspAvail - rrspWd;
        const terminalRate = estimateTerminalTaxRate(rrspAfterWd, provData, fedBrackets, infFactor);

        let extraRrsp = 0;
        if (strategy === "max_estate" && yearsToEnd > 0) {
          const annualTarget = rrspAfterWd / yearsToEnd;
          extraRrsp = Math.min(rrspAfterWd, Math.max(0, annualTarget - rrspWd));
          const maxRrspForOas = Math.max(0, oasThreshNom - lockedIncome);
          extraRrsp = Math.max(0, Math.min(extraRrsp, maxRrspForOas - rrspWd));
        } else if (currentMarginal < terminalRate && rrspAfterWd > 0) {
          let testIncome = currentRrspIncome;
          for (const [threshold] of fedBrk) {
            const bracketEdge = threshold;
            if (bracketEdge > testIncome) {
              const rateAtEdge = getCombinedMarginalRate(bracketEdge, fedBpa, fedBrk, provBpa, provBrk);
              if (rateAtEdge >= terminalRate) {
                extraRrsp = Math.max(0, bracketEdge - currentRrspIncome);
                break;
              }
              testIncome = bracketEdge;
            }
          }
          extraRrsp = Math.min(extraRrsp, rrspAfterWd);
          const maxRrspForOas = Math.max(0, oasThreshNom - lockedIncome);
          extraRrsp = Math.max(0, Math.min(extraRrsp, maxRrspForOas - rrspWd));
        }

        if (extraRrsp > 0) {
          rrspWd += extraRrsp;
        }
      }
    }

    // Update balances
    if (isRetired) {
      const extraCash = Math.max(0, (savWd + nrWd + rrspWd + tfsaWd) - portfolioNeed);
      rrsp = Math.max(0, rrspAvail - rrspWd);
      tfsa = Math.max(0, tfsaAvail - tfsaWd);
      nonReg = Math.max(0, nonRegAvail - nrWd);
      savings = Math.max(0, savAvail - savWd + extraCash);
    } else {
      rrsp = rrsp * (1 + preGrowth) + rrspContrib;
      tfsa = tfsa * (1 + preGrowth) + tfsaContrib;
      nonReg = nonReg * (1 + preGrowth) + nonRegContrib;
      savings = savings + savingsContrib;
    }

    const totalPortfolio = rrsp + tfsa + nonReg + savings;

    // Taxable income
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
    const nrTaxRate = termRate * 0.5;
    estateValue = {
      tfsa: lastRow.tfsa,
      savings: lastRow.savings,
      nonReg: lastRow.nonReg * (1 - nrTaxRate * 0.3),
      rrsp: lastRow.rrsp * (1 - termRate),
      total: 0,
    };
    estateValue.total = estateValue.tfsa + estateValue.savings + estateValue.nonReg + estateValue.rrsp;
  }

  return {
    rows, cppOptions, oasOptions, optCpp, optOas,
    portfolioAtRet, hasSurplus, estateValue,
    activeYears: Math.max(0, Math.min(70, lifeExpectancy) - retirementAge),
    slowdownYears: Math.max(0, Math.min(85, lifeExpectancy) - Math.max(70, retirementAge)),
    inactiveYears: Math.max(0, lifeExpectancy - Math.max(85, retirementAge)),
  };
}
