import { PROVINCES, calcProgressiveTax, calcTotalTaxAndClawback, getCombinedMarginalRate, estimateTerminalTaxRate, calcPensionIncomeCredit, calcAgeCredit } from "./tax.js";
import { runProjection, getSmoothedIncome, getPhaseLabel } from "./projection.js";
import { getRrifMinimum } from "./constants.js";

// ═══════════════════════════════════════════════
// COUPLE PROJECTION ENGINE
// ═══════════════════════════════════════════════
export function buildPersonInputs(inputs, who) {
  const p = who === "partner" ? inputs.partner : inputs;
  return {
    currentAge: p.currentAge, retirementAge: p.retirementAge, lifeExpectancy: p.lifeExpectancy,
    originalRetirementAge: p.originalRetirementAge || p.retirementAge,
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

export function runCoupleProjection(inputs, strategy = "optimize") {
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
  const youYearsLeft = you.lifeExpectancy - you.currentAge;
  const partnerYearsLeft = partner.lifeExpectancy - partner.currentAge;
  const totalYears = Math.max(youYearsLeft, partnerYearsLeft) + 1;

  const rows = [];
  let yRrsp = you.rrspBal, yTfsa = you.tfsaBal, yNonReg = you.nonRegBal, ySav = you.savingsBal;
  let pRrsp = partner.rrspBal, pTfsa = partner.tfsaBal, pNonReg = partner.nonRegBal, pSav = partner.savingsBal;
  let yTfsaRoom = 0, pTfsaRoom = 0; // TFSA contribution room starts at 0 today
  let yNonRegCostBasis = you.nonRegBal, pNonRegCostBasis = partner.nonRegBal;

  for (let year = 1; year <= totalYears; year++) {
    const youAge = you.currentAge + (year - 1);
    const partnerAge = partner.currentAge + (year - 1);
    const yearAge = youAge;
    const infFactor = Math.pow(1 + inputs.inflation, year);

    const youAlive = youAge <= you.lifeExpectancy;
    const partnerAlive = partnerAge <= partner.lifeExpectancy;
    if (!youAlive && !partnerAlive) break;

    const youRetired = youAlive && youAge >= you.retirementAge;
    const partnerRetired = partnerAlive && partnerAge >= partner.retirementAge;

    const olderAge = youAlive && partnerAlive ? Math.max(youAge, partnerAge) : (youAlive ? youAge : partnerAge);
    const anyRetired = youRetired || partnerRetired;
    const phase = getPhaseLabel(olderAge, anyRetired);

    const growthRate = anyRetired ? inputs.postGrowth : inputs.preGrowth;

    // Desired combined income — smoothed transitions between phases
    // This is now the NET target (after tax + OAS clawback)
    let desiredBase = 0;
    if (anyRetired) {
      desiredBase = getSmoothedIncome(olderAge, inputs.activeIncome, inputs.slowdownIncome, inputs.inactiveIncome);
    }
    const bothAlive = youAlive && partnerAlive;
    const survivorFactor = bothAlive ? 1.0 : 0.6;
    const desiredNominal = desiredBase * infFactor * survivorFactor;

    const fedBrk = inputs.fedBrackets;

    function computePersonFixed(p, pAge, pAlive, pRetired, optCpp, optOas) {
      if (!pAlive) return { cpp: 0, oasGross: 0, pension: 0, bridge: 0, other: 0, employment: 0, total: 0 };

      const cpp = pAge >= optCpp.age ? optCpp.annual * infFactor : 0;
      const oasBase = pAge >= 75 ? optOas.annual * 1.10 : optOas.annual;
      const oasGross = pAge >= optOas.age ? oasBase * infFactor : 0;
      // Pension starts at the originally planned retirement age (DB pension benefit).
      // Bridge covers gap from originally planned retirement age to 65.
      const pension = pAge >= p.originalRetirementAge ? p.pensionIncome : 0;
      const bridge = (pAge >= p.originalRetirementAge && pAge < 65) ? p.pensionBridge : 0;
      const other = pRetired ? p.otherIncome * infFactor : 0;
      const employment = !pRetired ? (p.employmentIncome || 0) * infFactor : 0;

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

    // Compute non-reg capital gain fractions BEFORE withdrawals
    const yNrGainFrac = yNonRegAvail > 0 ? Math.max(0, 1 - yNonRegCostBasis / yNonRegAvail) : 0;
    const pNrGainFrac = pNonRegAvail > 0 ? Math.max(0, 1 - pNonRegCostBasis / pNonRegAvail) : 0;

    let ySavWd = 0, yNrWd = 0, yRrspWd = 0, yTfsaWd = 0;
    let pSavWd = 0, pNrWd = 0, pRrspWd = 0, pTfsaWd = 0;
    let grossNominal = 0;

    // Spending-only withdrawal allocation (no RRSP top-up)
    function allocateSpendingWithdrawals(need, grossTarget, rrspAvail, tfsaAvail, nonRegAvail, savAvail, oasThreshNom, lockedIncome, oasGross, alive, retired) {
      if (!alive || !retired || need <= 0) return { savWd: 0, nrWd: 0, rrspWd: 0, tfsaWd: 0 };

      const portfolioNeed = Math.max(0, grossTarget - combinedFixed);
      const cashFloor = strategy === "spend_down" ? 0 : (grossTarget / 12) * 2 * (need / Math.max(1, portfolioNeed));
      const savAvailAfterFloor = Math.max(0, savAvail - cashFloor);
      let savWd = Math.min(savAvailAfterFloor, need);
      let rem = need - savWd;

      const receivingOas = oasGross > 0;
      let rrspWd, nrWd, tfsaWd;

      if (receivingOas) {
        const rrspRoom = Math.max(0, oasThreshNom - lockedIncome);
        rrspWd = Math.min(rrspAvail, rem, rrspRoom);
        rem -= rrspWd;

        nrWd = Math.min(nonRegAvail, rem);
        rem -= nrWd;

        tfsaWd = Math.min(tfsaAvail, rem);
        rem -= tfsaWd;
      } else {
        rrspWd = Math.min(rrspAvail, rem);
        rem -= rrspWd;

        nrWd = Math.min(nonRegAvail, rem);
        rem -= nrWd;

        tfsaWd = Math.min(tfsaAvail, rem);
        rem -= tfsaWd;
      }

      if (rem > 0) {
        const extraSav = Math.min(savAvail - savWd, rem);
        savWd += extraSav;
        rem -= extraSav;
      }

      if (rem > 0) {
        const extraRrsp = Math.min(rrspAvail - rrspWd, rem);
        rrspWd += extraRrsp;
        rem -= extraRrsp;
      }

      return { savWd, nrWd, rrspWd, tfsaWd };
    }

    // RRSP top-up (separate from spending allocation)
    function applyRrspTopUp(rrspWd, rrspAvail, lockedIncome, oasThreshNom, person, personAge, oasGross) {
      if (strategy !== "optimize" && strategy !== "max_estate") return 0;

      const yearsToEnd = person.lifeExpectancy - personAge;
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
        // Bracket ceiling: fill to where marginal rate reaches terminal rate
        let bracketCeiling = 0;
        let testIncome = currentRrspIncome;
        for (const [threshold] of fedBrackets) {
          const bracketEdge = threshold;
          if (!isFinite(bracketEdge)) {
            bracketCeiling = Math.max(0, testIncome - currentRrspIncome);
            break;
          }
          if (bracketEdge > testIncome) {
            const rateAtEdge = getCombinedMarginalRate(bracketEdge, fedBpa, fedBrackets, provBpa, provBrackets);
            if (rateAtEdge >= terminalRate) {
              bracketCeiling = Math.max(0, bracketEdge - currentRrspIncome);
              break;
            }
            testIncome = bracketEdge;
          }
        }
        // Temporal cap: spread RRSP evenly over remaining years
        const annualTarget = yearsToEnd > 0 ? rrspAfterWd / yearsToEnd : rrspAfterWd;
        const temporalCap = Math.max(0, annualTarget - rrspWd);
        extraRrsp = Math.min(bracketCeiling, temporalCap, rrspAfterWd);
        // Only cap at OAS threshold when receiving OAS — pre-OAS years are the
        // golden window for aggressive RRSP meltdown with no clawback risk
        const receivingOas = oasGross > 0;
        if (receivingOas) {
          const maxRrspForOas = Math.max(0, oasThreshNom - lockedIncome);
          extraRrsp = Math.max(0, Math.min(extraRrsp, maxRrspForOas - rrspWd));
        }
      }

      // At age 65+, ensure at least $2,000 RRSP withdrawn to capture pension income credit
      if (personAge >= 65 && rrspWd + extraRrsp < 2000 && rrspAfterWd > 0) {
        const minForCredit = Math.min(2000 - rrspWd, rrspAfterWd);
        extraRrsp = Math.max(extraRrsp, minForCredit);
      }

      return extraRrsp;
    }

    if (youRetired || partnerRetired) {
      const youCanWithdraw = youAlive && youRetired;
      const partnerCanWithdraw = partnerAlive && partnerRetired;

      const yOasThresh = you.oasClawbackThreshold * infFactor;
      const pOasThresh = partner.oasClawbackThreshold * infFactor;
      const yLocked = youFixed.cpp + youFixed.oasGross + youFixed.pension + youFixed.bridge + youFixed.other;
      const pLocked = partnerFixed.cpp + partnerFixed.oasGross + partnerFixed.pension + partnerFixed.bridge + partnerFixed.other;

      // Tax bracket info for this year
      const fedBpa = fedBrk.bpa * infFactor;
      const fedBrackets = fedBrk.brackets.map(([t, r]) => [t * infFactor, r]);
      const provBpa = provData.bpa * infFactor;
      const provBrackets = provData.brackets.map(([t, r]) => [t * infFactor, r]);

      // ── Iterative net-income targeting ──
      let grossEstimate = desiredNominal;

      for (let iter = 0; iter < 10; iter++) {
        const portfolioNeed = Math.max(0, grossEstimate - combinedFixed);

        let yWd = { savWd: 0, nrWd: 0, rrspWd: 0, tfsaWd: 0 };
        let pWd = { savWd: 0, nrWd: 0, rrspWd: 0, tfsaWd: 0 };

        if (youCanWithdraw && partnerCanWithdraw) {
          const youShare = combinedTotal > 0 ? (yTotal / combinedTotal) * portfolioNeed : portfolioNeed / 2;
          const partnerShare = combinedTotal > 0 ? (pTotal / combinedTotal) * portfolioNeed : portfolioNeed / 2;
          yWd = allocateSpendingWithdrawals(youShare, grossEstimate, yRrspAvail, yTfsaAvail, yNonRegAvail, ySavAvail, yOasThresh, yLocked, youFixed.oasGross, youAlive, youRetired);
          pWd = allocateSpendingWithdrawals(partnerShare, grossEstimate, pRrspAvail, pTfsaAvail, pNonRegAvail, pSavAvail, pOasThresh, pLocked, partnerFixed.oasGross, partnerAlive, partnerRetired);
        } else if (youCanWithdraw) {
          yWd = allocateSpendingWithdrawals(portfolioNeed, grossEstimate, yRrspAvail, yTfsaAvail, yNonRegAvail, ySavAvail, yOasThresh, yLocked, youFixed.oasGross, youAlive, youRetired);
        } else if (partnerCanWithdraw) {
          pWd = allocateSpendingWithdrawals(portfolioNeed, grossEstimate, pRrspAvail, pTfsaAvail, pNonRegAvail, pSavAvail, pOasThresh, pLocked, partnerFixed.oasGross, partnerAlive, partnerRetired);
        }

        // Compute per-person RRSP top-up inside iteration so its tax impact is accounted for
        const yNrTaxGain = yWd.nrWd * yNrGainFrac * 0.5;
        const pNrTaxGain = pWd.nrWd * pNrGainFrac * 0.5;

        const yTopUp = youCanWithdraw ? applyRrspTopUp(yWd.rrspWd, yRrspAvail, yLocked, yOasThresh, you, youAge, youFixed.oasGross) : 0;
        const pTopUp = partnerCanWithdraw ? applyRrspTopUp(pWd.rrspWd, pRrspAvail, pLocked, pOasThresh, partner, partnerAge, partnerFixed.oasGross) : 0;

        // Recompute tax with spending + top-up combined
        const yFinalRrspWd = yWd.rrspWd + yTopUp;
        const pFinalRrspWd = pWd.rrspWd + pTopUp;

        const yTaxResult = youRetired
          ? calcTotalTaxAndClawback(yFinalRrspWd, youFixed.cpp, youFixed.oasGross, youFixed.pension, youFixed.bridge, youFixed.other, yNrTaxGain, fedBpa, fedBrackets, provBpa, provBrackets, yOasThresh)
          : { taxableIncome: 0, totalTax: 0, oasClawback: 0 };
        const pTaxResult = partnerRetired
          ? calcTotalTaxAndClawback(pFinalRrspWd, partnerFixed.cpp, partnerFixed.oasGross, partnerFixed.pension, partnerFixed.bridge, partnerFixed.other, pNrTaxGain, fedBpa, fedBrackets, provBpa, provBrackets, pOasThresh)
          : { taxableIncome: 0, totalTax: 0, oasClawback: 0 };

        // Apply tax credits to iteration tax computation
        const iterFedLowest = fedBrackets[0][1];
        const iterProvLowest = provBrackets[0][1];
        const yIterPensionCredit = youRetired ? calcPensionIncomeCredit(youAge, yFinalRrspWd, youFixed.pension, iterFedLowest, iterProvLowest) : 0;
        const yIterAgeCredit = youRetired ? calcAgeCredit(youAge, yTaxResult.taxableIncome, iterFedLowest, iterProvLowest, infFactor) : 0;
        const pIterPensionCredit = partnerRetired ? calcPensionIncomeCredit(partnerAge, pFinalRrspWd, partnerFixed.pension, iterFedLowest, iterProvLowest) : 0;
        const pIterAgeCredit = partnerRetired ? calcAgeCredit(partnerAge, pTaxResult.taxableIncome, iterFedLowest, iterProvLowest, infFactor) : 0;
        const combinedTax = Math.max(0, yTaxResult.totalTax - yIterPensionCredit - yIterAgeCredit) + Math.max(0, pTaxResult.totalTax - pIterPensionCredit - pIterAgeCredit);
        const combinedClawback = yTaxResult.oasClawback + pTaxResult.oasClawback;
        // Net = spending withdrawals + fixed income - full tax (with credits) - clawback
        const yTotalWd = yWd.savWd + yWd.nrWd + yWd.rrspWd + yWd.tfsaWd;
        const pTotalWd = pWd.savWd + pWd.nrWd + pWd.rrspWd + pWd.tfsaWd;
        const iterNet = yTotalWd + pTotalWd + combinedFixed - combinedTax - combinedClawback;

        const gap = desiredNominal - iterNet;
        if (Math.abs(gap) < 1.0) {
          ySavWd = yWd.savWd; yNrWd = yWd.nrWd; yRrspWd = yWd.rrspWd; yTfsaWd = yWd.tfsaWd;
          pSavWd = pWd.savWd; pNrWd = pWd.nrWd; pRrspWd = pWd.rrspWd; pTfsaWd = pWd.tfsaWd;
          grossNominal = grossEstimate;
          break;
        }

        // Store latest result in case we hit max iterations
        ySavWd = yWd.savWd; yNrWd = yWd.nrWd; yRrspWd = yWd.rrspWd; yTfsaWd = yWd.tfsaWd;
        pSavWd = pWd.savWd; pNrWd = pWd.nrWd; pRrspWd = pWd.rrspWd; pTfsaWd = pWd.tfsaWd;
        grossNominal = grossEstimate;

        grossEstimate += gap;
      }

      // RRIF minimum: mandatory withdrawal floor at age 72+
      if (youCanWithdraw) {
        const yRrifMin = getRrifMinimum(youAge, yRrspAvail);
        if (yRrifMin > yRrspWd) yRrspWd = Math.min(yRrifMin, yRrspAvail);
      }
      if (partnerCanWithdraw) {
        const pRrifMin = getRrifMinimum(partnerAge, pRrspAvail);
        if (pRrifMin > pRrspWd) pRrspWd = Math.min(pRrifMin, pRrspAvail);
      }

      // Apply RRSP top-up after iteration converges (tax optimization, not spending)
      if (youCanWithdraw) {
        const extraYRrsp = applyRrspTopUp(yRrspWd, yRrspAvail, yLocked, yOasThresh, you, youAge, youFixed.oasGross);
        if (extraYRrsp > 0) yRrspWd += extraYRrsp;
      }
      if (partnerCanWithdraw) {
        const extraPRrsp = applyRrspTopUp(pRrspWd, pRrspAvail, pLocked, pOasThresh, partner, partnerAge, partnerFixed.oasGross);
        if (extraPRrsp > 0) pRrspWd += extraPRrsp;
      }
    }

    // Recompute non-reg taxable gains with final withdrawals
    const yNrTaxableGain = yNrWd * yNrGainFrac * 0.5;
    const pNrTaxableGain = pNrWd * pNrGainFrac * 0.5;

    // Track RRSP→TFSA rebalance per partner (not spendable income)
    const portfolioNeed = Math.max(0, grossNominal - combinedFixed);
    const yTransfer = youRetired ? Math.max(0, (ySavWd + yNrWd + yRrspWd + yTfsaWd) - (combinedTotal > 0 ? (yTotal / combinedTotal) * portfolioNeed : 0)) : 0;
    const pTransfer = partnerRetired ? Math.max(0, (pSavWd + pNrWd + pRrspWd + pTfsaWd) - (combinedTotal > 0 ? (pTotal / combinedTotal) * portfolioNeed : 0)) : 0;
    const totalTransfer = yTransfer + pTransfer;

    // Update balances — RRSP top-up excess goes to TFSA (up to contribution room), overflow to non-reg
    // TFSA contribution room: $7K/year per person accrues, withdrawals restore room
    if (youAlive) {
      yTfsaRoom += 7000;
      if (youRetired) {
        yTfsaRoom += yTfsaWd; // withdrawals restore contribution room
        const yExtraFromTopUp = Math.max(0, (ySavWd + yNrWd + yRrspWd + yTfsaWd) - (combinedTotal > 0 ? (yTotal / combinedTotal) * portfolioNeed : 0));
        const yToTfsa = Math.min(yExtraFromTopUp, yTfsaRoom);
        const yToNonReg = yExtraFromTopUp - yToTfsa;
        yTfsaRoom -= yToTfsa;
        yRrsp = Math.max(0, yRrspAvail - yRrspWd);
        yTfsa = Math.max(0, yTfsaAvail - yTfsaWd) + yToTfsa;
        yNonReg = Math.max(0, yNonRegAvail - yNrWd) + yToNonReg;
        ySav = Math.max(0, ySavAvail - ySavWd);
        // Update cost basis: reduce proportionally on withdrawal, increase by top-up overflow
        if (yNonRegAvail > 0 && yNrWd > 0) {
          yNonRegCostBasis = yNonRegCostBasis * (1 - yNrWd / yNonRegAvail) + yToNonReg;
        } else {
          yNonRegCostBasis += yToNonReg;
        }
      } else {
        yTfsaRoom -= you.tfsaContrib; // pre-retirement contributions use room
        yRrsp = yRrsp * (1 + inputs.preGrowth) + you.rrspContrib;
        yTfsa = yTfsa * (1 + inputs.preGrowth) + you.tfsaContrib;
        yNonReg = yNonReg * (1 + inputs.preGrowth) + you.nonRegContrib;
        yNonRegCostBasis += you.nonRegContrib;
        ySav = ySav + you.savingsContrib;
      }
    }
    if (partnerAlive) {
      pTfsaRoom += 7000;
      if (partnerRetired) {
        pTfsaRoom += pTfsaWd; // withdrawals restore contribution room
        const pExtraFromTopUp = Math.max(0, (pSavWd + pNrWd + pRrspWd + pTfsaWd) - (combinedTotal > 0 ? (pTotal / combinedTotal) * portfolioNeed : 0));
        const pToTfsa = Math.min(pExtraFromTopUp, pTfsaRoom);
        const pToNonReg = pExtraFromTopUp - pToTfsa;
        pTfsaRoom -= pToTfsa;
        pRrsp = Math.max(0, pRrspAvail - pRrspWd);
        pTfsa = Math.max(0, pTfsaAvail - pTfsaWd) + pToTfsa;
        pNonReg = Math.max(0, pNonRegAvail - pNrWd) + pToNonReg;
        pSav = Math.max(0, pSavAvail - pSavWd);
        // Update cost basis: reduce proportionally on withdrawal, increase by top-up overflow
        if (pNonRegAvail > 0 && pNrWd > 0) {
          pNonRegCostBasis = pNonRegCostBasis * (1 - pNrWd / pNonRegAvail) + pToNonReg;
        } else {
          pNonRegCostBasis += pToNonReg;
        }
      } else {
        pTfsaRoom -= partner.tfsaContrib; // pre-retirement contributions use room
        pRrsp = pRrsp * (1 + inputs.preGrowth) + partner.rrspContrib;
        pTfsa = pTfsa * (1 + inputs.preGrowth) + partner.tfsaContrib;
        pNonReg = pNonReg * (1 + inputs.preGrowth) + partner.nonRegContrib;
        pNonRegCostBasis += partner.nonRegContrib;
        pSav = pSav + partner.savingsContrib;
      }
    }

    const yPortfolio = yRrsp + yTfsa + yNonReg + ySav;
    const pPortfolio = pRrsp + pTfsa + pNonReg + pSav;
    const totalPortfolio = yPortfolio + pPortfolio;

    // Tax per person — computed on full RRSP withdrawal (including top-up rebalance),
    // because the top-up IS real taxable income that the user pays tax on.
    const fedBpa = fedBrk.bpa * infFactor;
    const fedBrackets = fedBrk.brackets.map(([t, r]) => [t * infFactor, r]);
    const provBpa = provData.bpa * infFactor;
    const provBrackets = provData.brackets.map(([t, r]) => [t * infFactor, r]);

    function computeTax(rrspWd, cpp, oasGross, pension, bridge, other, nrTaxableGain, oasClawbackThreshold, age) {
      const taxableIncome = rrspWd + cpp + oasGross + pension + bridge + other + nrTaxableGain;
      const fedTax = calcProgressiveTax(taxableIncome, fedBpa, fedBrackets);
      const provTax = calcProgressiveTax(taxableIncome, provBpa, provBrackets);
      const fedLowestRate = fedBrackets[0][1];
      const provLowestRate = provBrackets[0][1];
      const pensionCredit = calcPensionIncomeCredit(age, rrspWd, pension, fedLowestRate, provLowestRate);
      const ageCredit = calcAgeCredit(age, taxableIncome, fedLowestRate, provLowestRate, infFactor);
      const totalTax = Math.max(0, fedTax + provTax - pensionCredit - ageCredit);
      const oasThreshNom = oasClawbackThreshold * infFactor;
      const oasClawback = Math.min(oasGross, Math.max(0, (taxableIncome - oasThreshNom) * 0.15));
      return { taxableIncome, totalTax, oasClawback };
    }

    const yTax = youRetired
      ? computeTax(yRrspWd, youFixed.cpp, youFixed.oasGross, youFixed.pension, youFixed.bridge, youFixed.other, yNrTaxableGain, you.oasClawbackThreshold, youAge)
      : youAlive && youFixed.employment > 0
        ? (() => { const ti = youFixed.employment; const ft = calcProgressiveTax(ti, fedBpa, fedBrackets); const pt = calcProgressiveTax(ti, provBpa, provBrackets); return { taxableIncome: ti, totalTax: ft + pt, oasClawback: 0 }; })()
        : { taxableIncome: 0, totalTax: 0, oasClawback: 0 };
    const pTax = partnerRetired
      ? computeTax(pRrspWd, partnerFixed.cpp, partnerFixed.oasGross, partnerFixed.pension, partnerFixed.bridge, partnerFixed.other, pNrTaxableGain, partner.oasClawbackThreshold, partnerAge)
      : partnerAlive && partnerFixed.employment > 0
        ? (() => { const ti = partnerFixed.employment; const ft = calcProgressiveTax(ti, fedBpa, fedBrackets); const pt = calcProgressiveTax(ti, provBpa, provBrackets); return { taxableIncome: ti, totalTax: ft + pt, oasClawback: 0 }; })()
        : { taxableIncome: 0, totalTax: 0, oasClawback: 0 };

    // ── Pension income splitting (age 65+): up to 50% of eligible income ──
    // Eligible: RRIF/RRSP withdrawals (at 65+) and pension income
    let finalYTax = yTax, finalPTax = pTax;
    if (youRetired && partnerRetired && youAlive && partnerAlive && (youAge >= 65 || partnerAge >= 65)) {
      const yEligible = (youAge >= 65 ? yRrspWd : 0) + youFixed.pension;
      const pEligible = (partnerAge >= 65 ? pRrspWd : 0) + partnerFixed.pension;

      // Try splitting from higher-income to lower-income spouse
      if (yEligible > 0 || pEligible > 0) {
        const baseCost = yTax.totalTax + yTax.oasClawback + pTax.totalTax + pTax.oasClawback;
        let bestCost = baseCost;

        // Try splitting from "you" to partner
        const maxYSplit = yEligible * 0.5;
        for (let split = 1000; split <= maxYSplit; split += 1000) {
          const adjYTax = computeTax(yRrspWd - Math.min(split, youAge >= 65 ? yRrspWd : 0), youFixed.cpp, youFixed.oasGross,
            youFixed.pension - Math.max(0, split - (youAge >= 65 ? yRrspWd : 0)), youFixed.bridge, youFixed.other, yNrTaxableGain, you.oasClawbackThreshold, youAge);
          const adjPTax = computeTax(pRrspWd + Math.min(split, youAge >= 65 ? yRrspWd : 0), partnerFixed.cpp, partnerFixed.oasGross,
            partnerFixed.pension + Math.max(0, split - (youAge >= 65 ? yRrspWd : 0)), partnerFixed.bridge, partnerFixed.other, pNrTaxableGain, partner.oasClawbackThreshold, partnerAge);
          const cost = adjYTax.totalTax + adjYTax.oasClawback + adjPTax.totalTax + adjPTax.oasClawback;
          if (cost < bestCost) {
            bestCost = cost;
            finalYTax = adjYTax;
            finalPTax = adjPTax;
          }
        }

        // Try splitting from partner to "you"
        const maxPSplit = pEligible * 0.5;
        for (let split = 1000; split <= maxPSplit; split += 1000) {
          const adjPTax = computeTax(pRrspWd - Math.min(split, partnerAge >= 65 ? pRrspWd : 0), partnerFixed.cpp, partnerFixed.oasGross,
            partnerFixed.pension - Math.max(0, split - (partnerAge >= 65 ? pRrspWd : 0)), partnerFixed.bridge, partnerFixed.other, pNrTaxableGain, partner.oasClawbackThreshold, partnerAge);
          const adjYTax = computeTax(yRrspWd + Math.min(split, partnerAge >= 65 ? pRrspWd : 0), youFixed.cpp, youFixed.oasGross,
            youFixed.pension + Math.max(0, split - (partnerAge >= 65 ? pRrspWd : 0)), youFixed.bridge, youFixed.other, yNrTaxableGain, you.oasClawbackThreshold, youAge);
          const cost = adjYTax.totalTax + adjYTax.oasClawback + adjPTax.totalTax + adjPTax.oasClawback;
          if (cost < bestCost) {
            bestCost = cost;
            finalYTax = adjYTax;
            finalPTax = adjPTax;
          }
        }
      }
    }

    const totalTax = finalYTax.totalTax + finalPTax.totalTax;
    const totalClawback = finalYTax.oasClawback + finalPTax.oasClawback;

    // Net income: total withdrawals + fixed income - tax - clawback - RRSP top-up transfer
    // (transfer went to TFSA/non-reg and is not spendable cash)
    const yTotalWd = ySavWd + yNrWd + yRrspWd + yTfsaWd;
    const pTotalWd = pSavWd + pNrWd + pRrspWd + pTfsaWd;
    const netIncome = yTotalWd + pTotalWd + combinedFixed - totalTax - totalClawback - totalTransfer;

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
      rrspToTfsaTransfer: totalTransfer,
      taxableIncome: yTax.taxableIncome + pTax.taxableIncome,
      totalTax, oasClawback: totalClawback, netIncome,
      desiredNominal, grossNominal,
      realPortfolio: totalPortfolio / infFactor,
      contribution: (!youRetired || !partnerRetired) ? (youAlive && !youRetired ? you.rrspContrib + you.tfsaContrib + you.nonRegContrib + you.savingsContrib : 0) + (partnerAlive && !partnerRetired ? partner.rrspContrib + partner.tfsaContrib + partner.nonRegContrib + partner.savingsContrib : 0) : 0,
      you: {
        rrsp: yRrsp, tfsa: yTfsa, nonReg: yNonReg, savings: ySav, totalPortfolio: yPortfolio,
        cpp: youFixed.cpp, oasGross: youFixed.oasGross, pension: youFixed.pension, bridge: youFixed.bridge, other: youFixed.other,
        employment: youFixed.employment,
        savWd: ySavWd, nrWd: yNrWd, rrspWd: yRrspWd, tfsaWd: yTfsaWd, rrspToTfsaTransfer: yTransfer,
        ...finalYTax, netIncome: ySavWd + yNrWd + yRrspWd + yTfsaWd + youFixed.total - finalYTax.totalTax - finalYTax.oasClawback - yTransfer,
      },
      partner: {
        rrsp: pRrsp, tfsa: pTfsa, nonReg: pNonReg, savings: pSav, totalPortfolio: pPortfolio,
        cpp: partnerFixed.cpp, oasGross: partnerFixed.oasGross, pension: partnerFixed.pension, bridge: partnerFixed.bridge, other: partnerFixed.other,
        employment: partnerFixed.employment,
        savWd: pSavWd, nrWd: pNrWd, rrspWd: pRrspWd, tfsaWd: pTfsaWd, rrspToTfsaTransfer: pTransfer,
        ...finalPTax, netIncome: pSavWd + pNrWd + pRrspWd + pTfsaWd + partnerFixed.total - finalPTax.totalTax - finalPTax.oasClawback - pTransfer,
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

  const retAge = Math.min(you.retirementAge, partner.retirementAge);
  const retRow = rows.find(r => r.youAge >= you.retirementAge || r.partnerAge >= partner.retirementAge);
  const portfolioAtRet = retRow ? retRow.totalPortfolio : 0;

  return {
    rows, hasSurplus, estateValue, portfolioAtRet,
    youResults: youSolo,
    partnerResults: partnerSolo,
    optCpp: youOptCpp, optOas: youOptOas,
    cppOptions: youSolo.cppOptions, oasOptions: youSolo.oasOptions,
    activeYears: Math.max(0, Math.min(70, you.lifeExpectancy) - retAge),
    slowdownYears: Math.max(0, Math.min(85, you.lifeExpectancy) - Math.max(70, retAge)),
    inactiveYears: Math.max(0, you.lifeExpectancy - Math.max(85, retAge)),
  };
}
