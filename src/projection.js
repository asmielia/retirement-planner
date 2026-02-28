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
// CORE PROJECTION ENGINE
// ═══════════════════════════════════════════════
export function runProjection(inputs) {
  const { currentAge, retirementAge, lifeExpectancy, province,
    rrspBal, tfsaBal, nonRegBal, savingsBal,
    rrspContrib, tfsaContrib, nonRegContrib, savingsContrib,
    activeIncome, slowdownIncome, inactiveIncome,
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

    // Desired income (nominal)
    let desiredBase = 0;
    if (isRetired) {
      desiredBase = age < 70 ? activeIncome : age < 85 ? slowdownIncome : inactiveIncome;
    }
    const desiredNominal = desiredBase * infFactor;

    // Portfolio need from savings
    const portfolioNeed = Math.max(0, desiredNominal - cpp - oasGross);

    // Available balances (with growth applied)
    const rrspAvail = rrsp * (1 + growthRate);
    const tfsaAvail = tfsa * (1 + growthRate);
    const nonRegAvail = nonReg * (1 + growthRate);
    const savAvail = savings; // no growth on cash

    // OAS clawback threshold (nominal)
    const oasThreshNom = oasClawbackThreshold * infFactor;
    const rrspCap = Math.max(0, oasThreshNom - cpp - oasGross);

    let savWd = 0, nrWd = 0, rrspWd = 0, tfsaWd = 0;
    if (isRetired) {
      // 1. Savings first
      savWd = Math.min(savAvail, portfolioNeed);
      let rem = portfolioNeed - savWd;
      // 2. Non-Reg
      nrWd = Math.min(nonRegAvail, rem);
      rem -= nrWd;
      // 3. RRSP (capped for OAS)
      rrspWd = Math.min(rrspAvail, rem, rrspCap);
      rem -= rrspWd;
      // 4. TFSA
      tfsaWd = Math.min(tfsaAvail, rem);
    }

    // Update balances
    if (isRetired) {
      rrsp = Math.max(0, rrspAvail - rrspWd);
      tfsa = Math.max(0, tfsaAvail - tfsaWd);
      nonReg = Math.max(0, nonRegAvail - nrWd);
      savings = Math.max(0, savAvail - savWd);
    } else {
      rrsp = rrsp * (1 + preGrowth) + rrspContrib;
      tfsa = tfsa * (1 + preGrowth) + tfsaContrib;
      nonReg = nonReg * (1 + preGrowth) + nonRegContrib;
      savings = savings + savingsContrib;
    }

    const totalPortfolio = rrsp + tfsa + nonReg + savings;

    // Taxable income: RRSP withdrawal + CPP + OAS + NonReg growth (50% inclusion)
    const nrGrowthTaxable = isRetired ? (nonReg > 0 ? (nonRegAvail - (nonReg + nrWd)) * 0 + nonRegAvail * postGrowth * 0.5 : 0) : 0;
    const taxableIncome = isRetired ? rrspWd + cpp + oasGross + Math.max(0, nonRegAvail * postGrowth * 0.5) : 0;

    // Tax calculation
    const fedBpa = fedBrackets.bpa * infFactor;
    const fedBrk = fedBrackets.brackets.map(([t, r]) => [t * infFactor, r]);
    const provBpa = provData.bpa * infFactor;
    const provBrk = provData.brackets.map(([t, r]) => [t * infFactor, r]);

    const fedTax = isRetired ? calcProgressiveTax(taxableIncome, fedBpa, fedBrk) : 0;
    const provTax = isRetired ? calcProgressiveTax(taxableIncome, provBpa, provBrk) : 0;
    const totalTax = fedTax + provTax;

    // OAS clawback
    const oasClawback = isRetired ? Math.min(oasGross, Math.max(0, (taxableIncome - oasThreshNom) * 0.15)) : 0;

    // Net income
    const netIncome = isRetired ? savWd + nrWd + rrspWd + tfsaWd + cpp + oasGross - totalTax - oasClawback : 0;

    rows.push({
      year, age, phase, rrsp, tfsa, nonReg, savings,
      cpp, oasGross, totalPortfolio,
      contribution: isRetired ? 0 : rrspContrib + tfsaContrib + nonRegContrib + savingsContrib,
      desiredNominal, savWd, nrWd, rrspWd, tfsaWd,
      taxableIncome, totalTax, oasClawback, netIncome,
      realPortfolio: totalPortfolio / infFactor,
    });
  }

  // Plan status
  const retRow = rows.find(r => r.age === retirementAge);
  const portfolioAtRet = retRow ? retRow.totalPortfolio : 0;

  let pvDraws = 0;
  for (const r of rows) {
    if (r.age >= retirementAge && r.age <= lifeExpectancy) {
      const totalDraw = r.savWd + r.nrWd + r.rrspWd + r.tfsaWd;
      const yearsFromRet = r.age - retirementAge;
      pvDraws += totalDraw / Math.pow(1 + postGrowth, yearsFromRet);
    }
  }
  const fundingRatio = pvDraws > 0 ? portfolioAtRet / pvDraws : 999;

  return {
    rows, cppOptions, oasOptions, optCpp, optOas,
    portfolioAtRet, pvDraws, fundingRatio,
    activeYears: Math.max(0, Math.min(70, lifeExpectancy) - retirementAge),
    slowdownYears: Math.max(0, Math.min(85, lifeExpectancy) - Math.max(70, retirementAge)),
    inactiveYears: Math.max(0, lifeExpectancy - Math.max(85, retirementAge)),
  };
}

export const DEFAULTS = {
  currentAge: 35, retirementAge: 65, lifeExpectancy: 90, province: "Ontario",
  rrspBal: 50000, tfsaBal: 40000, nonRegBal: 20000, savingsBal: 15000,
  rrspContrib: 10000, tfsaContrib: 7000, nonRegContrib: 5000, savingsContrib: 3000,
  activeIncome: 70000, slowdownIncome: 55000, inactiveIncome: 40000,
  preGrowth: 0.06, postGrowth: 0.04, inflation: 0.02,
  cppAt65: 17196, oasAt65: 8908, oasClawbackThreshold: 95323,
  fedBrackets: FED_BRACKETS_DEFAULT,
};
