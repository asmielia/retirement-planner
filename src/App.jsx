import { useState, useMemo, useEffect, useCallback } from "react";
import { PAGES, STORAGE_KEY, SURPLUS_STORAGE_KEY, PAGE_STORAGE_KEY } from "./constants.js";
import { getNames } from "./formatters.js";
import { runProjection } from "./projection.js";
import { findFundingRatio, runBoostSpending, runMaxEstate, runRetireEarly } from "./surplus.js";
import { runCoupleProjection } from "./couple.js";
import { findCoupleFundingRatio, runCoupleBoostSpending, runCoupleMaxEstate, runCoupleRetireEarly } from "./coupleSurplus.js";
import { decodeShareData, loadSavedInputs, loadSurplusMode } from "./share.js";
import Page1_Personal from "./pages/Page1_Personal.jsx";
import Page2_Balances from "./pages/Page2_Balances.jsx";
import Page3_Income from "./pages/Page3_Income.jsx";
import Page4_Rates from "./pages/Page4_Rates.jsx";
import Page5_CPP from "./pages/Page5_CPP.jsx";
import Page6_Results from "./pages/Page6_Results.jsx";
import Page7_Charts from "./pages/Page7_Charts.jsx";

export default function App() {
  const [page, setPage] = useState(() => {
    if (new URLSearchParams(window.location.search).get("share")) return 5;
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

  // Shared URL state — parsed once on mount, never written to localStorage
  const [sharedData, setSharedData] = useState(() => {
    const encoded = new URLSearchParams(window.location.search).get("share");
    return encoded ? decodeShareData(encoded) : null;
  });
  const isSharedView = sharedData !== null;
  const effectiveInputs = isSharedView ? sharedData.inputs : inputs;
  const effectiveSurplusMode = isSharedView ? sharedData.surplusMode : surplusMode;

  // Persist inputs to localStorage
  useEffect(() => {
    if (isSharedView) return;
    try {
      const { fedBrackets, ...rest } = inputs;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
    } catch (e) { /* storage full or unavailable */ }
  }, [inputs, isSharedView]);

  // Persist surplus mode
  useEffect(() => {
    if (isSharedView) return;
    try {
      localStorage.setItem(SURPLUS_STORAGE_KEY, surplusMode);
    } catch (e) { /* ignore */ }
  }, [surplusMode, isSharedView]);

  // Persist current page
  useEffect(() => {
    if (isSharedView) return;
    try {
      localStorage.setItem(PAGE_STORAGE_KEY, page);
    } catch (e) { /* ignore */ }
  }, [page, isSharedView]);

  const setField = useCallback((key, value) => {
    setInputs(prev => ({ ...prev, [key]: value }));
  }, []);

  const setPartnerField = useCallback((key, value) => {
    setInputs(prev => ({ ...prev, partner: { ...prev.partner, [key]: value } }));
  }, []);

  const isCouple = effectiveInputs.mode === "couple";
  const currentPageDef = PAGES[page];

  const results = useMemo(() => {
    if (isCouple) {
      const fundingRatio = findCoupleFundingRatio(effectiveInputs);
      const base = runCoupleProjection(effectiveInputs);
      if (!base.hasSurplus) {
        return { ...base, surplusMode: null, fundingRatio };
      }
      if (effectiveSurplusMode === "boost_spending") {
        return { ...runCoupleBoostSpending(effectiveInputs), fundingRatio };
      }
      if (effectiveSurplusMode === "retire_early") {
        return { ...runCoupleRetireEarly(effectiveInputs), fundingRatio };
      }
      return { ...runCoupleMaxEstate(effectiveInputs), fundingRatio };
    }
    const fundingRatio = findFundingRatio(effectiveInputs);
    const base = runProjection(effectiveInputs);
    if (!base.hasSurplus) {
      return { ...base, surplusMode: null, fundingRatio };
    }
    if (effectiveSurplusMode === "boost_spending") {
      return { ...runBoostSpending(effectiveInputs), fundingRatio };
    }
    if (effectiveSurplusMode === "retire_early") {
      return { ...runRetireEarly(effectiveInputs), fundingRatio };
    }
    return { ...runMaxEstate(effectiveInputs), fundingRatio };
  }, [effectiveInputs, effectiveSurplusMode, isCouple]);

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
  const activePerson = personTab === "partner" ? effectiveInputs.partner : effectiveInputs;
  const activeSetField = personTab === "partner" ? setPartnerField : setField;
  const names = getNames(effectiveInputs);

  const pages = [
    <Page1_Personal inputs={effectiveInputs} setField={setField} setPartnerField={setPartnerField} personTab={personTab} isCouple={isCouple} activePerson={activePerson} activeSetField={activeSetField} names={names} />,
    <Page2_Balances inputs={effectiveInputs} setField={setField} personTab={personTab} isCouple={isCouple} activePerson={activePerson} activeSetField={activeSetField} names={names} />,
    <Page5_CPP inputs={effectiveInputs} setField={setField} personTab={personTab} isCouple={isCouple} activePerson={activePerson} activeSetField={activeSetField} results={results} names={names} />,
    <Page4_Rates inputs={effectiveInputs} setField={setField} />,
    <Page3_Income inputs={effectiveInputs} setField={setField} isCouple={isCouple} names={names} />,
    <Page6_Results inputs={effectiveInputs} results={results} surplusMode={effectiveSurplusMode} setSurplusMode={setSurplusMode} isCouple={isCouple} names={names} isSharedView={isSharedView} />,
    <Page7_Charts inputs={effectiveInputs} results={results} surplusMode={effectiveSurplusMode} setSurplusMode={setSurplusMode} isCouple={isCouple} chartView={chartView} setChartView={setChartView} names={names} isSharedView={isSharedView} />,
  ];

  // Next button label
  const isLastPage = page === PAGES.length - 1;
  const isSecondLastPage = page === PAGES.length - 2;
  let nextLabel = isSecondLastPage ? "See Results →" : "Next →";
  if (isCouple && currentPageDef?.perPerson && personTab === "you") {
    nextLabel = `Next: ${names.partnerName} →`;
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
              { key: "you", label: names.youName },
              { key: "partner", label: names.partnerName },
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
        {isSharedView && (
          <div className="bg-blue-900/30 border border-blue-400/30 rounded-xl p-4 mb-6 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-lg">🔗</span>
              <span className="text-sm text-blue-300">
                You're viewing {names.youPossessive} shared retirement plan.
              </span>
            </div>
            <button
              onClick={() => { setSharedData(null); window.history.replaceState({}, "", window.location.pathname); setPage(0); }}
              className="px-3 py-1 rounded-lg text-xs font-medium bg-slate-800/60 text-slate-400 border border-slate-700/40 hover:text-white hover:border-slate-600 transition-all whitespace-nowrap">
              View My Plan
            </button>
          </div>
        )}
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

      {/* Version footer */}
      <div className="text-center py-4 text-xs text-slate-600">v{__APP_VERSION__}</div>

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
