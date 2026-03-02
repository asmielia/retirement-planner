// ═══════════════════════════════════════════════
// PROVINCE TAX DATA
// ═══════════════════════════════════════════════
export const PROVINCES = {
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

export const FED_BRACKETS_DEFAULT = { bpa:16429, brackets:[[58523,.14],[117045,.205],[181440,.26],[258482,.29],[Infinity,.33]] };

export function calcProgressiveTax(income, bpa, brackets) {
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
export function getMarginalRate(income, bpa, brackets) {
  const taxable = Math.max(0, income - bpa);
  for (const [threshold, rate] of brackets) {
    if (taxable <= threshold - bpa) return rate;
  }
  return brackets[brackets.length - 1][1];
}

export function getCombinedMarginalRate(income, fedBpa, fedBrackets, provBpa, provBrackets) {
  return getMarginalRate(income, fedBpa, fedBrackets) + getMarginalRate(income, provBpa, provBrackets);
}

export function calcTotalTaxAndClawback(
  rrspWd, cpp, oasGross, pension, bridge, other, nrTaxableGain,
  fedBpa, fedBrk, provBpa, provBrk, oasThreshNom
) {
  const taxableIncome = rrspWd + cpp + oasGross + pension + bridge + other + nrTaxableGain;
  const fedTax = calcProgressiveTax(taxableIncome, fedBpa, fedBrk);
  const provTax = calcProgressiveTax(taxableIncome, provBpa, provBrk);
  const totalTax = fedTax + provTax;
  const oasClawback = Math.min(oasGross, Math.max(0, (taxableIncome - oasThreshNom) * 0.15));
  return { taxableIncome, totalTax, oasClawback };
}

export function estimateTerminalTaxRate(rrspBal, provData, fedBrackets, infFactor) {
  // At death the full RRSP balance is deemed taxable income
  const fedBpa = fedBrackets.bpa * infFactor;
  const fedBrk = fedBrackets.brackets.map(([t, r]) => [t * infFactor, r]);
  const provBpa = provData.bpa * infFactor;
  const provBrk = provData.brackets.map(([t, r]) => [t * infFactor, r]);
  return getCombinedMarginalRate(rrspBal, fedBpa, fedBrk, provBpa, provBrk);
}
