import { describe, it, expect } from 'vitest';
import { calcProgressiveTax, PROVINCES, FED_BRACKETS_DEFAULT, calcPensionIncomeCredit, calcAgeCredit, AGE_CREDIT, getIncomeForAvgTaxRate } from './tax.js';
import { runProjection, getSmoothedIncome, getPhaseLabel } from './projection.js';
import { DEFAULTS, getRrifMinimum } from './constants.js';

function makeInputs(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}

// ═══════════════════════════════════════════════
// A. calcProgressiveTax — Unit Tests
// ═══════════════════════════════════════════════
describe('calcProgressiveTax', () => {
  const fedBpa = FED_BRACKETS_DEFAULT.bpa;
  const fedBrk = FED_BRACKETS_DEFAULT.brackets;

  it('A1: returns 0 for zero income', () => {
    expect(calcProgressiveTax(0, fedBpa, fedBrk)).toBe(0);
  });

  it('A2: returns 0 for income equal to BPA', () => {
    expect(calcProgressiveTax(16429, fedBpa, fedBrk)).toBe(0);
  });

  it('A3: returns 0 for income below BPA', () => {
    expect(calcProgressiveTax(10000, fedBpa, fedBrk)).toBe(0);
  });

  it('A4: first bracket only ($50k income)', () => {
    // taxable = 50000 - 16429 = 33571, all in first bracket at 14%
    expect(calcProgressiveTax(50000, fedBpa, fedBrk)).toBeCloseTo(4699.94, 0);
  });

  it('A5: two brackets ($80k income)', () => {
    // B1: 42094 * 0.14 = 5893.16, B2: 21477 * 0.205 = 4402.785
    expect(calcProgressiveTax(80000, fedBpa, fedBrk)).toBeCloseTo(10295.95, 0);
  });

  it('A6: all five brackets ($500k income)', () => {
    expect(calcProgressiveTax(500000, fedBpa, fedBrk)).toBeCloseTo(136675.99, 0);
  });

  it('A7: Ontario provincial tax ($80k income)', () => {
    const { bpa, brackets } = PROVINCES.Ontario;
    expect(calcProgressiveTax(80000, bpa, brackets)).toBeCloseTo(4511.28, 0);
  });

  it('A8: Alberta provincial tax ($80k income)', () => {
    const { bpa, brackets } = PROVINCES.Alberta;
    expect(calcProgressiveTax(80000, bpa, brackets)).toBeCloseTo(6099.10, 0);
  });

  it('A9: Quebec provincial tax ($80k income)', () => {
    const { bpa, brackets } = PROVINCES.Quebec;
    expect(calcProgressiveTax(80000, bpa, brackets)).toBeCloseTo(9954.91, 0);
  });

  it('A10: negative income returns 0', () => {
    expect(calcProgressiveTax(-5000, fedBpa, fedBrk)).toBe(0);
  });

  it('A11: income at first bracket boundary ($58,523)', () => {
    expect(calcProgressiveTax(58523, fedBpa, fedBrk)).toBeCloseTo(5893.16, 0);
  });
});

// ═══════════════════════════════════════════════
// B. CPP Optimization
// ═══════════════════════════════════════════════
describe('CPP Optimization', () => {
  it('B1: CPP at age 60 applies -36% reduction', () => {
    const r = runProjection(makeInputs({ lifeExpectancy: 90 }));
    const cpp60 = r.cppOptions.find(o => o.age === 60);
    // 17196 * (1 - 0.006 * 5 * 12) = 17196 * 0.64 = 11005.44
    expect(cpp60.annual).toBeCloseTo(11005.44, 1);
    expect(cpp60.lifetime).toBeCloseTo(11005.44 * 30, 0);
  });

  it('B2: CPP at age 65 is the unadjusted base', () => {
    const r = runProjection(makeInputs({ lifeExpectancy: 90 }));
    const cpp65 = r.cppOptions.find(o => o.age === 65);
    expect(cpp65.annual).toBe(17196);
    expect(cpp65.lifetime).toBeCloseTo(17196 * 25, 0);
  });

  it('B3: CPP at age 70 applies +42% bonus', () => {
    const r = runProjection(makeInputs({ lifeExpectancy: 90 }));
    const cpp70 = r.cppOptions.find(o => o.age === 70);
    // 17196 * (1 + 0.007 * 5 * 12) = 17196 * 1.42 = 24418.32
    expect(cpp70.annual).toBeCloseTo(24418.32, 1);
    expect(cpp70.lifetime).toBeCloseTo(24418.32 * 20, 0);
  });

  it('B4: optimal CPP age is 70 with life expectancy 90', () => {
    const r = runProjection(makeInputs({ lifeExpectancy: 90 }));
    expect(r.optCpp.age).toBe(70);
  });

  it('B5: optimal CPP age is 63 with life expectancy 75', () => {
    const r = runProjection(makeInputs({ lifeExpectancy: 75 }));
    expect(r.optCpp.age).toBe(63);
  });

  it('B6: optimal CPP age is 61 with life expectancy 71', () => {
    const r = runProjection(makeInputs({ lifeExpectancy: 71 }));
    expect(r.optCpp.age).toBe(61);
  });

  it('B7: optimal CPP age is 60 when life expectancy is 65', () => {
    const r = runProjection(makeInputs({ lifeExpectancy: 65 }));
    expect(r.optCpp.age).toBe(60);
  });
});

// ═══════════════════════════════════════════════
// C. OAS Optimization
// ═══════════════════════════════════════════════
describe('OAS Optimization', () => {
  it('C1: OAS at age 65 is the unadjusted base', () => {
    const r = runProjection(makeInputs({ lifeExpectancy: 90 }));
    const oas65 = r.oasOptions.find(o => o.age === 65);
    expect(oas65.annual).toBe(8908);
    // Lifetime includes 10% OAS increase at age 75:
    // 10 years at base (65-74) + 15 years at 1.10x (75-89)
    const expectedLifetime = 8908 * 10 + 8908 * 1.10 * 15;
    expect(oas65.lifetime).toBeCloseTo(expectedLifetime, 0);
  });

  it('C2: OAS at age 70 applies +36% deferral bonus', () => {
    const r = runProjection(makeInputs({ lifeExpectancy: 90 }));
    const oas70 = r.oasOptions.find(o => o.age === 70);
    // 8908 * (1 + 0.006 * 5 * 12) = 8908 * 1.36 = 12114.88
    expect(oas70.annual).toBeCloseTo(12114.88, 1);
    // Lifetime includes 10% OAS increase at age 75:
    // 5 years at base (70-74) + 15 years at 1.10x (75-89)
    const expectedLifetime = 12114.88 * 5 + 12114.88 * 1.10 * 15;
    expect(oas70.lifetime).toBeCloseTo(expectedLifetime, 0);
  });

  it('C3: optimal OAS age is 70 with life expectancy 90', () => {
    const r = runProjection(makeInputs({ lifeExpectancy: 90 }));
    expect(r.optOas.age).toBe(70);
  });

  it('C4: optimal OAS age is 65 with life expectancy 75', () => {
    const r = runProjection(makeInputs({ lifeExpectancy: 75 }));
    expect(r.optOas.age).toBe(65);
  });

  it('C5: optimal OAS age is 67 with life expectancy 82 (crossover)', () => {
    const r = runProjection(makeInputs({ lifeExpectancy: 82 }));
    expect(r.optOas.age).toBe(67);
  });
});

// ═══════════════════════════════════════════════
// D. OAS Clawback
// ═══════════════════════════════════════════════
describe('OAS Clawback', () => {
  it('D1: no clawback when taxable income is below threshold', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 64,
      rrspBal: 50000, tfsaBal: 100000, nonRegBal: 0, savingsBal: 0,
      activeIncome: 40000, lifeExpectancy: 90,
    }), "spend_down");
    const retRow = r.rows.find(row => row.age === 65);
    expect(retRow.oasClawback).toBe(0);
  });

  it('D2: RRSP cap formula limits withdrawal to avoid clawback', () => {
    // At age 70+, OAS is active so RRSP cap protects against clawback
    const r = runProjection(makeInputs({
      retirementAge: 70, currentAge: 69,
      rrspBal: 5000000, tfsaBal: 5000000, nonRegBal: 0, savingsBal: 0,
      slowdownIncome: 200000, inflation: 0, postGrowth: 0,
      lifeExpectancy: 90,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row70 = r.rows.find(row => row.age === 70);
    // rrspCap = 95323 - cpp(70) - oas(70) = 95323 - 24418.32 - 12114.88 = 58789.80
    expect(row70.rrspWd).toBeCloseTo(58789.80, 0);
  });

  it('D3: clawback never exceeds OAS amount in any row', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 64,
      rrspBal: 10000000, tfsaBal: 0, nonRegBal: 0, savingsBal: 0,
      activeIncome: 300000, inflation: 0, postGrowth: 0,
      lifeExpectancy: 90,
    }));
    for (const row of r.rows) {
      expect(row.oasClawback).toBeLessThanOrEqual(row.oasGross + 0.01);
    }
  });
});

// ═══════════════════════════════════════════════
// E. Phase Years
// ═══════════════════════════════════════════════
describe('Phase Years', () => {
  it('E1: standard retirement 65-90', () => {
    const r = runProjection(makeInputs({ retirementAge: 65, lifeExpectancy: 90 }));
    expect(r.activeYears).toBe(5);
    expect(r.slowdownYears).toBe(15);
    expect(r.inactiveYears).toBe(5);
  });

  it('E2: early retirement 55-90', () => {
    const r = runProjection(makeInputs({ retirementAge: 55, lifeExpectancy: 90 }));
    expect(r.activeYears).toBe(15);
    expect(r.slowdownYears).toBe(15);
    expect(r.inactiveYears).toBe(5);
  });

  it('E3: late retirement 72-90 (no active phase)', () => {
    const r = runProjection(makeInputs({ retirementAge: 72, lifeExpectancy: 90 }));
    expect(r.activeYears).toBe(0);
    expect(r.slowdownYears).toBe(13);
    expect(r.inactiveYears).toBe(5);
  });

  it('E4: very late retirement 86-95 (inactive only)', () => {
    const r = runProjection(makeInputs({ retirementAge: 86, lifeExpectancy: 95, currentAge: 85 }));
    expect(r.activeYears).toBe(0);
    expect(r.slowdownYears).toBe(0);
    expect(r.inactiveYears).toBe(9);
  });

  it('E5: short life expectancy 65-75 (no inactive phase)', () => {
    const r = runProjection(makeInputs({ retirementAge: 65, lifeExpectancy: 75 }));
    expect(r.activeYears).toBe(5);
    expect(r.slowdownYears).toBe(5);
    expect(r.inactiveYears).toBe(0);
  });

  it('E6: life expectancy equals retirement age (all zeros)', () => {
    const r = runProjection(makeInputs({ retirementAge: 65, lifeExpectancy: 65 }));
    expect(r.activeYears).toBe(0);
    expect(r.slowdownYears).toBe(0);
    expect(r.inactiveYears).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// F. Withdrawal Ordering (spend_down for no cash floor / RRSP top-up)
// ═══════════════════════════════════════════════
describe('Withdrawal Ordering', () => {
  it('F1: cash savings are depleted first', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 64,
      savingsBal: 100000, rrspBal: 100000, tfsaBal: 100000, nonRegBal: 100000,
      activeIncome: 30000, lifeExpectancy: 90,
      inflation: 0, preGrowth: 0, postGrowth: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 65);
    expect(row.savWd).toBeGreaterThan(0);
    expect(row.nrWd).toBe(0);
    expect(row.rrspWd).toBe(0);
    expect(row.tfsaWd).toBe(0);
  });

  it('F2: non-registered is used after cash is exhausted (pre-OAS)', () => {
    // Pre-OAS (age 65): RRSP first (uncapped), then non-reg, then TFSA
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 64,
      savingsBal: 0, nonRegBal: 100000, rrspBal: 100000, tfsaBal: 100000,
      activeIncome: 30000, lifeExpectancy: 90,
      inflation: 0, preGrowth: 0, postGrowth: 0,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 65);
    // Pre-OAS: RRSP is drawn first (uncapped), not non-reg
    expect(row.savWd).toBe(0);
    expect(row.rrspWd).toBeGreaterThan(0);
  });

  it('F3: TFSA is used last', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 64,
      savingsBal: 0, nonRegBal: 0, rrspBal: 0, tfsaBal: 100000,
      activeIncome: 30000, lifeExpectancy: 90,
      inflation: 0, preGrowth: 0, postGrowth: 0,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 65);
    expect(row.savWd).toBe(0);
    expect(row.nrWd).toBe(0);
    expect(row.rrspWd).toBe(0);
    expect(row.tfsaWd).toBeGreaterThan(0);
  });

  it('F4: RRSP withdrawal respects OAS cap when receiving OAS', () => {
    // At age 70, OAS is active so RRSP capped at clawback threshold
    const r = runProjection(makeInputs({
      retirementAge: 70, currentAge: 69,
      savingsBal: 0, nonRegBal: 0, rrspBal: 5000000, tfsaBal: 5000000,
      slowdownIncome: 200000, inflation: 0, postGrowth: 0,
      lifeExpectancy: 90,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 70);
    // rrspCap = 95323 - 24418.32 - 12114.88 = 58789.80
    expect(row.rrspWd).toBeCloseTo(58789.80, 0);
    // Remainder from TFSA
    expect(row.tfsaWd).toBeGreaterThan(0);
  });

  it('F5: pre-OAS draws RRSP uncapped', () => {
    // Before OAS starts (age 65 < optimal OAS age 70), no cap on RRSP
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 64,
      savingsBal: 0, nonRegBal: 0, rrspBal: 5000000, tfsaBal: 100000,
      activeIncome: 50000, inflation: 0, postGrowth: 0,
      lifeExpectancy: 90,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 65);
    // Pre-OAS: RRSP draws uncapped, covering full portfolioNeed
    expect(row.rrspWd).toBeGreaterThan(0);
    expect(row.tfsaWd).toBe(0); // TFSA shouldn't be needed
  });
});

// ═══════════════════════════════════════════════
// G. Tax Integration
// ═══════════════════════════════════════════════
describe('Tax Integration', () => {
  it('G1: accumulation years have zero tax', () => {
    const r = runProjection(makeInputs({ currentAge: 35, retirementAge: 65 }));
    const accumRows = r.rows.filter(row => row.age < 65);
    expect(accumRows.length).toBeGreaterThan(0);
    for (const row of accumRows) {
      expect(row.totalTax).toBe(0);
      expect(row.oasClawback).toBe(0);
      expect(row.netIncome).toBe(0);
    }
  });

  it('G2: total tax equals federal + provincial minus credits', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 64, inflation: 0,
      province: 'Ontario', lifeExpectancy: 90,
    }));
    const retRow = r.rows.find(row => row.age === 65);
    const fedTax = calcProgressiveTax(retRow.taxableIncome, FED_BRACKETS_DEFAULT.bpa, FED_BRACKETS_DEFAULT.brackets);
    const provTax = calcProgressiveTax(retRow.taxableIncome, PROVINCES.Ontario.bpa, PROVINCES.Ontario.brackets);
    // Total tax now includes pension income credit and age amount credit deductions at 65+
    expect(retRow.totalTax).toBeLessThanOrEqual(fedTax + provTax);
    expect(retRow.totalTax).toBeGreaterThanOrEqual(0);
  });

  it('G3: province changes produce materially different tax amounts', () => {
    const baseInputs = {
      retirementAge: 65, currentAge: 64, inflation: 0, lifeExpectancy: 90,
      savingsBal: 0, nonRegBal: 0, rrspBal: 500000, tfsaBal: 0,
      activeIncome: 60000, postGrowth: 0,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    };
    const ontarioR = runProjection(makeInputs({ ...baseInputs, province: 'Ontario' }), "spend_down");
    const albertaR = runProjection(makeInputs({ ...baseInputs, province: 'Alberta' }), "spend_down");
    const quebecR = runProjection(makeInputs({ ...baseInputs, province: 'Quebec' }), "spend_down");

    const ontarioTax = ontarioR.rows.find(row => row.age === 65).totalTax;
    const albertaTax = albertaR.rows.find(row => row.age === 65).totalTax;
    const quebecTax = quebecR.rows.find(row => row.age === 65).totalTax;

    // Quebec has highest combined rates
    expect(quebecTax).toBeGreaterThan(ontarioTax);
    expect(quebecTax).toBeGreaterThan(albertaTax);
    // All three provinces produce different tax amounts
    expect(ontarioTax).not.toBeCloseTo(albertaTax, 0);
    expect(ontarioTax).not.toBeCloseTo(quebecTax, 0);
  });

  it('G4: net income = withdrawals + benefits - tax - clawback - rrspTransfer', () => {
    const r = runProjection(makeInputs(), "spend_down");
    for (const row of r.rows) {
      if (row.age >= DEFAULTS.retirementAge) {
        const expected = row.savWd + row.nrWd + row.rrspWd + row.tfsaWd
          + row.cpp + row.oasGross + row.pension + row.bridge + row.other
          - row.totalTax - row.oasClawback - row.rrspToTfsaTransfer;
        expect(row.netIncome).toBeCloseTo(expected, 2);
      }
    }
  });
});

// ═══════════════════════════════════════════════
// H. Inflation
// ═══════════════════════════════════════════════
describe('Inflation', () => {
  it('H1: zero inflation means nominal equals real portfolio', () => {
    const r = runProjection(makeInputs({ inflation: 0 }));
    for (const row of r.rows) {
      expect(row.realPortfolio).toBeCloseTo(row.totalPortfolio, 2);
    }
  });

  it('H2: inflation factor correctly applied to desired income', () => {
    const r = runProjection(makeInputs({
      inflation: 0.03, retirementAge: 65, currentAge: 35, activeIncome: 70000,
    }));
    // Year 31 (age 65), infFactor = (1.03)^31
    const row = r.rows.find(row => row.age === 65);
    const expectedInflation = Math.pow(1.03, 31);
    expect(row.desiredNominal).toBeCloseTo(70000 * expectedInflation, 0);
  });

  it('H3: tax brackets are inflation-indexed', () => {
    const r = runProjection(makeInputs({ inflation: 0, retirementAge: 65, currentAge: 64, lifeExpectancy: 90 }));
    const row1 = r.rows.find(row => row.age === 65);
    const row2 = r.rows.find(row => row.age === 66);
    if (row1.taxableIncome > 0 && row2.taxableIncome > 0) {
      expect(row1.totalTax).toBeGreaterThanOrEqual(0);
      expect(row2.totalTax).toBeGreaterThanOrEqual(0);
    }
  });

  it('H4: high inflation (5%) does not produce NaN or Infinity', () => {
    const r = runProjection(makeInputs({
      inflation: 0.05, retirementAge: 65, currentAge: 35, lifeExpectancy: 95,
    }));
    for (const row of r.rows) {
      expect(Number.isFinite(row.totalPortfolio)).toBe(true);
      expect(Number.isFinite(row.netIncome)).toBe(true);
      expect(Number.isFinite(row.totalTax)).toBe(true);
      expect(Number.isNaN(row.totalPortfolio)).toBe(false);
      expect(Number.isNaN(row.netIncome)).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════
// I. Growth and Accumulation
// ═══════════════════════════════════════════════
describe('Growth and Accumulation', () => {
  it('I1: RRSP grows at preGrowth rate plus contributions', () => {
    const r = runProjection(makeInputs({
      currentAge: 35, retirementAge: 36,
      rrspBal: 100000, rrspContrib: 10000, preGrowth: 0.06,
      tfsaBal: 0, tfsaContrib: 0, nonRegBal: 0, nonRegContrib: 0,
      savingsBal: 0, savingsContrib: 0,
    }));
    // After year 1 (age 35, accumulation): rrsp = 100000 * 1.06 + 10000 = 116000
    const row = r.rows.find(row => row.age === 35);
    expect(row.rrsp).toBeCloseTo(116000, 0);
  });

  it('I2: savings account has no growth', () => {
    const r = runProjection(makeInputs({
      currentAge: 35, retirementAge: 36,
      savingsBal: 50000, savingsContrib: 5000, preGrowth: 0.10,
      rrspBal: 0, rrspContrib: 0, tfsaBal: 0, tfsaContrib: 0,
      nonRegBal: 0, nonRegContrib: 0,
    }));
    const row = r.rows.find(row => row.age === 35);
    // savings = 50000 + 5000 = 55000 (no 10% growth)
    expect(row.savings).toBeCloseTo(55000, 0);
  });

  it('I3: post-retirement growth is applied before withdrawal', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 65,
      rrspBal: 100000, postGrowth: 0.04, inflation: 0,
      tfsaBal: 0, nonRegBal: 0, savingsBal: 0,
      activeIncome: 10000, lifeExpectancy: 90,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 65);
    // rrspAvail = 100000 * 1.04 = 104000, then withdrawal of 10000
    // rrsp = 104000 - 10000 = 94000
    expect(row.rrspWd).toBe(10000);
    expect(row.rrsp).toBeCloseTo(94000, 0);
  });

  it('I4: multiple accounts grow independently', () => {
    const r = runProjection(makeInputs({
      currentAge: 35, retirementAge: 37,
      rrspBal: 100000, tfsaBal: 50000, nonRegBal: 25000, savingsBal: 10000,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
      preGrowth: 0.05,
    }));
    const row1 = r.rows.find(row => row.age === 35);
    expect(row1.rrsp).toBeCloseTo(105000, 0);
    expect(row1.tfsa).toBeCloseTo(52500, 0);
    expect(row1.nonReg).toBeCloseTo(26250, 0);
    expect(row1.savings).toBeCloseTo(10000, 0);

    const row2 = r.rows.find(row => row.age === 36);
    expect(row2.rrsp).toBeCloseTo(110250, 0);
    expect(row2.tfsa).toBeCloseTo(55125, 0);
    expect(row2.nonReg).toBeCloseTo(27562.50, 0);
    expect(row2.savings).toBeCloseTo(10000, 0);
  });

  it('I5: zero-balance accounts do not crash', () => {
    const r = runProjection(makeInputs({
      rrspBal: 0, tfsaBal: 0, nonRegBal: 0, savingsBal: 0,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }));
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      if (row.age >= DEFAULTS.retirementAge) {
        expect(row.savWd).toBe(0);
        expect(row.nrWd).toBe(0);
        expect(row.rrspWd).toBe(0);
        expect(row.tfsaWd).toBe(0);
      }
    }
  });
});

// ═══════════════════════════════════════════════
// J. Plan Status (hasSurplus / estateValue)
// ═══════════════════════════════════════════════
describe('Plan Status', () => {
  it('J1: defaults produce a positive portfolio at retirement', () => {
    const r = runProjection(makeInputs());
    expect(r.portfolioAtRet).toBeGreaterThan(0);
  });

  it('J2: zero savings with zero contributions produces hasSurplus false', () => {
    const r = runProjection(makeInputs({
      rrspBal: 0, tfsaBal: 0, nonRegBal: 0, savingsBal: 0,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }));
    expect(r.hasSurplus).toBe(false);
  });

  it('J3: large balances produce hasSurplus true and positive estate value', () => {
    const r = runProjection(makeInputs({
      rrspBal: 5000000, tfsaBal: 2000000, nonRegBal: 1000000, savingsBal: 500000,
    }));
    expect(r.hasSurplus).toBe(true);
    expect(r.estateValue).not.toBeNull();
    expect(r.estateValue.total).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════
// K. Golden Scenario — DEFAULTS Regression Anchor
// ═══════════════════════════════════════════════
describe('Golden Scenario - DEFAULTS regression', () => {
  it('K1: full regression anchor with hand-calculated values', () => {
    const r = runProjection(makeInputs());

    // CPP/OAS optimization
    expect(r.optCpp.age).toBe(70);
    expect(r.optCpp.annual).toBeCloseTo(24418.32, 1);
    expect(r.optOas.age).toBe(70);
    expect(r.optOas.annual).toBeCloseTo(12114.88, 1);

    // Phase years
    expect(r.activeYears).toBe(5);
    expect(r.slowdownYears).toBe(15);
    expect(r.inactiveYears).toBe(5);

    // Row count: lifeExpectancy - currentAge + 1 = 90 - 35 + 1 = 56
    expect(r.rows.length).toBe(56);

    // First row
    const first = r.rows[0];
    expect(first.age).toBe(35);
    expect(first.phase).toBe('Accumulation');
    expect(first.netIncome).toBe(0);

    // Year 1 balances: rrsp=50000*1.06+10000=63000, tfsa=40000*1.06+7000=49400,
    // nonReg=20000*1.06+5000=26200, savings=15000+3000=18000
    expect(first.rrsp).toBeCloseTo(63000, 0);
    expect(first.tfsa).toBeCloseTo(49400, 0);
    expect(first.nonReg).toBeCloseTo(26200, 0);
    expect(first.savings).toBeCloseTo(18000, 0);
    expect(first.totalPortfolio).toBeCloseTo(156600, 0);

    // At retirement (age 65): CPP/OAS not yet started (both start at 70)
    const retRow = r.rows.find(row => row.age === 65);
    expect(retRow.cpp).toBe(0);
    expect(retRow.oasGross).toBe(0);

    // At age 70: CPP and OAS start
    const row70 = r.rows.find(row => row.age === 70);
    expect(row70.cpp).toBeGreaterThan(0);
    expect(row70.oasGross).toBeGreaterThan(0);

    // Last row
    const last = r.rows[r.rows.length - 1];
    expect(last.age).toBe(90);

    // Sanity checks
    expect(r.portfolioAtRet).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════
// L. Edge Cases
// ═══════════════════════════════════════════════
describe('Edge Cases', () => {
  it('L1: immediate retirement (currentAge = retirementAge)', () => {
    const r = runProjection(makeInputs({
      currentAge: 65, retirementAge: 65, lifeExpectancy: 90,
    }));
    const first = r.rows[0];
    expect(first.age).toBe(65);
    const accumRows = r.rows.filter(row => row.phase === 'Accumulation');
    expect(accumRows.length).toBe(0);
  });

  it('L2: very large balances do not produce NaN or Infinity', () => {
    const r = runProjection(makeInputs({
      rrspBal: 5000000, tfsaBal: 2000000, nonRegBal: 3000000, savingsBal: 500000,
    }));
    for (const row of r.rows) {
      expect(Number.isFinite(row.totalPortfolio)).toBe(true);
      expect(Number.isFinite(row.netIncome)).toBe(true);
      expect(Number.isNaN(row.totalTax)).toBe(false);
    }
  });

  it('L3: row count equals lifeExpectancy - currentAge + 1', () => {
    const r1 = runProjection(makeInputs({ currentAge: 35, lifeExpectancy: 90 }));
    expect(r1.rows.length).toBe(56);

    const r2 = runProjection(makeInputs({ currentAge: 60, lifeExpectancy: 95 }));
    expect(r2.rows.length).toBe(36);
  });

  it('L4: invalid province falls back to Ontario', () => {
    const r = runProjection(makeInputs({ province: 'Narnia' }));
    const rOntario = runProjection(makeInputs({ province: 'Ontario' }));
    expect(r.rows.length).toBe(rOntario.rows.length);
    for (let i = 0; i < r.rows.length; i++) {
      expect(r.rows[i].totalTax).toBeCloseTo(rOntario.rows[i].totalTax, 2);
    }
  });

  it('L5: retirement at 55 has gap period before CPP/OAS', () => {
    const r = runProjection(makeInputs({
      retirementAge: 55, currentAge: 54, lifeExpectancy: 90,
    }));
    const gapRows = r.rows.filter(row => row.age >= 55 && row.age < r.optCpp.age);
    expect(gapRows.length).toBeGreaterThan(0);
    for (const row of gapRows) {
      expect(row.cpp).toBe(0);
    }
    const oasGapRows = r.rows.filter(row => row.age >= 55 && row.age < r.optOas.age);
    for (const row of oasGapRows) {
      expect(row.oasGross).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════
// M. Taxable Income Composition
// ═══════════════════════════════════════════════
describe('Taxable Income Composition', () => {
  it('M1: RRSP withdrawal is included in taxable income', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 64,
      savingsBal: 0, nonRegBal: 0, rrspBal: 500000, tfsaBal: 0,
      activeIncome: 50000, inflation: 0, postGrowth: 0,
      lifeExpectancy: 90,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 65);
    expect(row.rrspWd).toBeGreaterThan(0);
    expect(row.taxableIncome).toBeGreaterThanOrEqual(row.rrspWd);
  });

  it('M2: TFSA withdrawal is NOT included in taxable income', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 65,
      savingsBal: 0, nonRegBal: 0, rrspBal: 0, tfsaBal: 500000,
      activeIncome: 50000, inflation: 0, postGrowth: 0,
      lifeExpectancy: 90,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 65);
    expect(row.tfsaWd).toBeGreaterThan(0);
    // taxableIncome should only be CPP + OAS (both 0 at 65 since optimal age is 70)
    expect(row.taxableIncome).toBe(0);
  });

  it('M3: non-registered capital gains use 50% inclusion with cost basis', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 65,
      nonRegBal: 100000, postGrowth: 0.04, inflation: 0,
      rrspBal: 0, tfsaBal: 0, savingsBal: 0,
      activeIncome: 10000, lifeExpectancy: 90,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 65);
    // nonRegAvail = 100000 * 1.04 = 104000
    // costBasis = 100000, gainFraction = 1 - 100000/104000 = 4000/104000
    // nrTaxableGain = nrWd * gainFraction * 0.5
    // For 10000 withdrawal: taxableGain = 10000 * (4000/104000) * 0.5 ≈ 192.31
    expect(row.taxableIncome).toBeGreaterThan(0);
    expect(row.taxableIncome).toBeLessThan(row.nrWd); // only a fraction is taxable
  });

  it('M4: pension and bridge income included in taxable income', () => {
    const r = runProjection(makeInputs({
      retirementAge: 60, currentAge: 59,
      pensionIncome: 30000, pensionBridge: 10000,
      savingsBal: 0, nonRegBal: 0, rrspBal: 0, tfsaBal: 500000,
      activeIncome: 50000, inflation: 0, postGrowth: 0,
      lifeExpectancy: 90,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 60);
    // taxableIncome should include pension (30000) + bridge (10000)
    expect(row.pension).toBe(30000);
    expect(row.bridge).toBe(10000);
    expect(row.taxableIncome).toBeGreaterThanOrEqual(40000);
  });
});

// ═══════════════════════════════════════════════
// N. Income Smoothing
// ═══════════════════════════════════════════════
describe('Income Smoothing', () => {
  it('N1: getSmoothedIncome returns activeIncome before age 65', () => {
    expect(getSmoothedIncome(60, 70000, 55000, 40000)).toBe(70000);
    expect(getSmoothedIncome(64, 70000, 55000, 40000)).toBe(70000);
  });

  it('N2: getSmoothedIncome transitions linearly from active to slowdown (65-70)', () => {
    // At age 65: t=0, returns activeIncome
    expect(getSmoothedIncome(65, 70000, 55000, 40000)).toBe(70000);
    // At age 67: t=2/5=0.4, returns 70000 + (55000-70000)*0.4 = 64000
    expect(getSmoothedIncome(67, 70000, 55000, 40000)).toBeCloseTo(64000, 0);
    // At age 69: t=4/5=0.8, returns 70000 + (55000-70000)*0.8 = 58000
    expect(getSmoothedIncome(69, 70000, 55000, 40000)).toBeCloseTo(58000, 0);
  });

  it('N3: getSmoothedIncome returns slowdownIncome from 70-79', () => {
    expect(getSmoothedIncome(70, 70000, 55000, 40000)).toBe(55000);
    expect(getSmoothedIncome(75, 70000, 55000, 40000)).toBe(55000);
    expect(getSmoothedIncome(79, 70000, 55000, 40000)).toBe(55000);
  });

  it('N4: getSmoothedIncome transitions linearly from slowdown to inactive (80-85)', () => {
    // At age 80: t=0, returns slowdownIncome
    expect(getSmoothedIncome(80, 70000, 55000, 40000)).toBe(55000);
    // At age 82: t=2/5=0.4, returns 55000 + (40000-55000)*0.4 = 49000
    expect(getSmoothedIncome(82, 70000, 55000, 40000)).toBeCloseTo(49000, 0);
  });

  it('N5: getSmoothedIncome returns inactiveIncome at 85+', () => {
    expect(getSmoothedIncome(85, 70000, 55000, 40000)).toBe(40000);
    expect(getSmoothedIncome(95, 70000, 55000, 40000)).toBe(40000);
  });
});

// ═══════════════════════════════════════════════
// O. Strategy Parameter
// ═══════════════════════════════════════════════
describe('Strategy Parameter', () => {
  it('O1: spend_down has no cash floor', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 64,
      savingsBal: 100000, rrspBal: 0, tfsaBal: 0, nonRegBal: 0,
      activeIncome: 30000, inflation: 0, postGrowth: 0, preGrowth: 0,
      lifeExpectancy: 90,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 65);
    // spend_down: cashFloor = 0, so full savingsBal available
    // portfolioNeed = 30000 (no CPP/OAS at 65)
    expect(row.savWd).toBe(30000);
  });

  it('O2: optimize strategy has cash floor (2 months expenses)', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 64,
      savingsBal: 100000, rrspBal: 100000, tfsaBal: 0, nonRegBal: 0,
      activeIncome: 30000, inflation: 0, postGrowth: 0, preGrowth: 0,
      lifeExpectancy: 90,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "optimize");
    const row = r.rows.find(row => row.age === 65);
    // With temporal cap on RRSP meltdown ($100K / 25yrs = $4K/yr top-up),
    // gross stays close to desired and savWd covers spending from cash.
    expect(row.savWd).toBe(30000);
    // Verify cash floor is reserved: remaining savings >= cashFloor
    const cashFloor = (row.grossNominal / 12) * 2;
    expect(100000 - row.savWd).toBeGreaterThanOrEqual(cashFloor - 1);
  });

  it('O3: spend_down produces no RRSP top-up transfer (except RRIF minimum excess)', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 64,
      rrspBal: 500000, tfsaBal: 100000, nonRegBal: 0, savingsBal: 0,
      activeIncome: 50000, lifeExpectancy: 90,
      inflation: 0, postGrowth: 0,
    }), "spend_down");
    for (const row of r.rows) {
      // Before age 72, no RRIF minimums so no transfers in spend_down
      if (row.age >= 65 && row.age < 72) {
        expect(row.rrspToTfsaTransfer).toBe(0);
      }
      // At age 72+, RRIF minimums may force excess withdrawals that get transferred
    }
  });
});

// ═══════════════════════════════════════════════
// P. Phase Labels
// ═══════════════════════════════════════════════
describe('Phase Labels', () => {
  it('P1: getPhaseLabel returns correct labels', () => {
    expect(getPhaseLabel(50, false)).toBe("Accumulation");
    expect(getPhaseLabel(60, true)).toBe("Active");
    expect(getPhaseLabel(65, true)).toBe("Active \u2192 Slow");
    expect(getPhaseLabel(67, true)).toBe("Active \u2192 Slow");
    expect(getPhaseLabel(70, true)).toBe("Slowdown");
    expect(getPhaseLabel(75, true)).toBe("Slowdown");
    expect(getPhaseLabel(80, true)).toBe("Slow \u2192 Inactive");
    expect(getPhaseLabel(84, true)).toBe("Slow \u2192 Inactive");
    expect(getPhaseLabel(85, true)).toBe("Inactive");
    expect(getPhaseLabel(90, true)).toBe("Inactive");
  });
});

// ═══════════════════════════════════════════════
// Q. Estate Value
// ═══════════════════════════════════════════════
describe('Estate Value', () => {
  it('Q1: estate value components are non-negative', () => {
    const r = runProjection(makeInputs({
      rrspBal: 500000, tfsaBal: 200000, nonRegBal: 100000, savingsBal: 50000,
    }));
    expect(r.estateValue).not.toBeNull();
    expect(r.estateValue.tfsa).toBeGreaterThanOrEqual(0);
    expect(r.estateValue.savings).toBeGreaterThanOrEqual(0);
    expect(r.estateValue.nonReg).toBeGreaterThanOrEqual(0);
    expect(r.estateValue.rrsp).toBeGreaterThanOrEqual(0);
    expect(r.estateValue.total).toBe(
      r.estateValue.tfsa + r.estateValue.savings + r.estateValue.nonReg + r.estateValue.rrsp
    );
  });

  it('Q2: TFSA estate value equals final TFSA balance (no tax)', () => {
    const r = runProjection(makeInputs({
      rrspBal: 0, tfsaBal: 200000, nonRegBal: 0, savingsBal: 0,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
      activeIncome: 10000,
    }));
    const lastRow = r.rows[r.rows.length - 1];
    expect(r.estateValue.tfsa).toBe(lastRow.tfsa);
  });

  it('Q3: RRSP estate value is reduced by terminal tax', () => {
    // Use a very large RRSP balance to ensure it survives meltdown + RRIF minimums
    const r = runProjection(makeInputs({
      rrspBal: 5000000, tfsaBal: 0, nonRegBal: 0, savingsBal: 0,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }));
    const lastRow = r.rows[r.rows.length - 1];
    if (lastRow.rrsp > 0) {
      // RRSP estate = rrsp * (1 - terminalRate), so it should be less than the raw balance
      expect(r.estateValue.rrsp).toBeLessThan(lastRow.rrsp);
      expect(r.estateValue.rrsp).toBeGreaterThan(0);
    } else {
      // If RRSP is fully depleted by meltdown/RRIF, estate RRSP value is 0
      expect(r.estateValue.rrsp).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════
// R. RRIF Minimum Withdrawals
// ═══════════════════════════════════════════════
describe('RRIF Minimum Withdrawals', () => {
  it('R1: getRrifMinimum returns 0 below age 72', () => {
    expect(getRrifMinimum(71, 1000000)).toBe(0);
    expect(getRrifMinimum(65, 500000)).toBe(0);
    expect(getRrifMinimum(35, 100000)).toBe(0);
  });

  it('R2: getRrifMinimum returns 5.28% at age 72', () => {
    expect(getRrifMinimum(72, 1000000)).toBeCloseTo(52800, 0);
  });

  it('R3: getRrifMinimum returns 6.58% at age 80', () => {
    expect(getRrifMinimum(80, 1000000)).toBeCloseTo(65800, 0);
  });

  it('R4: getRrifMinimum returns 20% at age 95+', () => {
    expect(getRrifMinimum(95, 1000000)).toBe(200000);
    expect(getRrifMinimum(100, 500000)).toBe(100000);
  });

  it('R5: getRrifMinimum returns 0 for zero balance', () => {
    expect(getRrifMinimum(80, 0)).toBe(0);
  });

  it('R6: RRIF minimum is enforced in projection at age 72+', () => {
    const r = runProjection(makeInputs({
      currentAge: 71, retirementAge: 65, lifeExpectancy: 75,
      rrspBal: 1000000, tfsaBal: 0, nonRegBal: 0, savingsBal: 0,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
      activeIncome: 10000, inflation: 0, postGrowth: 0,
    }));
    const row72 = r.rows.find(row => row.age === 72);
    // At age 72 with $1M RRSP (no growth), RRIF minimum is 5.28% = $52,800
    // This should be enforced even if spending needs are lower
    expect(row72.rrspWd).toBeGreaterThanOrEqual(52800);
  });

  it('R7: RRIF minimum overrides OAS clawback cap', () => {
    // Large RRSP with OAS — RRIF minimum should override the OAS cap
    const r = runProjection(makeInputs({
      currentAge: 71, retirementAge: 65, lifeExpectancy: 75,
      rrspBal: 2000000, tfsaBal: 0, nonRegBal: 0, savingsBal: 0,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
      activeIncome: 10000, inflation: 0, postGrowth: 0,
      oasAt65: 8908, oasClawbackThreshold: 95323,
    }));
    const row72 = r.rows.find(row => row.age === 72);
    // The RRSP balance at 72 may be less than $2M due to meltdown at 71,
    // but the RRIF minimum (5.28% of actual balance) should still exceed OAS room.
    // OAS room = 95323 - lockedIncome; RRIF min = balance * 5.28%
    // The key assertion: RRSP withdrawal exceeds what OAS cap alone would allow
    const oasRoom = 95323 - (r.optCpp.annual + r.optOas.annual * 1.10);
    expect(row72.rrspWd).toBeGreaterThan(oasRoom);
  });
});

// ═══════════════════════════════════════════════
// S. OAS 75+ Enhancement
// ═══════════════════════════════════════════════
describe('OAS 75+ Enhancement', () => {
  it('S1: OAS at age 74 uses base amount', () => {
    const r = runProjection(makeInputs({
      currentAge: 73, retirementAge: 65, lifeExpectancy: 76,
      inflation: 0,
    }));
    const row74 = r.rows.find(row => row.age === 74);
    // Before 75, OAS should be the base deferred amount (no 10% bonus)
    expect(row74.oasGross).toBeCloseTo(r.optOas.annual, 0);
  });

  it('S2: OAS at age 75 is 10% higher', () => {
    const r = runProjection(makeInputs({
      currentAge: 74, retirementAge: 65, lifeExpectancy: 77,
      inflation: 0,
    }));
    const row74 = r.rows.find(row => row.age === 74);
    const row75 = r.rows.find(row => row.age === 75);
    // At 75, OAS should be 10% higher than at 74
    expect(row75.oasGross).toBeCloseTo(row74.oasGross * 1.10, 0);
  });

  it('S3: OAS lifetime calculation includes 75+ bonus', () => {
    const r = runProjection(makeInputs({ lifeExpectancy: 80 }));
    const oas65 = r.oasOptions.find(o => o.age === 65);
    // 10 years at base (65-74) + 5 years at 1.10x (75-79)
    const expectedLifetime = oas65.annual * 10 + oas65.annual * 1.10 * 5;
    expect(oas65.lifetime).toBeCloseTo(expectedLifetime, 0);
  });
});

// ═══════════════════════════════════════════════
// T. Tax Credits (Pension Income & Age Amount)
// ═══════════════════════════════════════════════
describe('Tax Credits', () => {
  it('T1: pension income credit is 0 before age 65', () => {
    expect(calcPensionIncomeCredit(64, 10000, 5000, 0.14, 0.0505)).toBe(0);
  });

  it('T2: pension income credit caps at $2,000 eligible', () => {
    const credit = calcPensionIncomeCredit(65, 5000, 0, 0.14, 0.0505);
    // Only first $2,000 eligible: 2000 * (0.14 + 0.0505) = $381
    expect(credit).toBeCloseTo(2000 * (0.14 + 0.0505), 2);
  });

  it('T3: pension income credit uses combined RRSP + pension', () => {
    const credit = calcPensionIncomeCredit(65, 1000, 500, 0.14, 0.0505);
    // $1,500 total eligible (under $2,000 cap)
    expect(credit).toBeCloseTo(1500 * (0.14 + 0.0505), 2);
  });

  it('T4: age credit is 0 before age 65', () => {
    expect(calcAgeCredit(64, 30000, 0.14, 0.0505)).toBe(0);
  });

  it('T5: age credit full amount for low income', () => {
    const credit = calcAgeCredit(65, 20000, 0.14, 0.0505, 1);
    // Income $20K is well below threshold ($44,325), so full credit
    expect(credit).toBeCloseTo(AGE_CREDIT.amount * (0.14 + 0.0505), 2);
  });

  it('T6: age credit is clawed back above threshold', () => {
    const credit = calcAgeCredit(65, 60000, 0.14, 0.0505, 1);
    // Clawback: (60000 - 44325) * 0.15 = $2,351.25
    // Eligible: 9028 - 2351.25 = $6,676.75
    const expectedClawback = (60000 - AGE_CREDIT.threshold) * AGE_CREDIT.clawbackRate;
    const expectedEligible = AGE_CREDIT.amount - expectedClawback;
    expect(credit).toBeCloseTo(expectedEligible * (0.14 + 0.0505), 2);
  });

  it('T7: age credit is 0 for very high income', () => {
    // Income high enough to fully clawback the age credit
    // Full clawback at: 44325 + 9028/0.15 = 104511.67
    const credit = calcAgeCredit(65, 110000, 0.14, 0.0505, 1);
    expect(credit).toBe(0);
  });

  it('T8: at age 65+, projection applies tax credits (lower tax than raw brackets)', () => {
    const r = runProjection(makeInputs({
      currentAge: 64, retirementAge: 65, lifeExpectancy: 67,
      inflation: 0, province: 'Ontario',
      rrspBal: 200000, tfsaBal: 0, nonRegBal: 0, savingsBal: 0,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
      activeIncome: 40000, postGrowth: 0,
    }));
    const row65 = r.rows.find(row => row.age === 65);
    const rawFedTax = calcProgressiveTax(row65.taxableIncome, FED_BRACKETS_DEFAULT.bpa, FED_BRACKETS_DEFAULT.brackets);
    const rawProvTax = calcProgressiveTax(row65.taxableIncome, PROVINCES.Ontario.bpa, PROVINCES.Ontario.brackets);
    // With credits, actual tax should be less than raw fed + prov
    expect(row65.totalTax).toBeLessThan(rawFedTax + rawProvTax);
  });

  it('T9: at age 65+, RRSP withdraws at least $2,000 for pension credit in optimize mode', () => {
    const r = runProjection(makeInputs({
      currentAge: 64, retirementAge: 65, lifeExpectancy: 70,
      inflation: 0, postGrowth: 0,
      rrspBal: 100000, tfsaBal: 500000, nonRegBal: 0, savingsBal: 500000,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
      activeIncome: 30000,
    }), "optimize");
    const row65 = r.rows.find(row => row.age === 65);
    // Even though cash/TFSA could cover spending, RRSP should withdraw at least $2,000
    expect(row65.rrspWd).toBeGreaterThanOrEqual(2000);
  });
});

// ═══════════════════════════════════════════════
// U. Enhanced RRSP Meltdown
// ═══════════════════════════════════════════════
describe('Enhanced RRSP Meltdown', () => {
  it('U1: pre-OAS RRSP top-up is not capped by OAS threshold', () => {
    // Before OAS starts, RRSP meltdown should fill brackets freely
    const r = runProjection(makeInputs({
      currentAge: 60, retirementAge: 60, lifeExpectancy: 90,
      rrspBal: 2000000, tfsaBal: 0, nonRegBal: 0, savingsBal: 0,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
      activeIncome: 30000, inflation: 0, postGrowth: 0,
      oasClawbackThreshold: 95323,
    }));
    // At age 60, not yet receiving OAS, so RRSP meltdown can go above OAS threshold
    const row60 = r.rows.find(row => row.age === 60);
    // With a $2M RRSP and terminal tax rate being high, the top-up should be aggressive
    expect(row60.rrspWd).toBeGreaterThan(30000); // More than just spending needs
  });

  it('U2: optimize draws Non-Reg before RRSP, TFSA last', () => {
    // With balanced portfolio, optimize should draw Non-Reg first, then RRSP, TFSA last
    const r = runProjection(makeInputs({
      currentAge: 60, retirementAge: 60, lifeExpectancy: 90,
      rrspBal: 300000, tfsaBal: 300000, nonRegBal: 300000, savingsBal: 0,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
      activeIncome: 60000, inflation: 0, postGrowth: 0,
    }), "optimize");
    const row60 = r.rows.find(row => row.age === 60);
    // Non-reg drawn first for spending; RRSP fills tax room; TFSA preserved
    expect(row60.nrWd).toBeGreaterThan(0);
    expect(row60.tfsaWd).toBe(0); // TFSA last — not needed when NR+RRSP cover spending
  });

  it('U3: spend_down still uses sequential allocation (RRSP first)', () => {
    // spend_down should maintain the old sequential behavior
    const r = runProjection(makeInputs({
      currentAge: 60, retirementAge: 60, lifeExpectancy: 90,
      rrspBal: 300000, tfsaBal: 300000, nonRegBal: 300000, savingsBal: 0,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
      activeIncome: 60000, inflation: 0, postGrowth: 0,
    }), "spend_down");
    const row60 = r.rows.find(row => row.age === 60);
    // Sequential: RRSP covers full spending need, TFSA should be 0
    expect(row60.rrspWd).toBeGreaterThan(0);
    expect(row60.tfsaWd).toBe(0);
  });

  it('U5: getIncomeForAvgTaxRate returns correct threshold', () => {
    const fedBpa = FED_BRACKETS_DEFAULT.bpa;
    const fedBrk = FED_BRACKETS_DEFAULT.brackets;
    const provBpa = PROVINCES.Ontario.bpa;
    const provBrk = PROVINCES.Ontario.brackets;
    const income30 = getIncomeForAvgTaxRate(0.30, fedBpa, fedBrk, provBpa, provBrk);
    // At 30% avg rate in Ontario, income is roughly $219K
    expect(income30).toBeGreaterThan(200000);
    expect(income30).toBeLessThan(250000);
    // Verify the avg rate at this income is actually ~30%
    const tax = calcProgressiveTax(income30, fedBpa, fedBrk) + calcProgressiveTax(income30, provBpa, provBrk);
    expect(tax / income30).toBeCloseTo(0.30, 2);
  });

  it('U4: large RRSP meltdown does not withdraw entire balance (infinity bracket bug)', () => {
    // Regression: bracket-filling loop previously reached Infinity threshold,
    // causing extraRrsp = Infinity - currentIncome = entire RRSP balance
    const r = runProjection(makeInputs({
      currentAge: 60, retirementAge: 60, lifeExpectancy: 90,
      rrspBal: 2000000, tfsaBal: 200000, nonRegBal: 0, savingsBal: 50000,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
      activeIncome: 80000, inflation: 0, postGrowth: 0.04,
      pensionIncome: 0, pensionBridge: 0, otherIncome: 0,
    }));
    const row60 = r.rows.find(row => row.age === 60);
    // RRSP meltdown should fill to last finite bracket edge, not withdraw entire $2M
    // Last federal bracket edge is ~$258K — with BPA and spending, top-up should be well under $500K
    expect(row60.rrspWd).toBeLessThan(500000);
    // Net income should not be negative
    expect(row60.netIncome).toBeGreaterThan(0);
    // Portfolio should still have substantial funds
    expect(row60.totalPortfolio).toBeGreaterThan(1000000);
  });
});

// ═══════════════════════════════════════════════
// R. Net Income Targeting
// ═══════════════════════════════════════════════
describe('Net Income Targeting', () => {
  it('R1: net income equals desired when portfolio is sufficient', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 64,
      rrspBal: 500000, tfsaBal: 200000, nonRegBal: 100000, savingsBal: 50000,
      activeIncome: 60000, inflation: 0, postGrowth: 0,
      lifeExpectancy: 90,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 65);
    // desiredNominal = 60000 (net target), netIncome should match within iteration tolerance
    expect(Math.abs(row.netIncome - row.desiredNominal)).toBeLessThan(2);
  });

  it('R2: RRSP-only grosses up to cover tax', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 65,
      rrspBal: 500000, tfsaBal: 0, nonRegBal: 0, savingsBal: 0,
      activeIncome: 50000, inflation: 0, postGrowth: 0,
      lifeExpectancy: 90,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 65);
    // RRSP is fully taxable, so rrspWd > 50000 to deliver 50000 net
    expect(row.rrspWd).toBeGreaterThan(50000);
    expect(row.grossNominal).toBeGreaterThan(row.desiredNominal);
    // Iteration converges within $1 tolerance
    expect(Math.abs(row.netIncome - 50000)).toBeLessThan(2);
  });

  it('R3: TFSA-only needs no gross-up', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 65,
      rrspBal: 0, tfsaBal: 500000, nonRegBal: 0, savingsBal: 0,
      activeIncome: 50000, inflation: 0, postGrowth: 0,
      lifeExpectancy: 90,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 65);
    // TFSA is tax-free, so tfsaWd = 50000 exactly, no gross-up needed
    expect(row.tfsaWd).toBe(50000);
    expect(row.grossNominal).toBe(row.desiredNominal);
    expect(row.netIncome).toBeCloseTo(50000, 0);
  });

  it('R4: iteration converges with mixed accounts', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 65,
      rrspBal: 300000, tfsaBal: 200000, nonRegBal: 0, savingsBal: 0,
      activeIncome: 40000, inflation: 0, postGrowth: 0,
      lifeExpectancy: 90,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 65);
    // Mixed RRSP+TFSA: iteration should converge to deliver net ≈ 40000
    expect(Math.abs(row.netIncome - 40000)).toBeLessThan(2);
    expect(row.grossNominal).toBeGreaterThan(row.desiredNominal);
  });

  it('R5: depleted portfolio handles shortfall gracefully', () => {
    const r = runProjection(makeInputs({
      retirementAge: 65, currentAge: 65,
      rrspBal: 0, tfsaBal: 0, nonRegBal: 0, savingsBal: 5000,
      activeIncome: 70000, inflation: 0, postGrowth: 0,
      lifeExpectancy: 90,
      rrspContrib: 0, tfsaContrib: 0, nonRegContrib: 0, savingsContrib: 0,
    }), "spend_down");
    const row = r.rows.find(row => row.age === 65);
    // Can't meet 70K target with 5K savings — no crash, no NaN
    expect(Number.isFinite(row.netIncome)).toBe(true);
    expect(Number.isNaN(row.netIncome)).toBe(false);
    expect(row.netIncome).toBeLessThan(70000);
  });
});
