import { FED_BRACKETS_DEFAULT } from "./tax.js";

export const PARTNER_DEFAULTS = {
  name: "",
  currentAge: 35, retirementAge: 65, lifeExpectancy: 90, employmentIncome: 0,
  rrspBal: 50000, tfsaBal: 40000, nonRegBal: 20000, savingsBal: 15000,
  rrspContrib: 10000, tfsaContrib: 7000, nonRegContrib: 5000, savingsContrib: 3000,
  pensionIncome: 0, pensionBridge: 0, otherIncome: 0,
  cppAt65: 17196, oasAt65: 8908, oasClawbackThreshold: 95323,
};

export const DEFAULTS = {
  mode: "single", name: "",
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

export const PAGES = [
  { title: "Personal", icon: "🍁", perPerson: true },
  { title: "Savings", icon: "💰", perPerson: true },
  { title: "CPP & OAS", icon: "🏛️", perPerson: true },
  { title: "Rates", icon: "📊" },
  { title: "Income", icon: "🏖️" },
  { title: "Results", icon: "📋" },
  { title: "Charts", icon: "📈" },
];

export const STORAGE_KEY = "retirement-planner-inputs";
export const SURPLUS_STORAGE_KEY = "retirement-planner-surplus-mode";
export const PAGE_STORAGE_KEY = "retirement-planner-page";
export const ANTHROPIC_API_KEY_STORAGE_KEY = "retirement-planner-anthropic-key";
export const T4_DATA_STORAGE_KEY = "retirement-planner-t4-data";

// CRA prescribed RRIF minimum withdrawal percentages by age
// Source: https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/completing-slips-summaries/t4rsp-t4rif-information-returns/payments/chart-prescribed-factors.html
// RRSP must be converted to RRIF by Dec 31 of the year the holder turns 71.
// Minimum withdrawals are mandatory starting the year after conversion (age 72).
const RRIF_MIN_RATES = {
  72: 0.0528, 73: 0.0540, 74: 0.0553, 75: 0.0567, 76: 0.0582,
  77: 0.0598, 78: 0.0617, 79: 0.0636, 80: 0.0658, 81: 0.0682,
  82: 0.0708, 83: 0.0738, 84: 0.0771, 85: 0.0808, 86: 0.0851,
  87: 0.0899, 88: 0.0956, 89: 0.1021, 90: 0.1099, 91: 0.1192,
  92: 0.1306, 93: 0.1449, 94: 0.1634, 95: 0.2000,
};

export function getRrifMinimum(age, rrspBalance) {
  if (age < 72 || rrspBalance <= 0) return 0;
  const rate = age >= 95 ? 0.20 : RRIF_MIN_RATES[age] || 0.20;
  return rrspBalance * rate;
}
