import { SectionTitle, StatCard, Explanation, ShareButton } from "../components.jsx";
import { fmt, fmtK } from "../formatters.js";

export default function Page6_Results({ inputs, results, surplusMode, setSurplusMode, isCouple, names, isSharedView }) {
  const status = results.fundingRatio >= 1 ? { icon: "✅", text: "Plan is On Track", color: "text-emerald-400" }
    : results.fundingRatio >= 0.7 ? { icon: "⚠️", text: "Needs Improvement", color: "text-amber-400" }
    : { icon: "❌", text: "Plan is Unrealistic", color: "text-red-400" };

  const effectiveRetAge = surplusMode === "retire_early"
    ? (isCouple ? Math.min(results.earlyYouRetirementAge ?? inputs.retirementAge, results.earlyPartnerRetirementAge ?? inputs.partner.retirementAge)
               : (results.earlyRetirementAge ?? inputs.retirementAge))
    : (isCouple ? Math.min(inputs.retirementAge, inputs.partner.retirementAge)
               : inputs.retirementAge);
  const retRows = results.rows.filter(r => r.age >= effectiveRetAge);
  const totalTaxPaid = retRows.reduce((s, r) => s + r.totalTax, 0);
  const totalClawback = retRows.reduce((s, r) => s + r.oasClawback, 0);
  const lastRow = results.rows[results.rows.length - 1];

  return (
    <div>
      <SectionTitle icon="📋" title={`${names.youPossessive} Retirement Summary`}
        subtitle="Here's the big picture — how your plan holds up across all the years ahead."
        action={!isSharedView && <ShareButton inputs={inputs} surplusMode={surplusMode} />} />

      {/* Status banner */}
      <div className={`rounded-xl p-6 mb-8 text-center border ${results.fundingRatio >= 1 ? "bg-emerald-900/20 border-emerald-400/30" : results.fundingRatio >= 0.7 ? "bg-amber-900/20 border-amber-400/30" : "bg-red-900/20 border-red-400/30"}`}>
        <div className="text-4xl mb-2">{status.icon}</div>
        <div className={`text-2xl font-bold ${status.color}`}>{status.text}</div>
        <div className="text-slate-400 text-sm mt-1">Funding Ratio: <span className="text-white font-semibold">{Math.round(results.fundingRatio * 100)}%</span></div>
      </div>

      {/* Surplus mode toggle */}
      {results.hasSurplus && (
        <div className="bg-slate-800/60 border border-amber-400/30 rounded-xl p-5 mb-8">
          <div className="text-sm font-semibold text-amber-400 mb-1">
            {inputs.name ? `${inputs.name}'s` : "Your"} plan has a surplus — choose how to use it:
          </div>
          <div className="text-xs text-slate-400 mb-4">{inputs.name ? `${inputs.name}'s savings outlast` : "Your savings outlast"} {isCouple ? "the" : inputs.name ? "the" : "your"} retirement. You can spend more, leave a larger inheritance, or retire sooner.</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { key: "max_estate", label: "Maximize Estate", icon: "🏠", desc: "Optimize withdrawals to leave the largest possible post-tax inheritance" },
              { key: "boost_spending", label: "Increase Spending", icon: "✈️", desc: "Proportionally increase retirement income so funds are fully used by end of life" },
              { key: "retire_early", label: "Retire Earlier", icon: "⏰", desc: "Lower retirement age to the earliest point where the plan is still fully funded" },
            ].map(opt => (
              <button key={opt.key}
                onClick={() => setSurplusMode(opt.key)}
                className={`rounded-lg p-4 border text-left transition-all ${
                  surplusMode === opt.key
                    ? "bg-amber-400/15 border-amber-400/50 text-white"
                    : "bg-slate-800/40 border-slate-700/40 text-slate-400 hover:border-slate-600"
                }`}>
                <div className="text-lg mb-1">{opt.icon}</div>
                <div className="text-sm font-semibold">{opt.label}</div>
                <div className="text-xs mt-1 leading-relaxed">{opt.desc}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Boosted spending display */}
      {surplusMode === "boost_spending" && results.spendingMultiplier && (
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-3">Boosted Retirement Income (Today's $)</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard label={`Active Phase (${inputs.retirementAge}–70)`}
              value={fmt(Math.round(results.boostedActiveIncome))}
              sub={`was ${fmt(inputs.activeIncome)} (+${Math.round((results.spendingMultiplier - 1) * 100)}%)`} accent />
            <StatCard label="Slowdown Phase (70–85)"
              value={fmt(Math.round(results.boostedSlowdownIncome))}
              sub={`was ${fmt(inputs.slowdownIncome)} (+${Math.round((results.spendingMultiplier - 1) * 100)}%)`} accent />
            <StatCard label="Inactive Phase (85+)"
              value={fmt(Math.round(results.boostedInactiveIncome))}
              sub={`was ${fmt(inputs.inactiveIncome)} (+${Math.round((results.spendingMultiplier - 1) * 100)}%)`} accent />
          </div>
          <Explanation>
            By increasing spending by {Math.round((results.spendingMultiplier - 1) * 100)}% across all phases, the {isCouple ? "combined portfolios are" : "portfolio is"} projected to be fully utilized by the end of the plan. These amounts are in today's dollars and will be inflation-adjusted each year.
          </Explanation>
        </div>
      )}

      {/* Estate value display */}
      {surplusMode === "max_estate" && results.estateValue && (
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-3">Estimated Post-Tax Estate Value</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="TFSA (tax-free)" value={fmtK(results.estateValue.tfsa)} accent />
            <StatCard label="Cash Savings" value={fmtK(results.estateValue.savings)} />
            <StatCard label="Non-Reg (after tax)" value={fmtK(results.estateValue.nonReg)} />
            <StatCard label="RRSP (after tax)" value={fmtK(results.estateValue.rrsp)} />
            <StatCard label="Total Estate" value={fmtK(results.estateValue.total)} accent />
          </div>
          <Explanation>
            The estate strategy aggressively draws down your RRSP during retirement at lower tax brackets, preserving your TFSA (which passes tax-free to beneficiaries). At death, any remaining RRSP is fully taxable as income on the final tax return. Estate values shown are after estimated taxes. Actual values depend on factors like surviving spouse (RRSP rollover), province of death, and executor decisions.
          </Explanation>
        </div>
      )}

      {/* Early retirement display */}
      {surplusMode === "retire_early" && (results.earlyRetirementAge != null || results.earlyYouRetirementAge != null) && (
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-3">Early Retirement</h3>
          {isCouple ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label={`${names.youName} New Age`} value={results.earlyYouRetirementAge} accent />
                <StatCard label={`${names.partnerName} New Age`} value={results.earlyPartnerRetirementAge} accent />
                <StatCard label={`${names.youName} Saved`} value={`${results.youYearsSaved} yr${results.youYearsSaved !== 1 ? "s" : ""}`} />
                <StatCard label={`${names.partnerName} Saved`} value={`${results.partnerYearsSaved} yr${results.partnerYearsSaved !== 1 ? "s" : ""}`} />
              </div>
              <Explanation>
                {names.youName} can retire at {results.earlyYouRetirementAge} (saving {results.youYearsSaved} year{results.youYearsSaved !== 1 ? "s" : ""}) and {names.partnerName} at {results.earlyPartnerRetirementAge} (saving {results.partnerYearsSaved} year{results.partnerYearsSaved !== 1 ? "s" : ""}), while keeping the plan fully funded. Spending targets remain the same.
              </Explanation>
            </>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <StatCard label="New Retirement Age" value={results.earlyRetirementAge} accent />
                <StatCard label="Original Retirement Age" value={results.originalRetirementAge} />
                <StatCard label="Years Saved" value={results.yearsSaved} accent />
              </div>
              <Explanation>
                By retiring at age {results.earlyRetirementAge} instead of {results.originalRetirementAge}, {results.yearsSaved} year{results.yearsSaved !== 1 ? "s" : ""} of work {results.yearsSaved !== 1 ? "are" : "is"} saved while keeping the plan fully funded through age {inputs.lifeExpectancy}. Spending targets remain the same.
              </Explanation>
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        <StatCard label="Portfolio at Retirement" value={fmtK(results.portfolioAtRet)} accent />
        {isCouple ? (
          <StatCard label="Retirement Ages"
            value={`${surplusMode === "retire_early" && results.earlyYouRetirementAge != null ? results.earlyYouRetirementAge : inputs.retirementAge} / ${surplusMode === "retire_early" && results.earlyPartnerRetirementAge != null ? results.earlyPartnerRetirementAge : inputs.partner.retirementAge}`}
            sub={`${names.youName} / ${names.partnerName}`} />
        ) : (
          <StatCard label="Retirement Age"
            value={surplusMode === "retire_early" && results.earlyRetirementAge != null ? results.earlyRetirementAge : inputs.retirementAge} />
        )}
        <StatCard label="Portfolio at End" value={fmtK(lastRow?.totalPortfolio)} sub={`Age ${inputs.lifeExpectancy}`} />
        <StatCard label="Total Tax Paid" value={fmtK(totalTaxPaid)} sub="Over retirement" />
        <StatCard label="OAS Clawback" value={totalClawback > 0 ? fmtK(totalClawback) : "$0"} sub={totalClawback > 0 ? "Lost to clawback" : "Fully avoided ✓"} accent={totalClawback === 0} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-3">Tax-Optimized Withdrawal Strategy</h3>
          <div className="space-y-2 text-sm text-slate-300">
            <div className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">1.</span><span><strong className="text-white">Cash savings first</strong> — no growth benefit, so spend it early</span></div>
            <div className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">2.</span><span><strong className="text-white">RRSP to fill low brackets</strong> — drawn up to OAS clawback threshold, plus extra if your current tax rate is lower than the projected rate at death</span></div>
            <div className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">3.</span><span><strong className="text-white">Non-registered next</strong> — only 50% of capital gains are taxable</span></div>
            <div className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">4.</span><span><strong className="text-white">TFSA last</strong> — completely tax-free, let it compound as long as possible</span></div>
            {isCouple && <div className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">•</span><span><strong className="text-white">Proportional split</strong> — when both partners are retired, withdrawals are split proportional to each partner's remaining portfolio</span></div>}
          </div>
        </div>
        <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-3">Guaranteed Income</h3>
          {isCouple ? (
            <div className="space-y-2 text-sm text-slate-300">
              <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold">{names.youName}</div>
              <div className="flex justify-between"><span>CPP at age {results.youResults.optCpp.age}</span><span className="text-white font-semibold">{fmt(results.youResults.optCpp.annual)}/yr</span></div>
              <div className="flex justify-between"><span>OAS at age {results.youResults.optOas.age}</span><span className="text-white font-semibold">{fmt(results.youResults.optOas.annual)}/yr</span></div>
              {inputs.pensionIncome > 0 && <div className="flex justify-between"><span>Pension</span><span className="text-white font-semibold">{fmt(inputs.pensionIncome)}/yr</span></div>}
              <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold mt-3 pt-2 border-t border-slate-700/40">{names.partnerName}</div>
              <div className="flex justify-between"><span>CPP at age {results.partnerResults.optCpp.age}</span><span className="text-white font-semibold">{fmt(results.partnerResults.optCpp.annual)}/yr</span></div>
              <div className="flex justify-between"><span>OAS at age {results.partnerResults.optOas.age}</span><span className="text-white font-semibold">{fmt(results.partnerResults.optOas.annual)}/yr</span></div>
              {inputs.partner.pensionIncome > 0 && <div className="flex justify-between"><span>Pension</span><span className="text-white font-semibold">{fmt(inputs.partner.pensionIncome)}/yr</span></div>}
              <div className="flex justify-between border-t border-slate-700/40 pt-2"><span>Combined at 65+</span><span className="text-amber-400 font-semibold">{fmt(results.youResults.optCpp.annual + results.youResults.optOas.annual + inputs.pensionIncome + results.partnerResults.optCpp.annual + results.partnerResults.optOas.annual + inputs.partner.pensionIncome)}/yr</span></div>
            </div>
          ) : (
            <div className="space-y-2 text-sm text-slate-300">
              <div className="flex justify-between"><span>CPP starts at age</span><span className="text-white font-semibold">{results.optCpp.age}</span></div>
              <div className="flex justify-between"><span>CPP annual (today's $)</span><span className="text-white font-semibold">{fmt(results.optCpp.annual)}</span></div>
              <div className="flex justify-between"><span>OAS starts at age</span><span className="text-white font-semibold">{results.optOas.age}</span></div>
              <div className="flex justify-between"><span>OAS annual (today's $)</span><span className="text-white font-semibold">{fmt(results.optOas.annual)}</span></div>
              {inputs.pensionIncome > 0 && <div className="flex justify-between"><span>Pension (today's $)</span><span className="text-white font-semibold">{fmt(inputs.pensionIncome)}/yr</span></div>}
              {inputs.pensionBridge > 0 && inputs.retirementAge < 65 && <div className="flex justify-between"><span>Bridge until 65 (today's $)</span><span className="text-white font-semibold">{fmt(inputs.pensionBridge)}/yr</span></div>}
              {inputs.otherIncome > 0 && <div className="flex justify-between"><span>Other income (today's $)</span><span className="text-white font-semibold">{fmt(inputs.otherIncome)}/yr</span></div>}
              <div className="flex justify-between border-t border-slate-700/40 pt-2"><span>Combined at 65+ (today's $)</span><span className="text-amber-400 font-semibold">{fmt(results.optCpp.annual + results.optOas.annual + inputs.pensionIncome + inputs.otherIncome)}/yr</span></div>
            </div>
          )}
        </div>
      </div>
      <Explanation>
        The funding ratio shows how much of your desired retirement spending your savings can support. 100% means your portfolio exactly covers your lifestyle through life expectancy. Above 100% means you could spend more or leave an estate. Below 100% means you'll need to reduce spending or save more.
      </Explanation>
    </div>
  );
}
