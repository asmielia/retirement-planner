import { runCoupleProjection } from "./couple.js";

// ═══════════════════════════════════════════════
// COUPLE SURPLUS FUNCTIONS
// ═══════════════════════════════════════════════
export function findCoupleFundingRatio(inputs) {
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

export function runCoupleBoostSpending(inputs) {
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

export function runCoupleMaxEstate(inputs) {
  const result = runCoupleProjection(inputs, "max_estate");
  return { ...result, surplusMode: "max_estate", hasSurplus: true };
}

export function runCoupleRetireEarly(inputs) {
  const youYearsToRetire = inputs.retirementAge - inputs.currentAge;
  const partnerYearsToRetire = inputs.partner.retirementAge - inputs.partner.currentAge;
  let youRetAge = inputs.retirementAge;
  let partnerRetAge = inputs.partner.retirementAge;

  function isFunded(yAge, pAge) {
    // Pass originalRetirementAge so pension/bridge only start at originally planned age
    const test = {
      ...inputs, retirementAge: yAge, originalRetirementAge: inputs.retirementAge,
      partner: { ...inputs.partner, retirementAge: pAge, originalRetirementAge: inputs.partner.retirementAge },
    };
    const r = runCoupleProjection(test);
    return (r.rows[r.rows.length - 1]?.totalPortfolio ?? 0) > 0;
  }

  // Phase 1: Align retirement years by reducing the later-retiring partner
  if (youYearsToRetire > partnerYearsToRetire) {
    const alignedAge = inputs.currentAge + partnerYearsToRetire;
    let lo = Math.max(inputs.currentAge + 1, alignedAge);
    let hi = youRetAge;
    for (let i = 0; i < 20; i++) {
      const mid = Math.round((lo + hi) / 2);
      if (mid === hi) break;
      if (isFunded(mid, partnerRetAge)) hi = mid; else lo = mid + 1;
    }
    youRetAge = hi;
  } else if (partnerYearsToRetire > youYearsToRetire) {
    const alignedAge = inputs.partner.currentAge + youYearsToRetire;
    let lo = Math.max(inputs.partner.currentAge + 1, alignedAge);
    let hi = partnerRetAge;
    for (let i = 0; i < 20; i++) {
      const mid = Math.round((lo + hi) / 2);
      if (mid === hi) break;
      if (isFunded(youRetAge, mid)) hi = mid; else lo = mid + 1;
    }
    partnerRetAge = hi;
  }

  // Phase 2: Reduce both retirement ages together
  const maxReduction = Math.min(youRetAge - (inputs.currentAge + 1), partnerRetAge - (inputs.partner.currentAge + 1));
  if (maxReduction > 0) {
    let lo = 0, hi = maxReduction;
    for (let i = 0; i < 20; i++) {
      const mid = Math.ceil((lo + hi) / 2);
      if (mid === lo) break;
      if (isFunded(youRetAge - mid, partnerRetAge - mid)) lo = mid; else hi = mid - 1;
    }
    youRetAge -= lo;
    partnerRetAge -= lo;
  }

  const earlyInputs = {
    ...inputs, retirementAge: youRetAge, originalRetirementAge: inputs.retirementAge,
    partner: { ...inputs.partner, retirementAge: partnerRetAge, originalRetirementAge: inputs.partner.retirementAge },
  };
  const finalResult = runCoupleProjection(earlyInputs);
  return {
    ...finalResult,
    surplusMode: "retire_early",
    hasSurplus: true,
    earlyYouRetirementAge: youRetAge,
    earlyPartnerRetirementAge: partnerRetAge,
    originalYouRetirementAge: inputs.retirementAge,
    originalPartnerRetirementAge: inputs.partner.retirementAge,
    youYearsSaved: inputs.retirementAge - youRetAge,
    partnerYearsSaved: inputs.partner.retirementAge - partnerRetAge,
  };
}
