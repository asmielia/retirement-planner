import { PROVINCES, calcProgressiveTax, getCombinedMarginalRate, estimateTerminalTaxRate, calcPensionIncomeCredit, calcAgeCredit } from "./tax.js";
import { getRrifMinimum } from "./constants.js";

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

  // originalRetirementAge gates pension/bridge (DB pension starts at originally planned age)
  // retirementAge gates when portfolio withdrawals and desired spending begin
  const originalRetirementAge = inputs.originalRetirementAge || retirementAge;

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
  // OAS automatically increases 10% at age 75 (since July 2022)
  const oasOptions = [];
  for (let age = 65; age <= 70; age++) {
    let adj = age === 65 ? oasAt65 : oasAt65 * (1 + 0.006 * (age - 65) * 12);
    const yearsBelow75 = Math.max(0, Math.min(75, lifeExpectancy) - age);
    const yearsAbove75 = Math.max(0, lifeExpectancy - Math.max(75, age));
    const lifetime = adj * yearsBelow75 + adj * 1.10 * yearsAbove75;
    oasOptions.push({ age, annual: adj, lifetime });
  }
  const optOas = oasOptions.reduce((a, b) => b.lifetime > a.lifetime ? b : a);

  // Year-by-year projection
  const rows = [];
  let rrsp = rrspBal, tfsa = tfsaBal, nonReg = nonRegBal, savings = savingsBal;
  let tfsaRoom = 0; // TFSA contribution room starts at 0 today
  let nonRegCostBasis = nonRegBal; // track cost basis for capital gains calculation

  for (let year = 1; year <= (lifeExpectancy - currentAge + 1); year++) {
    const age = currentAge + year - 1;
    if (age > lifeExpectancy) break;
    const infFactor = Math.pow(1 + inflation, year);
    const isRetired = age >= retirementAge;
    const phase = getPhaseLabel(age, isRetired);
    const growthRate = isRetired ? postGrowth : preGrowth;

    // Government benefits (OAS gets 10% increase at age 75)
    const cpp = age >= optCpp.age ? optCpp.annual * infFactor : 0;
    const oasBase = age >= 75 ? optOas.annual * 1.10 : optOas.annual;
    const oasGross = age >= optOas.age ? oasBase * infFactor : 0;

    // Pension starts at the originally planned retirement age (DB pension benefit).
    // Bridge benefit covers the gap from originally planned retirement to age 65.
    // Other income (rental, part-time, etc.) is inflation-adjusted and starts at retirement.
    const pension = age >= originalRetirementAge ? pensionIncome : 0;
    const bridge = (age >= originalRetirementAge && age < 65) ? pensionBridge : 0;
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

      const lockedIncome = cpp + oasGross + pension + bridge + other;
      const receivingOas = oasGross > 0;

      if (receivingOas) {
        // ── OAS-aware order: RRSP (capped) → Non-reg → TFSA ──
        // Cap RRSP at OAS clawback threshold to minimize clawback
        const rrspRoom = Math.max(0, oasThreshNom - lockedIncome);
        rrspWd = Math.min(rrspAvail, rem, rrspRoom);
        rem -= rrspWd;

        // Step 3: Non-registered (50% capital gains inclusion)
        nrWd = Math.min(nonRegAvail, rem);
        rem -= nrWd;

        // Step 4: TFSA last (preserve tax-free compounding)
        tfsaWd = Math.min(tfsaAvail, rem);
        rem -= tfsaWd;
      } else {
        // ── Pre-OAS order: RRSP (uncapped) → Non-reg → TFSA ──
        // No OAS clawback risk, so draw down RRSP freely and preserve TFSA
        rrspWd = Math.min(rrspAvail, rem);
        rem -= rrspWd;

        // Non-registered next
        nrWd = Math.min(nonRegAvail, rem);
        rem -= nrWd;

        // TFSA only if still short
        tfsaWd = Math.min(tfsaAvail, rem);
        rem -= tfsaWd;
      }

      // Step 5: If still short, dip into the cash floor as a last resort
      if (rem > 0) {
        const extraSav = Math.min(savAvail - savWd, rem);
        savWd += extraSav;
        rem -= extraSav;
      }

      // Step 6: If still short (OAS mode cap), pull more RRSP beyond OAS cap.
      // Meeting spending needs is more important than avoiding OAS clawback.
      if (rem > 0) {
        const extraRrsp = Math.min(rrspAvail - rrspWd, rem);
        rrspWd += extraRrsp;
        rem -= extraRrsp;
      }

      // ── RRIF minimum: mandatory withdrawal floor at age 72+ ──
      const rrifMin = getRrifMinimum(age, rrspAvail);
      if (rrifMin > rrspWd) {
        rrspWd = Math.min(rrifMin, rrspAvail);
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
          // Only cap at OAS threshold when receiving OAS — pre-OAS years are the
          // golden window for aggressive RRSP meltdown with no clawback risk
          if (receivingOas) {
            const maxRrspForOas = Math.max(0, oasThreshNom - lockedIncome);
            extraRrsp = Math.max(0, Math.min(extraRrsp, maxRrspForOas - rrspWd));
          }
        }

        // At age 65+, ensure at least $2,000 RRSP withdrawn to capture pension income credit
        if (age >= 65 && rrspWd + extraRrsp < 2000 && rrspAfterWd > 0) {
          const minForCredit = Math.min(2000 - rrspWd, rrspAfterWd);
          extraRrsp = Math.max(extraRrsp, minForCredit);
        }

        if (extraRrsp > 0) {
          rrspWd += extraRrsp;
        }
      }
    }

    // Non-reg capital gains: compute gain fraction BEFORE updating cost basis
    // Only the gain portion of the withdrawal is taxable at 50% inclusion
    const nrGainFraction = nonRegAvail > 0 ? Math.max(0, 1 - nonRegCostBasis / nonRegAvail) : 0;
    const nrTaxableGain = nrWd * nrGainFraction * 0.5;

    // The RRSP top-up excess is an internal rebalance, not spendable income.
    const rrspToTfsaTransfer = isRetired ? Math.max(0, (savWd + nrWd + rrspWd + tfsaWd) - portfolioNeed) : 0;

    // Update balances
    // TFSA contribution room: $7K/year accrues, withdrawals restore room
    tfsaRoom += 7000;
    if (isRetired) {
      tfsaRoom += tfsaWd; // withdrawals restore contribution room

      // RRSP top-up excess goes to TFSA up to available contribution room.
      // Any overflow goes to non-registered.
      const extraFromTopUp = rrspToTfsaTransfer;
      const toTfsa = Math.min(extraFromTopUp, tfsaRoom);
      const toNonReg = extraFromTopUp - toTfsa;
      tfsaRoom -= toTfsa;

      rrsp = Math.max(0, rrspAvail - rrspWd);
      tfsa = Math.max(0, tfsaAvail - tfsaWd) + toTfsa;
      nonReg = Math.max(0, nonRegAvail - nrWd) + toNonReg;
      savings = Math.max(0, savAvail - savWd);
      // Update cost basis: reduce proportionally on withdrawal, increase by top-up overflow
      if (nonRegAvail > 0 && nrWd > 0) {
        nonRegCostBasis = nonRegCostBasis * (1 - nrWd / nonRegAvail) + toNonReg;
      } else {
        nonRegCostBasis += toNonReg;
      }
    } else {
      tfsaRoom -= tfsaContrib; // pre-retirement contributions use room
      rrsp = rrsp * (1 + preGrowth) + rrspContrib;
      tfsa = tfsa * (1 + preGrowth) + tfsaContrib;
      nonReg = nonReg * (1 + preGrowth) + nonRegContrib;
      nonRegCostBasis += nonRegContrib; // new contributions are at cost
      savings = savings + savingsContrib;
    }

    const totalPortfolio = rrsp + tfsa + nonReg + savings;

    // Taxable income includes full RRSP withdrawal (including top-up rebalance),
    // because the top-up IS real taxable income that the user pays tax on.
    const taxableIncome = isRetired ? rrspWd + cpp + oasGross + pension + bridge + other + nrTaxableGain : 0;

    // Tax calculation (with pension income credit and age amount credit at 65+)
    const fedTax = isRetired ? calcProgressiveTax(taxableIncome, fedBpa, fedBrk) : 0;
    const provTax = isRetired ? calcProgressiveTax(taxableIncome, provBpa, provBrk) : 0;
    const fedLowestRate = fedBrk[0][1];
    const provLowestRate = provBrk[0][1];
    const pensionCredit = isRetired ? calcPensionIncomeCredit(age, rrspWd, pension, fedLowestRate, provLowestRate) : 0;
    const ageCredit = isRetired ? calcAgeCredit(age, taxableIncome, fedLowestRate, provLowestRate, infFactor) : 0;
    const totalTax = Math.max(0, fedTax + provTax - pensionCredit - ageCredit);

    // OAS clawback
    const oasClawback = isRetired ? Math.min(oasGross, Math.max(0, (taxableIncome - oasThreshNom) * 0.15)) : 0;

    // Net income — total income minus tax, minus OAS clawback, minus the RRSP top-up
    // transfer (which went to TFSA/non-reg and is not spendable cash)
    const netIncome = isRetired ? savWd + nrWd + rrspWd + tfsaWd + cpp + oasGross + pension + bridge + other - totalTax - oasClawback - rrspToTfsaTransfer : 0;

    rows.push({
      year, age, phase, rrsp, tfsa, nonReg, savings,
      cpp, oasGross, pension, bridge, other, totalPortfolio,
      contribution: isRetired ? 0 : rrspContrib + tfsaContrib + nonRegContrib + savingsContrib,
      desiredNominal, savWd, nrWd, rrspWd, tfsaWd, rrspToTfsaTransfer,
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
