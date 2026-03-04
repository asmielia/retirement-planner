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
