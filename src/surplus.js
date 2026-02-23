import { runProjection } from "./projection.js";

// ═══════════════════════════════════════════════
// SURPLUS MODE FUNCTIONS (SINGLE)
// ═══════════════════════════════════════════════
export function runBoostSpending(inputs) {
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

    if (endBal > 1000) {
      lo = mid;
      bestResult = result;
    } else {
      hi = mid;
    }
  }

  const multiplier = (lo + hi) / 2;
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

export function runMaxEstate(inputs) {
  const result = runProjection(inputs, "max_estate");
  return {
    ...result,
    surplusMode: "max_estate",
    hasSurplus: true,
  };
}

export function runRetireEarly(inputs) {
  let lo = inputs.currentAge + 1;
  let hi = inputs.retirementAge;
  for (let i = 0; i < 20; i++) {
    const mid = Math.round((lo + hi) / 2);
    if (mid === hi) break;
    // Pass originalRetirementAge so pension/bridge only start at the originally planned age
    const result = runProjection({ ...inputs, retirementAge: mid, originalRetirementAge: inputs.retirementAge });
    const endBal = result.rows[result.rows.length - 1]?.totalPortfolio ?? 0;
    if (endBal > 0) hi = mid; else lo = mid + 1;
  }
  const finalResult = runProjection({ ...inputs, retirementAge: hi, originalRetirementAge: inputs.retirementAge });
  return {
    ...finalResult,
    surplusMode: "retire_early",
    hasSurplus: true,
    earlyRetirementAge: hi,
    originalRetirementAge: inputs.retirementAge,
    yearsSaved: inputs.retirementAge - hi,
  };
}

// Find the max spending multiplier — this IS the funding ratio
// 1.0 = exactly funded, 1.3 = can spend 30% more, 0.7 = can only afford 70%
export function findFundingRatio(inputs) {
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
