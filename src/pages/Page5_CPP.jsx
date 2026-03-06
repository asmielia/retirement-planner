import { SectionTitle, Field, Explanation } from "../components.jsx";
import { fmt, fmtK } from "../formatters.js";

export default function Page5_CPP({ inputs, setField, personTab, isCouple, activePerson, activeSetField, results, names }) {
  const showBridge = activePerson.retirementAge < 65;
  const who = isCouple ? (personTab === "partner" ? names.partnerPossessive : names.youPossessive) : "";
  const whoLower = isCouple ? (personTab === "partner" ? (inputs.partner?.name ? `${inputs.partner.name}'s` : "your partner's") : (inputs.name ? `${inputs.name}'s` : "your")) : (inputs.name ? `${inputs.name}'s` : "your");
  // For couple mode, use per-person CPP/OAS results
  const personResults = isCouple ? (personTab === "partner" ? results.partnerResults : results.youResults) : results;
  return (
    <div>
      <SectionTitle icon="🏛️" title={`${who ? who + " " : ""}CPP, OAS & Pension`}
        subtitle={`Government benefits and employer pensions form the foundation of ${whoLower} retirement income.`} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 mb-6">
        <div>
          <Field label="CPP Annual Amount at Age 65 (Today's $)" value={activePerson.cppAt65} onChange={v => activeSetField("cppAt65", v)} hint="2025 max: $17,196. Check your My Service Canada Account for your estimate." />
          <Field label="OAS Annual Amount at Age 65 (Today's $)" value={activePerson.oasAt65} onChange={v => activeSetField("oasAt65", v)} hint="2026 max: ~$8,908 (age 65–74)" />
          <Field label="OAS Clawback Threshold (Today's $)" value={activePerson.oasClawbackThreshold} onChange={v => activeSetField("oasClawbackThreshold", v)} hint="2026: $95,323. Above this, 15¢ per dollar is clawed back." />
        </div>
        <div>
          {personResults && (
            <div className="bg-gradient-to-br from-amber-900/20 to-slate-800/60 border border-amber-400/20 rounded-xl p-5">
              <div className="text-xs uppercase tracking-widest text-amber-400/70 mb-4">Optimal Start Ages</div>
              <div className="grid grid-cols-2 gap-4">
                <div className="text-center">
                  <div className="text-4xl font-bold text-amber-400">{personResults.optCpp.age}</div>
                  <div className="text-xs text-slate-400 mt-1">CPP Start Age</div>
                  <div className="text-sm text-white mt-1">{fmt(personResults.optCpp.annual)}/yr</div>
                </div>
                <div className="text-center">
                  <div className="text-4xl font-bold text-amber-400">{personResults.optOas.age}</div>
                  <div className="text-xs text-slate-400 mt-1">OAS Start Age</div>
                  <div className="text-sm text-white mt-1">{fmt(personResults.optOas.annual)}/yr</div>
                </div>
              </div>
            </div>
          )}
          <Explanation>
            CPP decreases by 0.6%/month before 65 (max -36% at 60) and increases by 0.7%/month after 65 (max +42% at 70). OAS increases by 0.6%/month after 65 (max +36% at 70), and automatically increases by 10% at age 75. With a life expectancy of {activePerson.lifeExpectancy}, delaying to {personResults?.optCpp?.age || 65} maximizes total lifetime CPP benefits.
          </Explanation>
        </div>
      </div>
      {personResults && (
        <>
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-widest mb-3">CPP Amount by Start Age</h3>
          <div className="grid grid-cols-11 gap-1 text-center text-xs">
            {personResults.cppOptions.map(o => (
              <div key={o.age} className={`rounded-lg p-2 ${o.age === personResults.optCpp.age ? "bg-amber-400/20 border border-amber-400/40" : "bg-slate-800/40"}`}>
                <div className="text-slate-400">Age {o.age}</div>
                <div className={`font-bold ${o.age === personResults.optCpp.age ? "text-amber-400" : "text-white"}`}>{fmt(o.annual)}</div>
                <div className="text-slate-500">{fmtK(o.lifetime)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Pension & Other Income */}
      <div className="mt-8">
        <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-4">{who ? who + " " : ""}Pension & Other Retirement Income</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
          <div>
            <Field label="Annual Pension Income (Today's $)" value={activePerson.pensionIncome} onChange={v => activeSetField("pensionIncome", v)} hint="Employer defined-benefit pension. Taxed as regular income. Not adjusted for inflation." />
            {showBridge && (
              <Field label="Pension Bridge Benefit (Today's $)" value={activePerson.pensionBridge} onChange={v => activeSetField("pensionBridge", v)} hint={`Extra annual amount paid from retirement until age 65 to cover the gap before CPP/OAS. Taxed as regular income. Not adjusted for inflation.`} />
            )}
          </div>
          <div>
            <Field label="Other Annual Retirement Income (Today's $)" value={activePerson.otherIncome} onChange={v => activeSetField("otherIncome", v)} hint="Rental income, part-time work, annuities, etc. Taxed as regular income. Adjusted for inflation." />
            <Explanation>
              Pension and other income are taxed the same as RRSP withdrawals (fully taxable as regular income). They also count toward the OAS clawback threshold.
              {showBridge && " The bridge benefit is only paid until age 65, when CPP and OAS typically begin."}
            </Explanation>
          </div>
        </div>
      </div>
    </div>
  );
}
