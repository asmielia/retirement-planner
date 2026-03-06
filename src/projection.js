import { PROVINCES, calcProgressiveTax, calcTotalTaxAndClawback, getCombinedMarginalRate, estimateTerminalTaxRate, calcPensionIncomeCredit, calcAgeCredit } from "./tax.js";
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
// WITHDRAWAL + TAX COMPUTATION (pure, no mutation)
// ═══════════════════════════════════════════════
function computeWithdrawalsAndTax(grossTarget, {
  strategy, cpp, oasGross, pension, bridge, other,
  rrspAvail, tfsaAvail, nonRegAvail, savAvail,
  oasThreshNom, fedBpa, fedBrk, provBpa, provBrk,
  nrGainFraction,
}) {
  const lockedIncome = cpp + oasGross + pension + bridge + other;
  const portfolioNeed = Math.max(0, grossTarget - lockedIncome);

  // Step 1: Cash savings first (no growth, no tax cost)
  const cashFloor = strategy === "spend_down" ? 0 : (grossTarget / 12) * 2;
  const savAvailAfterFloor = Math.max(0, savAvail - cashFloor);
  let savWd = Math.min(savAvailAfterFloor, portfolioNeed);
  let rem = portfolioNeed - savWd;

  const receivingOas = oasGross > 0;
  let rrspWd, nrWd, tfsaWd;

  if (receivingOas) {
    // OAS-aware order: RRSP (capped) → Non-reg → TFSA
    const rrspRoom = Math.max(0, oasThreshNom - lockedIncome);
    rrspWd = Math.min(rrspAvail, rem, rrspRoom);
    rem -= rrspWd;

    nrWd = Math.min(nonRegAvail, rem);
    rem -= nrWd;

    tfsaWd = Math.min(tfsaAvail, rem);
    rem -= tfsaWd;
  } else {
    // Pre-OAS order: RRSP (uncapped) → Non-reg → TFSA
    rrspWd = Math.min(rrspAvail, rem);
    rem -= rrspWd;

    nrWd = Math.min(nonRegAvail, rem);
    rem -= nrWd;

    tfsaWd = Math.min(tfsaAvail, rem);
    rem -= tfsaWd;
  }

  // Dip into cash floor as last resort
  if (rem > 0) {
    const extraSav = Math.min(savAvail - savWd, rem);
    savWd += extraSav;
    rem -= extraSav;
  }

  // If still short (OAS mode cap), pull more RRSP beyond OAS cap
  if (rem > 0) {
    const extraRrsp = Math.min(rrspAvail - rrspWd, rem);
    rrspWd += extraRrsp;
    rem -= extraRrsp;
  }

  // Compute tax and clawback
  const nrTaxableGain = nrWd * nrGainFraction * 0.5;
  const { taxableIncome, totalTax, oasClawback } = calcTotalTaxAndClawback(
    rrspWd, cpp, oasGross, pension, bridge, other, nrTaxableGain,
    fedBpa, fedBrk, provBpa, provBrk, oasThreshNom
  );

  // Net income = all cash in minus tax minus clawback (no RRSP top-up transfer here)
  const netIncome = savWd + nrWd + rrspWd + tfsaWd + lockedIncome - totalTax - oasClawback;

  return { savWd, nrWd, rrspWd, tfsaWd, nrTaxableGain, taxableIncome, totalTax, oasClawback, netIncome, portfolioNeed };
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
    // This is now the NET target (after tax + OAS clawback)
    let desiredBase = 0;
    if (isRetired) {
      desiredBase = getSmoothedIncome(age, activeIncome, slowdownIncome, inactiveIncome);
    }
    const desiredNominal = desiredBase * infFactor;

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

    // Non-reg capital gains: compute gain fraction BEFORE withdrawals
    const nrGainFraction = nonRegAvail > 0 ? Math.max(0, 1 - nonRegCostBasis / nonRegAvail) : 0;

    let savWd = 0, nrWd = 0, rrspWd = 0, tfsaWd = 0;
    let nrTaxableGain = 0, taxableIncome = 0, totalTax = 0, oasClawback = 0, netIncome = 0;
    let grossNominal = 0;

    if (isRetired) {
      // ── Iterative net-income targeting ──
      // The user's desired income is a NET target (after tax + clawback).
      // We iterate to find the gross amount that delivers this net.
      const yearState = {
        strategy, cpp, oasGross, pension, bridge, other,
        rrspAvail, tfsaAvail, nonRegAvail, savAvail,
        oasThreshNom, fedBpa, fedBrk, provBpa, provBrk,
        nrGainFraction,
      };

      const lockedIncome = cpp + oasGross + pension + bridge + other;
      let grossEstimate = desiredNominal;
      let result;

      for (let iter = 0; iter < 10; iter++) {
        result = computeWithdrawalsAndTax(grossEstimate, yearState);

        // Compute RRSP top-up inside the iteration so its tax impact is accounted for
        let topUpRrsp = 0;
        if (strategy === "optimize" || strategy === "max_estate") {
          const currentRrspIncome = lockedIncome + result.rrspWd;
          const rrspAfterWd = rrspAvail - result.rrspWd;
          const terminalRate = estimateTerminalTaxRate(rrspAfterWd, provData, fedBrackets, infFactor);

          if (strategy === "max_estate" && (lifeExpectancy - age) > 0) {
            const annualTarget = rrspAfterWd / (lifeExpectancy - age);
            topUpRrsp = Math.min(rrspAfterWd, Math.max(0, annualTarget - result.rrspWd));
            const maxRrspForOas = Math.max(0, oasThreshNom - lockedIncome);
            topUpRrsp = Math.max(0, Math.min(topUpRrsp, maxRrspForOas - result.rrspWd));
          } else if (strategy === "optimize") {
            const currentMarginal = getCombinedMarginalRate(currentRrspIncome, fedBpa, fedBrk, provBpa, provBrk);
            if (currentMarginal < terminalRate && rrspAfterWd > 0) {
              let testIncome = currentRrspIncome;
              for (const [threshold] of fedBrk) {
                const bracketEdge = threshold;
                if (!isFinite(bracketEdge)) {
                  // Top bracket rate equals terminal rate — fill to last finite edge only
                  topUpRrsp = Math.max(0, testIncome - currentRrspIncome);
                  break;
                }
                if (bracketEdge > testIncome) {
                  const rateAtEdge = getCombinedMarginalRate(bracketEdge, fedBpa, fedBrk, provBpa, provBrk);
                  if (rateAtEdge >= terminalRate) {
                    topUpRrsp = Math.max(0, bracketEdge - currentRrspIncome);
                    break;
                  }
                  testIncome = bracketEdge;
                }
              }
              topUpRrsp = Math.min(topUpRrsp, rrspAfterWd);
              const maxRrspForOas = Math.max(0, oasThreshNom - lockedIncome);
              topUpRrsp = Math.max(0, Math.min(topUpRrsp, maxRrspForOas - result.rrspWd));
            }
          }
        }

        // Recompute tax with spending + top-up combined
        const finalRrspWd = result.rrspWd + topUpRrsp;
        const finalNrTaxGain = result.nrWd * nrGainFraction * 0.5;
        const finalTax = calcTotalTaxAndClawback(
          finalRrspWd, cpp, oasGross, pension, bridge, other, finalNrTaxGain,
          fedBpa, fedBrk, provBpa, provBrk, oasThreshNom
        );

        // Net = spending withdrawals + benefits - full tax (with credits) - clawback
        // (top-up withdrawal and transfer cancel out, but top-up's tax reduces net)
        const iterFedLowest = fedBrk[0][1];
        const iterProvLowest = provBrk[0][1];
        const iterPensionCredit = calcPensionIncomeCredit(age, finalRrspWd, pension, iterFedLowest, iterProvLowest);
        const iterAgeCredit = calcAgeCredit(age, finalTax.taxableIncome, iterFedLowest, iterProvLowest, infFactor);
        const iterTotalTax = Math.max(0, finalTax.totalTax - iterPensionCredit - iterAgeCredit);
        const spendingWd = result.savWd + result.nrWd + result.rrspWd + result.tfsaWd;
        const iterNet = spendingWd + lockedIncome - iterTotalTax - finalTax.oasClawback;

        const gap = desiredNominal - iterNet;
        if (Math.abs(gap) < 1.0) break;
        grossEstimate += gap;
      }

      savWd = result.savWd;
      nrWd = result.nrWd;
      rrspWd = result.rrspWd;
      tfsaWd = result.tfsaWd;
      grossNominal = grossEstimate;

      // ── RRIF minimum: mandatory withdrawal floor at age 72+ ──
      const rrifMin = getRrifMinimum(age, rrspAvail);
      if (rrifMin > rrspWd) {
        rrspWd = Math.min(rrifMin, rrspAvail);
      }

      // Apply the final top-up to rrspWd
      if (strategy === "optimize" || strategy === "max_estate") {
        const currentRrspIncome = lockedIncome + rrspWd;
        const rrspAfterWd = rrspAvail - rrspWd;
        const terminalRate = estimateTerminalTaxRate(rrspAfterWd, provData, fedBrackets, infFactor);

        let extraRrsp = 0;
        if (strategy === "max_estate" && (lifeExpectancy - age) > 0) {
          const annualTarget = rrspAfterWd / (lifeExpectancy - age);
          extraRrsp = Math.min(rrspAfterWd, Math.max(0, annualTarget - rrspWd));
          const maxRrspForOas = Math.max(0, oasThreshNom - lockedIncome);
          extraRrsp = Math.max(0, Math.min(extraRrsp, maxRrspForOas - rrspWd));
        } else if (strategy === "optimize") {
          const currentMarginal = getCombinedMarginalRate(currentRrspIncome, fedBpa, fedBrk, provBpa, provBrk);
          if (currentMarginal < terminalRate && rrspAfterWd > 0) {
            let testIncome = currentRrspIncome;
            for (const [threshold] of fedBrk) {
              const bracketEdge = threshold;
              if (!isFinite(bracketEdge)) {
                // Top bracket rate equals terminal rate — fill to last finite edge only
                extraRrsp = Math.max(0, testIncome - currentRrspIncome);
                break;
              }
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
            const receivingOas = oasGross > 0;
            if (receivingOas) {
              const maxRrspForOas = Math.max(0, oasThreshNom - lockedIncome);
              extraRrsp = Math.max(0, Math.min(extraRrsp, maxRrspForOas - rrspWd));
            }
          }
        }

        // At age 65+, ensure at least $2,000 RRSP withdrawn to capture pension income credit
        if (age >= 65 && rrspWd + extraRrsp < 2000 && rrspAfterWd > 0) {
          const minForCredit = Math.min(2000 - rrspWd, rrspAfterWd);
          extraRrsp = Math.max(extraRrsp, minForCredit);
        }

        if (extraRrsp > 0) rrspWd += extraRrsp;
      }

      // Recompute tax with final rrspWd (including top-up)
      nrTaxableGain = nrWd * nrGainFraction * 0.5;
      const finalTax = calcTotalTaxAndClawback(
        rrspWd, cpp, oasGross, pension, bridge, other, nrTaxableGain,
        fedBpa, fedBrk, provBpa, provBrk, oasThreshNom
      );
      taxableIncome = finalTax.taxableIncome;
      // Apply pension income credit and age amount credit at 65+
      const fedLowestRate = fedBrk[0][1];
      const provLowestRate = provBrk[0][1];
      const pensionCredit = calcPensionIncomeCredit(age, rrspWd, pension, fedLowestRate, provLowestRate);
      const ageCredit = calcAgeCredit(age, finalTax.taxableIncome, fedLowestRate, provLowestRate, infFactor);
      totalTax = Math.max(0, finalTax.totalTax - pensionCredit - ageCredit);
      oasClawback = finalTax.oasClawback;
    }

    // The RRSP top-up excess is an internal rebalance, not spendable income.
    const portfolioNeed = isRetired ? Math.max(0, grossNominal - (cpp + oasGross + pension + bridge + other)) : 0;
    const rrspToTfsaTransfer = isRetired ? Math.max(0, (savWd + nrWd + rrspWd + tfsaWd) - portfolioNeed) : 0;

    // Net income — total income minus tax, minus OAS clawback, minus the RRSP top-up
    // transfer (which went to TFSA/non-reg and is not spendable cash)
    netIncome = isRetired ? savWd + nrWd + rrspWd + tfsaWd + cpp + oasGross + pension + bridge + other - totalTax - oasClawback - rrspToTfsaTransfer : 0;

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

    rows.push({
      year, age, phase, rrsp, tfsa, nonReg, savings,
      cpp, oasGross, pension, bridge, other, totalPortfolio,
      contribution: isRetired ? 0 : rrspContrib + tfsaContrib + nonRegContrib + savingsContrib,
      desiredNominal, grossNominal, savWd, nrWd, rrspWd, tfsaWd, rrspToTfsaTransfer,
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
