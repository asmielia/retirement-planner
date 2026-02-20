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
// INCOME SMOOTHING
// ═══════════════════════════════════════════════
function getSmoothedIncome(age, activeIncome, slowdownIncome, inactiveIncome) {
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

function getPhaseLabel(age, isRetired) {
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
      // For spend_down mode, drain cash aggressively (no floor needed since goal is full depletion)
      // For other modes, maintain a cash floor of 2 months' spending as a safety net
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
      // This reduces the RRSP balance that would be fully taxed at death
      if (strategy === "optimize" || strategy === "max_estate") {
        const yearsToEnd = lifeExpectancy - age;
        const currentRrspIncome = lockedIncome + rrspWd;
        const currentMarginal = getCombinedMarginalRate(currentRrspIncome, fedBpa, fedBrk, provBpa, provBrk);
        const rrspAfterWd = rrspAvail - rrspWd;
        const terminalRate = estimateTerminalTaxRate(rrspAfterWd, provData, fedBrackets, infFactor);

        let extraRrsp = 0;
        if (strategy === "max_estate" && yearsToEnd > 0) {
          // For estate maximization: spread RRSP evenly across remaining years
          const annualTarget = rrspAfterWd / yearsToEnd;
          extraRrsp = Math.min(rrspAfterWd, Math.max(0, annualTarget - rrspWd));
          // But still cap at OAS threshold to avoid clawback
          const totalRrspWithExtra = rrspWd + extraRrsp;
          const maxRrspForOas = Math.max(0, oasThreshNom - lockedIncome);
          extraRrsp = Math.max(0, Math.min(extraRrsp, maxRrspForOas - rrspWd));
        } else if (currentMarginal < terminalRate && rrspAfterWd > 0) {
          // For optimize: fill up to the point where marginal rate matches terminal rate
          // Find the income level where marginal rate jumps above terminal rate
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
          // Still respect OAS threshold
          const maxRrspForOas = Math.max(0, oasThreshNom - lockedIncome);
          extraRrsp = Math.max(0, Math.min(extraRrsp, maxRrspForOas - rrspWd));
        }

        if (extraRrsp > 0) {
          rrspWd += extraRrsp;
          // Extra RRSP withdrawn beyond spending need goes to savings (cash buffer)
          // This is taxed now at a lower rate instead of at death at a higher rate
        }
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

  return {
    rows, cppOptions, oasOptions, optCpp, optOas,
    portfolioAtRet, hasSurplus, estateValue,
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
// COUPLE PROJECTION ENGINE
// ═══════════════════════════════════════════════
function buildPersonInputs(inputs, who) {
  const p = who === "partner" ? inputs.partner : inputs;
  return {
    currentAge: p.currentAge, retirementAge: p.retirementAge, lifeExpectancy: p.lifeExpectancy,
    employmentIncome: p.employmentIncome || 0,
    rrspBal: p.rrspBal, tfsaBal: p.tfsaBal, nonRegBal: p.nonRegBal, savingsBal: p.savingsBal,
    rrspContrib: p.rrspContrib, tfsaContrib: p.tfsaContrib, nonRegContrib: p.nonRegContrib, savingsContrib: p.savingsContrib,
    pensionIncome: p.pensionIncome, pensionBridge: p.pensionBridge, otherIncome: p.otherIncome,
    cppAt65: p.cppAt65, oasAt65: p.oasAt65, oasClawbackThreshold: p.oasClawbackThreshold,
    // Shared fields
    province: inputs.province, preGrowth: inputs.preGrowth, postGrowth: inputs.postGrowth,
    inflation: inputs.inflation, fedBrackets: inputs.fedBrackets,
    // Income targets (shared)
    activeIncome: inputs.activeIncome, slowdownIncome: inputs.slowdownIncome, inactiveIncome: inputs.inactiveIncome,
  };
}

function runCoupleProjection(inputs, strategy = "optimize") {
  const you = buildPersonInputs(inputs, "you");
  const partner = buildPersonInputs(inputs, "partner");
  const provData = PROVINCES[inputs.province] || PROVINCES.Ontario;

  // Run individual projections for CPP/OAS optimization data only
  const youSolo = runProjection(you);
  const partnerSolo = runProjection(partner);

  // CPP/OAS optimization per person
  const youOptCpp = youSolo.optCpp, youOptOas = youSolo.optOas;
  const partnerOptCpp = partnerSolo.optCpp, partnerOptOas = partnerSolo.optOas;

  // Time horizon: both partners share the same calendar years
  // Total years from now until the latest life expectancy
  const youYearsLeft = you.lifeExpectancy - you.currentAge;
  const partnerYearsLeft = partner.lifeExpectancy - partner.currentAge;
  const totalYears = Math.max(youYearsLeft, partnerYearsLeft) + 1;

  const rows = [];
  let yRrsp = you.rrspBal, yTfsa = you.tfsaBal, yNonReg = you.nonRegBal, ySav = you.savingsBal;
  let pRrsp = partner.rrspBal, pTfsa = partner.tfsaBal, pNonReg = partner.nonRegBal, pSav = partner.savingsBal;

  for (let year = 1; year <= totalYears; year++) {
    const youAge = you.currentAge + (year - 1);
    const partnerAge = partner.currentAge + (year - 1);
    // Use "you" age as the chart x-axis reference
    const yearAge = youAge;
    const infFactor = Math.pow(1 + inputs.inflation, year);

    const youAlive = youAge <= you.lifeExpectancy;
    const partnerAlive = partnerAge <= partner.lifeExpectancy;
    if (!youAlive && !partnerAlive) break;

    const youRetired = youAlive && youAge >= you.retirementAge;
    const partnerRetired = partnerAlive && partnerAge >= partner.retirementAge;

    // Phase based on older alive partner's age
    const olderAge = youAlive && partnerAlive ? Math.max(youAge, partnerAge) : (youAlive ? youAge : partnerAge);
    const anyRetired = youRetired || partnerRetired;
    const phase = getPhaseLabel(olderAge, anyRetired);

    const growthRate = anyRetired ? inputs.postGrowth : inputs.preGrowth;

    // Desired combined income — smoothed transitions between phases
    let desiredBase = 0;
    if (anyRetired) {
      desiredBase = getSmoothedIncome(olderAge, inputs.activeIncome, inputs.slowdownIncome, inputs.inactiveIncome);
    }
    // Survivor: 60% of combined if one partner has passed
    const bothAlive = youAlive && partnerAlive;
    const survivorFactor = bothAlive ? 1.0 : 0.6;
    const desiredNominal = desiredBase * infFactor * survivorFactor;

    // Per-person fixed income
    const fedBrk = inputs.fedBrackets;

    function computePersonFixed(p, pAge, pAlive, pRetired, optCpp, optOas) {
      if (!pAlive) return { cpp: 0, oasGross: 0, pension: 0, bridge: 0, other: 0, employment: 0, total: 0 };

      const cpp = pAge >= optCpp.age ? optCpp.annual * infFactor : 0;
      const oasGross = pAge >= optOas.age ? optOas.annual * infFactor : 0;
      const pension = pRetired ? p.pensionIncome : 0;
      const bridge = (pRetired && pAge < 65) ? p.pensionBridge : 0;
      const other = pRetired ? p.otherIncome * infFactor : 0;
      const employment = !pRetired ? (p.employmentIncome || 0) * infFactor : 0;

      // If not retired but >= 70, they get CPP+OAS + employment
      let total;
      if (!pRetired && pAge >= 70) {
        total = employment + cpp + oasGross;
      } else if (!pRetired) {
        total = employment;
      } else {
        total = cpp + oasGross + pension + bridge + other;
      }

      return { cpp, oasGross, pension, bridge, other, employment, total };
    }

    const youFixed = computePersonFixed(you, youAge, youAlive, youRetired, youOptCpp, youOptOas);
    const partnerFixed = computePersonFixed(partner, partnerAge, partnerAlive, partnerRetired, partnerOptCpp, partnerOptOas);

    const combinedFixed = youFixed.total + partnerFixed.total;
    const portfolioNeed = Math.max(0, desiredNominal - combinedFixed);

    // Available balances with growth
    const yRrspAvail = yRrsp * (1 + growthRate);
    const yTfsaAvail = yTfsa * (1 + growthRate);
    const yNonRegAvail = yNonReg * (1 + growthRate);
    const ySavAvail = ySav;
    const pRrspAvail = pRrsp * (1 + growthRate);
    const pTfsaAvail = pTfsa * (1 + growthRate);
    const pNonRegAvail = pNonReg * (1 + growthRate);
    const pSavAvail = pSav;

    const yTotal = yRrspAvail + yTfsaAvail + yNonRegAvail + ySavAvail;
    const pTotal = pRrspAvail + pTfsaAvail + pNonRegAvail + pSavAvail;
    const combinedTotal = yTotal + pTotal;

    // Withdrawal allocation
    let ySavWd = 0, yNrWd = 0, yRrspWd = 0, yTfsaWd = 0;
    let pSavWd = 0, pNrWd = 0, pRrspWd = 0, pTfsaWd = 0;

    function allocateWithdrawals(need, rrspAvail, tfsaAvail, nonRegAvail, savAvail, oasThreshNom, lockedIncome, person, alive, retired) {
      if (!alive || !retired || need <= 0) return { savWd: 0, nrWd: 0, rrspWd: 0, tfsaWd: 0 };

      const cashFloor = strategy === "spend_down" ? 0 : (desiredNominal / 12) * 2 * (need / Math.max(1, portfolioNeed));
      const savAvailAfterFloor = Math.max(0, savAvail - cashFloor);
      let savWd = Math.min(savAvailAfterFloor, need);
      let rem = need - savWd;

      const rrspRoom = Math.max(0, oasThreshNom - lockedIncome);
      let rrspWd = Math.min(rrspAvail, rem, rrspRoom);
      rem -= rrspWd;

      let nrWd = Math.min(nonRegAvail, rem);
      rem -= nrWd;

      let tfsaWd = Math.min(tfsaAvail, rem);
      rem -= tfsaWd;

      if (rem > 0) {
        const extraSav = Math.min(savAvail - savWd, rem);
        savWd += extraSav;
        rem -= extraSav;
      }

      // RRSP top-up
      if (strategy === "optimize" || strategy === "max_estate") {
        const yearsToEnd = person.lifeExpectancy - (person === you ? youAge : partnerAge);
        const currentRrspIncome = lockedIncome + rrspWd;
        const fedBpa = fedBrk.bpa * infFactor;
        const fedBrackets = fedBrk.brackets.map(([t, r]) => [t * infFactor, r]);
        const provBpa = provData.bpa * infFactor;
        const provBrackets = provData.brackets.map(([t, r]) => [t * infFactor, r]);
        const currentMarginal = getCombinedMarginalRate(currentRrspIncome, fedBpa, fedBrackets, provBpa, provBrackets);
        const rrspAfterWd = rrspAvail - rrspWd;
        const terminalRate = estimateTerminalTaxRate(rrspAfterWd, provData, fedBrk, infFactor);

        let extraRrsp = 0;
        if (strategy === "max_estate" && yearsToEnd > 0) {
          const annualTarget = rrspAfterWd / yearsToEnd;
          extraRrsp = Math.min(rrspAfterWd, Math.max(0, annualTarget - rrspWd));
          const maxRrspForOas = Math.max(0, oasThreshNom - lockedIncome);
          extraRrsp = Math.max(0, Math.min(extraRrsp, maxRrspForOas - rrspWd));
        } else if (currentMarginal < terminalRate && rrspAfterWd > 0) {
          let testIncome = currentRrspIncome;
          for (const [threshold] of fedBrackets) {
            const bracketEdge = threshold;
            if (bracketEdge > testIncome) {
              const rateAtEdge = getCombinedMarginalRate(bracketEdge, fedBpa, fedBrackets, provBpa, provBrackets);
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
        if (extraRrsp > 0) rrspWd += extraRrsp;
      }

      return { savWd, nrWd, rrspWd, tfsaWd };
    }

    if (youRetired || partnerRetired) {
      // Determine who withdraws
      const youCanWithdraw = youAlive && youRetired;
      const partnerCanWithdraw = partnerAlive && partnerRetired;

      if (youCanWithdraw && partnerCanWithdraw) {
        // Both retired: proportional withdrawal
        const youShare = combinedTotal > 0 ? (yTotal / combinedTotal) * portfolioNeed : portfolioNeed / 2;
        const partnerShare = combinedTotal > 0 ? (pTotal / combinedTotal) * portfolioNeed : portfolioNeed / 2;

        const yOasThresh = you.oasClawbackThreshold * infFactor;
        const pOasThresh = partner.oasClawbackThreshold * infFactor;
        const yLocked = youFixed.cpp + youFixed.oasGross + youFixed.pension + youFixed.bridge + youFixed.other;
        const pLocked = partnerFixed.cpp + partnerFixed.oasGross + partnerFixed.pension + partnerFixed.bridge + partnerFixed.other;

        const yWd = allocateWithdrawals(youShare, yRrspAvail, yTfsaAvail, yNonRegAvail, ySavAvail, yOasThresh, yLocked, you, youAlive, youRetired);
        const pWd = allocateWithdrawals(partnerShare, pRrspAvail, pTfsaAvail, pNonRegAvail, pSavAvail, pOasThresh, pLocked, partner, partnerAlive, partnerRetired);

        ySavWd = yWd.savWd; yNrWd = yWd.nrWd; yRrspWd = yWd.rrspWd; yTfsaWd = yWd.tfsaWd;
        pSavWd = pWd.savWd; pNrWd = pWd.nrWd; pRrspWd = pWd.rrspWd; pTfsaWd = pWd.tfsaWd;
      } else if (youCanWithdraw) {
        const yOasThresh = you.oasClawbackThreshold * infFactor;
        const yLocked = youFixed.cpp + youFixed.oasGross + youFixed.pension + youFixed.bridge + youFixed.other;
        const yWd = allocateWithdrawals(portfolioNeed, yRrspAvail, yTfsaAvail, yNonRegAvail, ySavAvail, yOasThresh, yLocked, you, youAlive, youRetired);
        ySavWd = yWd.savWd; yNrWd = yWd.nrWd; yRrspWd = yWd.rrspWd; yTfsaWd = yWd.tfsaWd;
      } else if (partnerCanWithdraw) {
        const pOasThresh = partner.oasClawbackThreshold * infFactor;
        const pLocked = partnerFixed.cpp + partnerFixed.oasGross + partnerFixed.pension + partnerFixed.bridge + partnerFixed.other;
        const pWd = allocateWithdrawals(portfolioNeed, pRrspAvail, pTfsaAvail, pNonRegAvail, pSavAvail, pOasThresh, pLocked, partner, partnerAlive, partnerRetired);
        pSavWd = pWd.savWd; pNrWd = pWd.nrWd; pRrspWd = pWd.rrspWd; pTfsaWd = pWd.tfsaWd;
      }
    }

    // Update balances
    if (youAlive) {
      if (youRetired) {
        const yExtraCash = Math.max(0, (ySavWd + yNrWd + yRrspWd + yTfsaWd) - (combinedTotal > 0 ? (yTotal / combinedTotal) * portfolioNeed : 0));
        yRrsp = Math.max(0, yRrspAvail - yRrspWd);
        yTfsa = Math.max(0, yTfsaAvail - yTfsaWd);
        yNonReg = Math.max(0, yNonRegAvail - yNrWd);
        ySav = Math.max(0, ySavAvail - ySavWd + yExtraCash);
      } else {
        yRrsp = yRrsp * (1 + inputs.preGrowth) + you.rrspContrib;
        yTfsa = yTfsa * (1 + inputs.preGrowth) + you.tfsaContrib;
        yNonReg = yNonReg * (1 + inputs.preGrowth) + you.nonRegContrib;
        ySav = ySav + you.savingsContrib;
      }
    }
    if (partnerAlive) {
      if (partnerRetired) {
        const pExtraCash = Math.max(0, (pSavWd + pNrWd + pRrspWd + pTfsaWd) - (combinedTotal > 0 ? (pTotal / combinedTotal) * portfolioNeed : 0));
        pRrsp = Math.max(0, pRrspAvail - pRrspWd);
        pTfsa = Math.max(0, pTfsaAvail - pTfsaWd);
        pNonReg = Math.max(0, pNonRegAvail - pNrWd);
        pSav = Math.max(0, pSavAvail - pSavWd + pExtraCash);
      } else {
        pRrsp = pRrsp * (1 + inputs.preGrowth) + partner.rrspContrib;
        pTfsa = pTfsa * (1 + inputs.preGrowth) + partner.tfsaContrib;
        pNonReg = pNonReg * (1 + inputs.preGrowth) + partner.nonRegContrib;
        pSav = pSav + partner.savingsContrib;
      }
    }

    const yPortfolio = yRrsp + yTfsa + yNonReg + ySav;
    const pPortfolio = pRrsp + pTfsa + pNonReg + pSav;
    const totalPortfolio = yPortfolio + pPortfolio;

    // Tax per person
    const fedBpa = fedBrk.bpa * infFactor;
    const fedBrackets = fedBrk.brackets.map(([t, r]) => [t * infFactor, r]);
    const provBpa = provData.bpa * infFactor;
    const provBrackets = provData.brackets.map(([t, r]) => [t * infFactor, r]);

    function computeTax(rrspWd, cpp, oasGross, pension, bridge, other, nonRegAvail, oasClawbackThreshold) {
      const taxableIncome = rrspWd + cpp + oasGross + pension + bridge + other + Math.max(0, nonRegAvail * inputs.postGrowth * 0.5);
      const fedTax = calcProgressiveTax(taxableIncome, fedBpa, fedBrackets);
      const provTax = calcProgressiveTax(taxableIncome, provBpa, provBrackets);
      const totalTax = fedTax + provTax;
      const oasThreshNom = oasClawbackThreshold * infFactor;
      const oasClawback = Math.min(oasGross, Math.max(0, (taxableIncome - oasThreshNom) * 0.15));
      return { taxableIncome, totalTax, oasClawback };
    }

    // Compute tax for both retired AND working people (employment income is taxable)
    const yTax = youRetired
      ? computeTax(yRrspWd, youFixed.cpp, youFixed.oasGross, youFixed.pension, youFixed.bridge, youFixed.other, yNonRegAvail, you.oasClawbackThreshold)
      : youAlive && youFixed.employment > 0
        ? (() => { const ti = youFixed.employment; const ft = calcProgressiveTax(ti, fedBpa, fedBrackets); const pt = calcProgressiveTax(ti, provBpa, provBrackets); return { taxableIncome: ti, totalTax: ft + pt, oasClawback: 0 }; })()
        : { taxableIncome: 0, totalTax: 0, oasClawback: 0 };
    const pTax = partnerRetired
      ? computeTax(pRrspWd, partnerFixed.cpp, partnerFixed.oasGross, partnerFixed.pension, partnerFixed.bridge, partnerFixed.other, pNonRegAvail, partner.oasClawbackThreshold)
      : partnerAlive && partnerFixed.employment > 0
        ? (() => { const ti = partnerFixed.employment; const ft = calcProgressiveTax(ti, fedBpa, fedBrackets); const pt = calcProgressiveTax(ti, provBpa, provBrackets); return { taxableIncome: ti, totalTax: ft + pt, oasClawback: 0 }; })()
        : { taxableIncome: 0, totalTax: 0, oasClawback: 0 };

    const totalTax = yTax.totalTax + pTax.totalTax;
    const totalClawback = yTax.oasClawback + pTax.oasClawback;

    const combinedWd = ySavWd + yNrWd + yRrspWd + yTfsaWd + pSavWd + pNrWd + pRrspWd + pTfsaWd;
    const netIncome = combinedWd + combinedFixed - totalTax - totalClawback;

    rows.push({
      year, age: yearAge, youAge, partnerAge, phase,
      rrsp: yRrsp + pRrsp, tfsa: yTfsa + pTfsa, nonReg: yNonReg + pNonReg, savings: ySav + pSav,
      totalPortfolio,
      cpp: youFixed.cpp + partnerFixed.cpp,
      oasGross: youFixed.oasGross + partnerFixed.oasGross,
      pension: youFixed.pension + partnerFixed.pension,
      bridge: youFixed.bridge + partnerFixed.bridge,
      other: youFixed.other + partnerFixed.other,
      employment: youFixed.employment + partnerFixed.employment,
      savWd: ySavWd + pSavWd, nrWd: yNrWd + pNrWd, rrspWd: yRrspWd + pRrspWd, tfsaWd: yTfsaWd + pTfsaWd,
      taxableIncome: yTax.taxableIncome + pTax.taxableIncome,
      totalTax, oasClawback: totalClawback, netIncome,
      desiredNominal,
      realPortfolio: totalPortfolio / infFactor,
      contribution: (!youRetired || !partnerRetired) ? (youAlive && !youRetired ? you.rrspContrib + you.tfsaContrib + you.nonRegContrib + you.savingsContrib : 0) + (partnerAlive && !partnerRetired ? partner.rrspContrib + partner.tfsaContrib + partner.nonRegContrib + partner.savingsContrib : 0) : 0,
      // Per-person data for charts
      you: {
        rrsp: yRrsp, tfsa: yTfsa, nonReg: yNonReg, savings: ySav, totalPortfolio: yPortfolio,
        cpp: youFixed.cpp, oasGross: youFixed.oasGross, pension: youFixed.pension, bridge: youFixed.bridge, other: youFixed.other,
        employment: youFixed.employment,
        savWd: ySavWd, nrWd: yNrWd, rrspWd: yRrspWd, tfsaWd: yTfsaWd,
        ...yTax, netIncome: ySavWd + yNrWd + yRrspWd + yTfsaWd + youFixed.total - yTax.totalTax - yTax.oasClawback,
      },
      partner: {
        rrsp: pRrsp, tfsa: pTfsa, nonReg: pNonReg, savings: pSav, totalPortfolio: pPortfolio,
        cpp: partnerFixed.cpp, oasGross: partnerFixed.oasGross, pension: partnerFixed.pension, bridge: partnerFixed.bridge, other: partnerFixed.other,
        employment: partnerFixed.employment,
        savWd: pSavWd, nrWd: pNrWd, rrspWd: pRrspWd, tfsaWd: pTfsaWd,
        ...pTax, netIncome: pSavWd + pNrWd + pRrspWd + pTfsaWd + partnerFixed.total - pTax.totalTax - pTax.oasClawback,
      },
    });
  }

  const lastRow = rows[rows.length - 1];
  const hasSurplus = lastRow && lastRow.totalPortfolio > 0;

  // Estate value
  let estateValue = null;
  if (lastRow) {
    const finalInfFactor = Math.pow(1 + inputs.inflation, rows.length);
    const yTermRate = estimateTerminalTaxRate(lastRow.you.rrsp, provData, inputs.fedBrackets, finalInfFactor);
    const pTermRate = estimateTerminalTaxRate(lastRow.partner.rrsp, provData, inputs.fedBrackets, finalInfFactor);
    estateValue = {
      tfsa: lastRow.you.tfsa + lastRow.partner.tfsa,
      savings: lastRow.you.savings + lastRow.partner.savings,
      nonReg: (lastRow.you.nonReg + lastRow.partner.nonReg) * (1 - yTermRate * 0.5 * 0.3),
      rrsp: lastRow.you.rrsp * (1 - yTermRate) + lastRow.partner.rrsp * (1 - pTermRate),
      total: 0,
    };
    estateValue.total = estateValue.tfsa + estateValue.savings + estateValue.nonReg + estateValue.rrsp;
  }

  // Find portfolio at retirement (when both/first partner retires)
  const retAge = Math.min(you.retirementAge, partner.retirementAge);
  const retRow = rows.find(r => r.youAge >= you.retirementAge || r.partnerAge >= partner.retirementAge);
  const portfolioAtRet = retRow ? retRow.totalPortfolio : 0;

  return {
    rows, hasSurplus, estateValue, portfolioAtRet,
    // Per-person CPP/OAS results for the CPP page
    youResults: youSolo,
    partnerResults: partnerSolo,
    optCpp: youOptCpp, optOas: youOptOas,
    cppOptions: youSolo.cppOptions, oasOptions: youSolo.oasOptions,
    activeYears: Math.max(0, Math.min(70, you.lifeExpectancy) - retAge),
    slowdownYears: Math.max(0, Math.min(85, you.lifeExpectancy) - Math.max(70, retAge)),
    inactiveYears: Math.max(0, you.lifeExpectancy - Math.max(85, retAge)),
  };
}

// ═══════════════════════════════════════════════
// COUPLE SURPLUS FUNCTIONS
// ═══════════════════════════════════════════════
function findCoupleFundingRatio(inputs) {
  let lo = 0.0, hi = 5.0;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const testInputs = {
      ...inputs,
      activeIncome: inputs.activeIncome * mid,
      slowdownIncome: inputs.slowdownIncome * mid,
      inactiveIncome: inputs.inactiveIncome * mid,
    };
    const result = runCoupleProjection(testInputs);
    const endBal = result.rows[result.rows.length - 1]?.totalPortfolio ?? 0;
    if (endBal > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function runCoupleBoostSpending(inputs) {
  let lo = 1.0, hi = 5.0;
  for (let i = 0; i < 25; i++) {
    const mid = (lo + hi) / 2;
    const boostedInputs = {
      ...inputs,
      activeIncome: inputs.activeIncome * mid,
      slowdownIncome: inputs.slowdownIncome * mid,
      inactiveIncome: inputs.inactiveIncome * mid,
    };
    const result = runCoupleProjection(boostedInputs, "spend_down");
    const endBal = result.rows[result.rows.length - 1]?.totalPortfolio ?? 0;
    if (endBal > 1000) lo = mid; else hi = mid;
  }
  const multiplier = (lo + hi) / 2;
  const finalInputs = {
    ...inputs,
    activeIncome: inputs.activeIncome * multiplier,
    slowdownIncome: inputs.slowdownIncome * multiplier,
    inactiveIncome: inputs.inactiveIncome * multiplier,
  };
  const finalResult = runCoupleProjection(finalInputs, "spend_down");
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

function runCoupleMaxEstate(inputs) {
  const result = runCoupleProjection(inputs, "max_estate");
  return { ...result, surplusMode: "max_estate", hasSurplus: true };
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

function Page1_Personal({ inputs, setField, personTab, isCouple, activePerson, activeSetField }) {
  const who = isCouple ? (personTab === "partner" ? "Your Partner's" : "Your") : "Your";
  return (
    <div>
      <SectionTitle icon="🍁" title={isCouple ? `${personTab === "partner" ? "Your Partner's" : "Your"} Details` : "Let's Plan Your Retirement"}
        subtitle={isCouple ? `Enter ${personTab === "partner" ? "your partner's" : "your"} personal details.` : "We'll start with some basics about you. These determine the time horizon for your savings to grow and how long your retirement income needs to last."} />

      {/* Mode selector — only show on "You" tab */}
      {(!isCouple || personTab === "you") && (
        <div className="mb-8">
          <label className="block text-sm font-medium text-slate-300 mb-2 tracking-wide">Who is this plan for?</label>
          <div className="grid grid-cols-2 gap-3 max-w-md">
            {[
              { key: "single", label: "Just Me", icon: "👤" },
              { key: "couple", label: "Me & My Partner", icon: "👫" },
            ].map(opt => (
              <button key={opt.key}
                onClick={() => setField("mode", opt.key)}
                className={`rounded-lg p-4 border text-left transition-all ${
                  inputs.mode === opt.key
                    ? "bg-amber-400/15 border-amber-400/50 text-white"
                    : "bg-slate-800/40 border-slate-700/40 text-slate-400 hover:border-slate-600"
                }`}>
                <div className="text-xl mb-1">{opt.icon}</div>
                <div className="text-sm font-semibold">{opt.label}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
        <div>
          <Field label={`${who} Current Age`} value={activePerson.currentAge} onChange={v => activeSetField("currentAge", v)} type="number" min={18} max={80} hint="How old are you today?" />
          <Field label={`${who} Desired Retirement Age`} value={activePerson.retirementAge} onChange={v => activeSetField("retirementAge", v)} type="number" min={50} max={75} hint="When do you want to stop working?" />
          <Field label={`${who} Life Expectancy`} value={activePerson.lifeExpectancy} onChange={v => activeSetField("lifeExpectancy", v)} type="number" min={70} max={105} hint="Plan conservatively — the average Canadian lives to 82" />
          <Field label={`${who} Employment Income (Today's $)`} value={activePerson.employmentIncome} onChange={v => activeSetField("employmentIncome", v)} hint="Current annual salary or self-employment income" />
        </div>
        <div>
          {/* Province is shared — only show on "You" tab */}
          {personTab !== "partner" && (
            <>
              <SelectField label="Province of Residence" value={inputs.province} onChange={v => setField("province", v)} options={Object.keys(PROVINCES)} />
              <Explanation>
                Your province determines your tax brackets, which directly affect how much of your retirement income you keep. Tax optimization is one of the most impactful levers in retirement planning.
              </Explanation>
            </>
          )}
          <div className="mt-6 bg-gradient-to-br from-slate-800/60 to-slate-900/60 border border-slate-700/30 rounded-xl p-5">
            <div className="text-xs uppercase tracking-widest text-amber-400/70 mb-3">Planning Horizon</div>
            <div className="flex justify-between items-end">
              <div><div className="text-3xl font-bold text-white">{activePerson.retirementAge - activePerson.currentAge}</div><div className="text-xs text-slate-400">years to save</div></div>
              <div className="text-slate-600 text-2xl">→</div>
              <div><div className="text-3xl font-bold text-amber-400">{activePerson.lifeExpectancy - activePerson.retirementAge}</div><div className="text-xs text-slate-400">years in retirement</div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Page2_Balances({ inputs, setField, personTab, isCouple, activePerson, activeSetField }) {
  const total = activePerson.rrspBal + activePerson.tfsaBal + activePerson.nonRegBal + activePerson.savingsBal;
  const totalContrib = activePerson.rrspContrib + activePerson.tfsaContrib + activePerson.nonRegContrib + activePerson.savingsContrib;
  const who = isCouple ? (personTab === "partner" ? "Your Partner's" : "Your") : "Your";
  return (
    <div>
      <SectionTitle icon="💰" title={`${who} Savings Today`}
        subtitle={`Enter ${isCouple && personTab === "partner" ? "your partner's" : "your"} current account balances and how much ${isCouple && personTab === "partner" ? "they contribute" : "you contribute"} each year.`} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
        <div>
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-4">Current Balances</h3>
          <Field label="RRSP" value={activePerson.rrspBal} onChange={v => activeSetField("rrspBal", v)} hint="Tax-deferred growth, taxable on withdrawal" />
          <Field label="TFSA" value={activePerson.tfsaBal} onChange={v => activeSetField("tfsaBal", v)} hint="Tax-free growth and withdrawal" />
          <Field label="Non-Registered Investment" value={activePerson.nonRegBal} onChange={v => activeSetField("nonRegBal", v)} hint="Investment growth taxed as capital gains (50% inclusion)" />
          <Field label="Savings Account (Cash)" value={activePerson.savingsBal} onChange={v => activeSetField("savingsBal", v)} hint="No investment growth — just cash" />
          <div className="border-t border-slate-700/50 pt-3 mt-2 flex justify-between">
            <span className="text-sm text-slate-400">Total Savings</span>
            <span className="text-lg font-bold text-white">{fmt(total)}</span>
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-4">Annual Contributions</h3>
          <Field label="RRSP" value={activePerson.rrspContrib} onChange={v => activeSetField("rrspContrib", v)} />
          <Field label="TFSA" value={activePerson.tfsaContrib} onChange={v => activeSetField("tfsaContrib", v)} />
          <Field label="Non-Registered" value={activePerson.nonRegContrib} onChange={v => activeSetField("nonRegContrib", v)} />
          <Field label="Savings Account" value={activePerson.savingsContrib} onChange={v => activeSetField("savingsContrib", v)} />
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

function Page3_Income({ inputs, setField, isCouple }) {
  return (
    <div>
      <SectionTitle icon="🏖️" title={isCouple ? "Your Combined Retirement Lifestyle" : "Your Retirement Lifestyle"}
        subtitle={isCouple ? "How much combined annual income do you and your partner need in retirement? These are your total household spending targets." : "How much annual income do you need in retirement? Most people spend more in early retirement (travel, hobbies) and less as they age."} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        {[
          { key: "activeIncome", label: "Active Phase", ages: `Retirement–65, ramps 65–70`, icon: "✈️", desc: "Travel, dining out, new hobbies" },
          { key: "slowdownIncome", label: "Slowdown Phase", ages: "70–80, ramps 80–85", icon: "🏡", desc: "Quieter lifestyle, less travel" },
          { key: "inactiveIncome", label: "Inactive Phase", ages: "85+", icon: "🪑", desc: "Mostly home-based, possible care costs" },
        ].map(p => (
          <div key={p.key} className="bg-slate-800/50 border border-slate-700/40 rounded-xl p-5">
            <div className="text-2xl mb-2">{p.icon}</div>
            <div className="text-sm font-semibold text-white mb-1">{p.label} <span className="text-slate-500 font-normal">({p.ages})</span></div>
            <div className="text-xs text-slate-400 mb-3">{p.desc}</div>
            <Field label={isCouple ? "Combined Annual Income (Today's $)" : "Annual Income (Today's $)"} value={inputs[p.key]} onChange={v => setField(p.key, v)} />
          </div>
        ))}
      </div>
      <Explanation>
        These amounts are in today's dollars — the model automatically adjusts for inflation each year. Income transitions smoothly over 5 years between phases (ages 65–70 and 80–85) to avoid unrealistic spending cliffs. {isCouple ? "These are your combined household spending targets. Phases are based on the older partner's age." : "A common rule of thumb is 70% of pre-retirement income, declining about 20% per phase."}
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

function Page5_CPP({ inputs, setField, personTab, isCouple, activePerson, activeSetField, results }) {
  const showBridge = activePerson.retirementAge < 65;
  const who = isCouple ? (personTab === "partner" ? "Your Partner's" : "Your") : "";
  // For couple mode, use per-person CPP/OAS results
  const personResults = isCouple ? (personTab === "partner" ? results.partnerResults : results.youResults) : results;
  return (
    <div>
      <SectionTitle icon="🏛️" title={`${who ? who + " " : ""}CPP, OAS & Pension`}
        subtitle={`Government benefits and employer pensions form the foundation of ${isCouple && personTab === "partner" ? "your partner's" : "your"} retirement income.`} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 mb-6">
        <div>
          <Field label="CPP Annual Amount at Age 65 (Today's $)" value={activePerson.cppAt65} onChange={v => activeSetField("cppAt65", v)} hint="2025 max: $17,196. Check your My Service Canada Account for your estimate." />
          <Field label="OAS Annual Amount at Age 65 (Today's $)" value={activePerson.oasAt65} onChange={v => activeSetField("oasAt65", v)} hint="2026 max: ~$8,908 (age 65–74)" />
          <Field label="OAS Clawback Threshold (Today's $)" value={activePerson.oasClawbackThreshold} onChange={v => activeSetField("oasClawbackThreshold", v)} hint="2026: $95,323. Above this, 15¢ per dollar is clawed back." />
        </div>
        <div>
          {personResults && (
            <div className="bg-gradient-to-br from-amber-900/20 to-slate-800/60 border border-amber-400/20 rounded-xl p-5">
              <div className="text-xs uppercase tracking-widest text-amber-400/70 mb-4">Optimal Start Ages</div>
              <div className="grid grid-cols-2 gap-4">
                <div className="text-center">
                  <div className="text-4xl font-bold text-amber-400">{personResults.optCpp.age}</div>
                  <div className="text-xs text-slate-400 mt-1">CPP Start Age</div>
                  <div className="text-sm text-white mt-1">{fmt(personResults.optCpp.annual)}/yr</div>
                </div>
                <div className="text-center">
                  <div className="text-4xl font-bold text-amber-400">{personResults.optOas.age}</div>
                  <div className="text-xs text-slate-400 mt-1">OAS Start Age</div>
                  <div className="text-sm text-white mt-1">{fmt(personResults.optOas.annual)}/yr</div>
                </div>
              </div>
            </div>
          )}
          <Explanation>
            CPP decreases by 0.6%/month before 65 (max -36% at 60) and increases by 0.7%/month after 65 (max +42% at 70). OAS increases by 0.6%/month after 65 (max +36% at 70). With a life expectancy of {activePerson.lifeExpectancy}, delaying to {personResults?.optCpp?.age || 65} maximizes total lifetime CPP benefits.
          </Explanation>
        </div>
      </div>
      {personResults && (
        <>
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-widest mb-3">CPP Amount by Start Age</h3>
          <div className="grid grid-cols-11 gap-1 text-center text-xs">
            {personResults.cppOptions.map(o => (
              <div key={o.age} className={`rounded-lg p-2 ${o.age === personResults.optCpp.age ? "bg-amber-400/20 border border-amber-400/40" : "bg-slate-800/40"}`}>
                <div className="text-slate-400">Age {o.age}</div>
                <div className={`font-bold ${o.age === personResults.optCpp.age ? "text-amber-400" : "text-white"}`}>{fmt(o.annual)}</div>
                <div className="text-slate-500">{fmtK(o.lifetime)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Pension & Other Income */}
      <div className="mt-8">
        <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-4">{who ? who + " " : ""}Pension & Other Retirement Income</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
          <div>
            <Field label="Annual Pension Income (Today's $)" value={activePerson.pensionIncome} onChange={v => activeSetField("pensionIncome", v)} hint="Employer defined-benefit pension. Taxed as regular income. Not adjusted for inflation." />
            {showBridge && (
              <Field label="Pension Bridge Benefit (Today's $)" value={activePerson.pensionBridge} onChange={v => activeSetField("pensionBridge", v)} hint={`Extra annual amount paid from retirement until age 65 to cover the gap before CPP/OAS. Taxed as regular income. Not adjusted for inflation.`} />
            )}
          </div>
          <div>
            <Field label="Other Annual Retirement Income (Today's $)" value={activePerson.otherIncome} onChange={v => activeSetField("otherIncome", v)} hint="Rental income, part-time work, annuities, etc. Taxed as regular income. Adjusted for inflation." />
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

function Page6_Results({ inputs, results, surplusMode, setSurplusMode, isCouple }) {
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
            By increasing your spending by {Math.round((results.spendingMultiplier - 1) * 100)}% across all phases, your {isCouple ? "combined portfolios are" : "portfolio is"} projected to be fully utilized by the end of the plan. These amounts are in today's dollars and will be inflation-adjusted each year.
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Portfolio at Retirement" value={fmtK(results.portfolioAtRet)} accent />
        <StatCard label="Portfolio at End" value={fmtK(lastRow?.totalPortfolio)} sub={`Age ${inputs.lifeExpectancy}`} />
        <StatCard label="Total Tax Paid" value={fmtK(totalTaxPaid)} sub="Over retirement" />
        <StatCard label="OAS Clawback" value={totalClawback > 0 ? fmtK(totalClawback) : "$0"} sub={totalClawback > 0 ? "Lost to clawback" : "Fully avoided ✓"} accent={totalClawback === 0} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-3">Tax-Optimized Withdrawal Strategy</h3>
          <div className="space-y-2 text-sm text-slate-300">
            <div className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">1.</span><span><strong className="text-white">Cash savings first</strong> — no growth benefit, so spend it early</span></div>
            <div className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">2.</span><span><strong className="text-white">RRSP to fill low brackets</strong> — drawn up to OAS clawback threshold, plus extra if your current tax rate is lower than the projected rate at death</span></div>
            <div className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">3.</span><span><strong className="text-white">Non-registered next</strong> — only 50% of capital gains are taxable</span></div>
            <div className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">4.</span><span><strong className="text-white">TFSA last</strong> — completely tax-free, let it compound as long as possible</span></div>
            {isCouple && <div className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">•</span><span><strong className="text-white">Proportional split</strong> — when both partners are retired, withdrawals are split proportional to each partner's remaining portfolio</span></div>}
          </div>
        </div>
        <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-3">Guaranteed Income</h3>
          {isCouple ? (
            <div className="space-y-2 text-sm text-slate-300">
              <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold">You</div>
              <div className="flex justify-between"><span>CPP at age {results.youResults.optCpp.age}</span><span className="text-white font-semibold">{fmt(results.youResults.optCpp.annual)}/yr</span></div>
              <div className="flex justify-between"><span>OAS at age {results.youResults.optOas.age}</span><span className="text-white font-semibold">{fmt(results.youResults.optOas.annual)}/yr</span></div>
              {inputs.pensionIncome > 0 && <div className="flex justify-between"><span>Pension</span><span className="text-white font-semibold">{fmt(inputs.pensionIncome)}/yr</span></div>}
              <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold mt-3 pt-2 border-t border-slate-700/40">Your Partner</div>
              <div className="flex justify-between"><span>CPP at age {results.partnerResults.optCpp.age}</span><span className="text-white font-semibold">{fmt(results.partnerResults.optCpp.annual)}/yr</span></div>
              <div className="flex justify-between"><span>OAS at age {results.partnerResults.optOas.age}</span><span className="text-white font-semibold">{fmt(results.partnerResults.optOas.annual)}/yr</span></div>
              {inputs.partner.pensionIncome > 0 && <div className="flex justify-between"><span>Pension</span><span className="text-white font-semibold">{fmt(inputs.partner.pensionIncome)}/yr</span></div>}
              <div className="flex justify-between border-t border-slate-700/40 pt-2"><span>Combined at 65+</span><span className="text-amber-400 font-semibold">{fmt(results.youResults.optCpp.annual + results.youResults.optOas.annual + inputs.pensionIncome + results.partnerResults.optCpp.annual + results.partnerResults.optOas.annual + inputs.partner.pensionIncome)}/yr</span></div>
            </div>
          ) : (
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
          )}
        </div>
      </div>
      <Explanation>
        The funding ratio shows how much of your desired retirement spending your savings can support. 100% means your portfolio exactly covers your lifestyle through life expectancy. Above 100% means you could spend more or leave an estate. Below 100% means you'll need to reduce spending or save more.
      </Explanation>
    </div>
  );
}

function Page7_Charts({ inputs, results, surplusMode, setSurplusMode, isCouple, chartView, setChartView }) {
  // Determine the effective retirement age for filtering
  const retAge = isCouple
    ? chartView === "you" ? inputs.retirementAge
      : chartView === "partner" ? inputs.partner.retirementAge
      : Math.min(inputs.retirementAge, inputs.partner.retirementAge)
    : inputs.retirementAge;

  const chartData = results.rows.map((r, idx) => {
    // Select data source based on chart view
    const src = isCouple && chartView === "you" ? r.you : isCouple && chartView === "partner" ? r.partner : r;
    const portfolio = src.totalPortfolio ?? r.totalPortfolio;
    const infFactor = Math.pow(1 + (inputs.inflation || 0.02), idx + 1);
    // Pick the correct age for the X axis
    const displayAge = isCouple
      ? chartView === "you" ? r.youAge : chartView === "partner" ? r.partnerAge : r.age
      : r.age;
    return {
      age: displayAge, youAge: r.youAge, partnerAge: r.partnerAge,
      portfolio, real: chartView === "combined" || !isCouple ? r.realPortfolio : portfolio / infFactor,
      rrsp: src.rrsp, tfsa: src.tfsa, nonReg: src.nonReg, savings: src.savings,
      cpp: src.cpp, oas: src.oasGross, pension: src.pension, bridge: src.bridge, other: src.other,
      employment: src.employment ?? r.employment ?? 0,
      savWd: src.savWd, nrWd: src.nrWd, rrspWd: src.rrspWd, tfsaWd: src.tfsaWd,
      tax: src.totalTax ?? r.totalTax, clawback: src.oasClawback ?? r.oasClawback, net: src.netIncome ?? r.netIncome, desired: r.desiredNominal,
    };
  });
  const retData = chartData.filter(d => d.age >= retAge);
  const hasEmployment = retData.some(d => d.employment > 0);
  const showDualAge = isCouple && chartView === "combined" && inputs.currentAge !== inputs.partner.currentAge;
  const ttStyle = { backgroundColor: "#1e293b", border: "1px solid #334155", borderRadius: "8px", fontSize: 12 };

  // Custom X axis tick for combined couple view: show both ages
  const DualAgeTick = ({ x, y, payload }) => {
    const d = chartData.find(dd => dd.age === payload.value);
    if (!d) return null;
    return (
      <g transform={`translate(${x},${y})`}>
        <text x={0} y={0} dy={12} textAnchor="middle" fill="#94a3b8" fontSize={10}>{d.youAge}</text>
        <text x={0} y={0} dy={24} textAnchor="middle" fill="#64748b" fontSize={9}>{d.partnerAge}</text>
      </g>
    );
  };

  const xAxisProps = showDualAge
    ? { dataKey: "age", tick: <DualAgeTick />, height: 40, interval: "preserveStartEnd" }
    : { dataKey: "age", tick: { fill: "#94a3b8", fontSize: 11 } };

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    return (
      <div style={ttStyle} className="p-3 shadow-xl">
        {isCouple && chartView === "combined" && d ? (
          <div className="text-amber-400 font-semibold mb-1">You: {d.youAge} / Partner: {d.partnerAge}</div>
        ) : (
          <div className="text-amber-400 font-semibold mb-1">Age {label}</div>
        )}
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

      {/* Couple chart view toggle */}
      {isCouple && (
        <div className="flex items-center justify-end gap-2 mb-4">
          <span className="text-sm text-slate-400">View:</span>
          {[
            { key: "combined", label: "Combined" },
            { key: "you", label: "You" },
            { key: "partner", label: "Partner" },
          ].map(opt => (
            <button key={opt.key}
              onClick={() => setChartView(opt.key)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                chartView === opt.key
                  ? "bg-amber-400/15 text-amber-400 border border-amber-400/40"
                  : "bg-slate-800/60 text-slate-400 border border-slate-700/40 hover:text-white"
              }`}>
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {showDualAge && (
        <div className="text-xs text-slate-500 mb-2 text-right">X-axis: <span className="text-slate-400">Your age</span> / <span className="text-slate-500">Partner's age</span></div>
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
            <XAxis {...xAxisProps} />
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
            <XAxis {...xAxisProps} />
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
            <XAxis {...xAxisProps} />
            <YAxis tickFormatter={fmtK} tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {hasEmployment && <Bar dataKey="employment" name="Employment" stackId="1" fill="#f59e0b" />}
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
        <Explanation>
          {hasEmployment ? "Employment income from the working partner is shown until they retire. " : ""}
          CPP, OAS, pension, and other guaranteed income form the foundation. The bridge benefit covers the gap before age 65. Portfolio withdrawals fill the remainder, with the tax-optimized strategy keeping RRSP withdrawals moderate to avoid OAS clawback.
        </Explanation>
      </div>

      {/* Chart 4: Tax Impact */}
      <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-5 mb-8">
        <h3 className="text-sm font-semibold text-white mb-1">Tax & OAS Clawback</h3>
        <p className="text-xs text-slate-400 mb-4">Annual combined federal + provincial taxes{hasEmployment ? " (including on employment income)" : ""} and any OAS recovery tax</p>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={retData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis {...xAxisProps} />
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
                {[...(isCouple && chartView === "combined" ? ["You","Partner"] : ["Age"]),
                  "Phase","Portfolio","CPP","OAS",
                  ...(inputs.pensionIncome > 0 || (isCouple && inputs.partner.pensionIncome > 0) ? ["Pension"] : []),
                  ...(inputs.pensionBridge > 0 && inputs.retirementAge < 65 ? ["Bridge"] : []),
                  ...((isCouple ? Math.max(inputs.otherIncome, inputs.partner.otherIncome) : inputs.otherIncome) > 0 ? ["Other"] : []),
                  ...(hasEmployment ? ["Employ"] : []),
                  "Sav Wd","NR Wd","RRSP Wd","TFSA Wd","Taxable","Tax","Clawback","Net Income"].map(h => (
                  <th key={h} className="px-2 py-2 text-right font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.rows.filter(r => {
                const dispAge = isCouple && chartView === "you" ? r.youAge : isCouple && chartView === "partner" ? r.partnerAge : r.age;
                return dispAge >= retAge;
              }).map(r => {
                const s = isCouple && chartView === "you" ? r.you : isCouple && chartView === "partner" ? r.partner : r;
                const dispAge = isCouple && chartView === "you" ? r.youAge : isCouple && chartView === "partner" ? r.partnerAge : r.age;
                return (
                  <tr key={r.age} className="border-b border-slate-800/50 hover:bg-slate-700/20">
                    {isCouple && chartView === "combined" ? (
                      <><td className="px-2 py-1.5 text-white font-medium">{r.youAge}</td><td className="px-2 py-1.5 text-slate-400">{r.partnerAge}</td></>
                    ) : (
                      <td className="px-2 py-1.5 text-white font-medium">{dispAge}</td>
                    )}
                    <td className="px-2 py-1.5 text-slate-400">{r.phase}</td>
                    {[s.totalPortfolio ?? r.totalPortfolio, s.cpp, s.oasGross,
                      ...(inputs.pensionIncome > 0 || (isCouple && inputs.partner.pensionIncome > 0) ? [s.pension] : []),
                      ...(inputs.pensionBridge > 0 && inputs.retirementAge < 65 ? [s.bridge] : []),
                      ...((isCouple ? Math.max(inputs.otherIncome, inputs.partner.otherIncome) : inputs.otherIncome) > 0 ? [s.other] : []),
                      ...(hasEmployment ? [s.employment ?? r.employment ?? 0] : []),
                      s.savWd, s.nrWd, s.rrspWd, s.tfsaWd,
                      s.taxableIncome ?? r.taxableIncome, s.totalTax ?? r.totalTax, s.oasClawback ?? r.oasClawback, s.netIncome ?? r.netIncome].map((v,i) => (
                      <td key={i} className="px-2 py-1.5 text-right text-slate-300">{fmtK(v)}</td>
                    ))}
                  </tr>
                );
              })}
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
const PARTNER_DEFAULTS = {
  currentAge: 35, retirementAge: 65, lifeExpectancy: 90, employmentIncome: 0,
  rrspBal: 50000, tfsaBal: 40000, nonRegBal: 20000, savingsBal: 15000,
  rrspContrib: 10000, tfsaContrib: 7000, nonRegContrib: 5000, savingsContrib: 3000,
  pensionIncome: 0, pensionBridge: 0, otherIncome: 0,
  cppAt65: 17196, oasAt65: 8908, oasClawbackThreshold: 95323,
};

const DEFAULTS = {
  mode: "single",
  currentAge: 35, retirementAge: 65, lifeExpectancy: 90, province: "Ontario",
  employmentIncome: 0,
  rrspBal: 50000, tfsaBal: 40000, nonRegBal: 20000, savingsBal: 15000,
  rrspContrib: 10000, tfsaContrib: 7000, nonRegContrib: 5000, savingsContrib: 3000,
  activeIncome: 70000, slowdownIncome: 55000, inactiveIncome: 40000,
  pensionIncome: 0, pensionBridge: 0, otherIncome: 0,
  preGrowth: 0.06, postGrowth: 0.04, inflation: 0.02,
  cppAt65: 17196, oasAt65: 8908, oasClawbackThreshold: 95323,
  fedBrackets: FED_BRACKETS_DEFAULT,
  partner: { ...PARTNER_DEFAULTS },
};

const PAGES = [
  { title: "Personal", icon: "🍁", perPerson: true },
  { title: "Savings", icon: "💰", perPerson: true },
  { title: "CPP & OAS", icon: "🏛️", perPerson: true },
  { title: "Rates", icon: "📊" },
  { title: "Income", icon: "🏖️" },
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
      return {
        ...DEFAULTS,
        ...parsed,
        fedBrackets: DEFAULTS.fedBrackets,
        partner: { ...PARTNER_DEFAULTS, ...(parsed.partner || {}) },
      };
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
  const [personTab, setPersonTab] = useState("you");
  const [chartView, setChartView] = useState("combined");

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

  const setPartnerField = useCallback((key, value) => {
    setInputs(prev => ({ ...prev, partner: { ...prev.partner, [key]: value } }));
  }, []);

  const isCouple = inputs.mode === "couple";
  const currentPageDef = PAGES[page];

  const results = useMemo(() => {
    if (isCouple) {
      const fundingRatio = findCoupleFundingRatio(inputs);
      const base = runCoupleProjection(inputs);
      if (!base.hasSurplus) {
        return { ...base, surplusMode: null, fundingRatio };
      }
      if (surplusMode === "boost_spending") {
        return { ...runCoupleBoostSpending(inputs), fundingRatio };
      }
      return { ...runCoupleMaxEstate(inputs), fundingRatio };
    }
    const fundingRatio = findFundingRatio(inputs);
    const base = runProjection(inputs);
    if (!base.hasSurplus) {
      return { ...base, surplusMode: null, fundingRatio };
    }
    if (surplusMode === "boost_spending") {
      return { ...runBoostSpending(inputs), fundingRatio };
    }
    return { ...runMaxEstate(inputs), fundingRatio };
  }, [inputs, surplusMode, isCouple]);

  const scrollTop = () => setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);

  // Couple-aware navigation
  const handleNext = useCallback(() => {
    if (isCouple && currentPageDef?.perPerson && personTab === "you") {
      setPersonTab("partner");
    } else {
      setPage(p => Math.min(PAGES.length - 1, p + 1));
      if (isCouple) setPersonTab("you");
    }
    scrollTop();
  }, [isCouple, currentPageDef, personTab]);

  const handleBack = useCallback(() => {
    if (isCouple && currentPageDef?.perPerson && personTab === "partner") {
      setPersonTab("you");
    } else {
      setPage(p => {
        const prev = Math.max(0, p - 1);
        if (isCouple && PAGES[prev]?.perPerson) setPersonTab("partner");
        return prev;
      });
    }
    scrollTop();
  }, [isCouple, currentPageDef, personTab]);

  // Per-person helpers for current tab
  const activePerson = personTab === "partner" ? inputs.partner : inputs;
  const activeSetField = personTab === "partner" ? setPartnerField : setField;

  const pages = [
    <Page1_Personal inputs={inputs} setField={setField} setPartnerField={setPartnerField} personTab={personTab} isCouple={isCouple} activePerson={activePerson} activeSetField={activeSetField} />,
    <Page2_Balances inputs={inputs} setField={setField} personTab={personTab} isCouple={isCouple} activePerson={activePerson} activeSetField={activeSetField} />,
    <Page5_CPP inputs={inputs} setField={setField} personTab={personTab} isCouple={isCouple} activePerson={activePerson} activeSetField={activeSetField} results={results} />,
    <Page4_Rates inputs={inputs} setField={setField} />,
    <Page3_Income inputs={inputs} setField={setField} isCouple={isCouple} />,
    <Page6_Results inputs={inputs} results={results} surplusMode={surplusMode} setSurplusMode={setSurplusMode} isCouple={isCouple} />,
    <Page7_Charts inputs={inputs} results={results} surplusMode={surplusMode} setSurplusMode={setSurplusMode} isCouple={isCouple} chartView={chartView} setChartView={setChartView} />,
  ];

  // Next button label
  const isLastPage = page === PAGES.length - 1;
  const isSecondLastPage = page === PAGES.length - 2;
  let nextLabel = isSecondLastPage ? "See Results →" : "Next →";
  if (isCouple && currentPageDef?.perPerson && personTab === "you") {
    nextLabel = "Next: Your Partner →";
  }

  // Back button disabled state
  const backDisabled = page === 0 && (!isCouple || personTab === "you");

  return (
    <div className="min-h-screen bg-slate-900 text-white" style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />

      {/* Progress bar */}
      <div className="sticky top-0 z-50 bg-slate-900/90 backdrop-blur border-b border-slate-800/80">
        <div className="max-w-5xl mx-auto px-4 py-3">
          <div className="flex items-center gap-1">
            {PAGES.map((p, i) => (
              <button key={i} onClick={() => { setPage(i); setPersonTab("you"); scrollTop(); }}
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

      {/* Floating You/Partner toggle */}
      {isCouple && currentPageDef?.perPerson && (
        <div className="sticky top-[52px] z-40 bg-slate-900/95 backdrop-blur border-b border-slate-800/60">
          <div className="max-w-5xl mx-auto px-4 py-2 flex items-center justify-center gap-2">
            {[
              { key: "you", label: "You" },
              { key: "partner", label: "Your Partner" },
            ].map(opt => (
              <button key={opt.key}
                onClick={() => setPersonTab(opt.key)}
                className={`px-5 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  personTab === opt.key
                    ? "bg-amber-400/15 text-amber-400 border border-amber-400/40"
                    : "bg-slate-800/60 text-slate-400 border border-slate-700/40 hover:text-white hover:border-slate-600"
                }`}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Page content */}
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div key={`${page}-${personTab}`} className="animate-fadeIn">{pages[page]}</div>

        {/* Navigation */}
        <div className="flex justify-between mt-10 pt-6 border-t border-slate-800/60">
          <button onClick={handleBack} disabled={backDisabled}
            className={`px-6 py-2.5 rounded-lg font-medium text-sm transition-all ${backDisabled ? "text-slate-600 cursor-not-allowed" : "text-slate-300 hover:text-white hover:bg-slate-800"}`}>
            ← Back
          </button>
          <button onClick={handleNext} disabled={isLastPage}
            className={`px-6 py-2.5 rounded-lg font-medium text-sm transition-all ${isLastPage ? "text-slate-600 cursor-not-allowed" : "bg-amber-400 text-slate-900 hover:bg-amber-300"}`}>
            {nextLabel}
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
