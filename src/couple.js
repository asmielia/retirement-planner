import { PROVINCES, calcProgressiveTax, getCombinedMarginalRate, estimateTerminalTaxRate } from "./tax.js";
import { runProjection, getSmoothedIncome, getPhaseLabel } from "./projection.js";

// ═══════════════════════════════════════════════
// COUPLE PROJECTION ENGINE
// ═══════════════════════════════════════════════
export function buildPersonInputs(inputs, who) {
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
      const oasGross = pAge >= optOas.age ? optOas.annual * infFactor : 0;
      const pension = pRetired ? p.pensionIncome : 0;
      const bridge = (pRetired && pAge < 65) ? p.pensionBridge : 0;
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

      // If still short (spend_down can exceed OAS cap), pull more RRSP
      if (rem > 0 && strategy === "spend_down") {
        const extraRrsp = Math.min(rrspAvail - rrspWd, rem);
        rrspWd += extraRrsp;
        rem -= extraRrsp;
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
      const youCanWithdraw = youAlive && youRetired;
      const partnerCanWithdraw = partnerAlive && partnerRetired;

      if (youCanWithdraw && partnerCanWithdraw) {
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
      } else {
        yTfsaRoom -= you.tfsaContrib; // pre-retirement contributions use room
        yRrsp = yRrsp * (1 + inputs.preGrowth) + you.rrspContrib;
        yTfsa = yTfsa * (1 + inputs.preGrowth) + you.tfsaContrib;
        yNonReg = yNonReg * (1 + inputs.preGrowth) + you.nonRegContrib;
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
      } else {
        pTfsaRoom -= partner.tfsaContrib; // pre-retirement contributions use room
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

    // Track RRSP→TFSA rebalance per partner (not spendable income)
    const yTransfer = youRetired ? Math.max(0, (ySavWd + yNrWd + yRrspWd + yTfsaWd) - (combinedTotal > 0 ? (yTotal / combinedTotal) * portfolioNeed : 0)) : 0;
    const pTransfer = partnerRetired ? Math.max(0, (pSavWd + pNrWd + pRrspWd + pTfsaWd) - (combinedTotal > 0 ? (pTotal / combinedTotal) * portfolioNeed : 0)) : 0;
    const totalTransfer = yTransfer + pTransfer;

    const combinedWd = ySavWd + yNrWd + yRrspWd + yTfsaWd + pSavWd + pNrWd + pRrspWd + pTfsaWd;
    const netIncome = combinedWd + combinedFixed - totalTax - totalClawback - totalTransfer;

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
      desiredNominal,
      realPortfolio: totalPortfolio / infFactor,
      contribution: (!youRetired || !partnerRetired) ? (youAlive && !youRetired ? you.rrspContrib + you.tfsaContrib + you.nonRegContrib + you.savingsContrib : 0) + (partnerAlive && !partnerRetired ? partner.rrspContrib + partner.tfsaContrib + partner.nonRegContrib + partner.savingsContrib : 0) : 0,
      you: {
        rrsp: yRrsp, tfsa: yTfsa, nonReg: yNonReg, savings: ySav, totalPortfolio: yPortfolio,
        cpp: youFixed.cpp, oasGross: youFixed.oasGross, pension: youFixed.pension, bridge: youFixed.bridge, other: youFixed.other,
        employment: youFixed.employment,
        savWd: ySavWd, nrWd: yNrWd, rrspWd: yRrspWd, tfsaWd: yTfsaWd, rrspToTfsaTransfer: yTransfer,
        ...yTax, netIncome: ySavWd + yNrWd + yRrspWd + yTfsaWd + youFixed.total - yTax.totalTax - yTax.oasClawback - yTransfer,
      },
      partner: {
        rrsp: pRrsp, tfsa: pTfsa, nonReg: pNonReg, savings: pSav, totalPortfolio: pPortfolio,
        cpp: partnerFixed.cpp, oasGross: partnerFixed.oasGross, pension: partnerFixed.pension, bridge: partnerFixed.bridge, other: partnerFixed.other,
        employment: partnerFixed.employment,
        savWd: pSavWd, nrWd: pNrWd, rrspWd: pRrspWd, tfsaWd: pTfsaWd, rrspToTfsaTransfer: pTransfer,
        ...pTax, netIncome: pSavWd + pNrWd + pRrspWd + pTfsaWd + partnerFixed.total - pTax.totalTax - pTax.oasClawback - pTransfer,
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
