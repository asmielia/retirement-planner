import { SectionTitle, Field, Explanation } from "../components.jsx";
import { fmt } from "../formatters.js";

export default function Page2_Balances({ inputs, setField, personTab, isCouple, activePerson, activeSetField, names }) {
  const total = activePerson.rrspBal + activePerson.tfsaBal + activePerson.nonRegBal + activePerson.savingsBal;
  const totalContrib = activePerson.rrspContrib + activePerson.tfsaContrib + activePerson.nonRegContrib + activePerson.savingsContrib;
  const who = isCouple ? (personTab === "partner" ? names.partnerPossessive : names.youPossessive) : names.youPossessive;
  const whoLower = isCouple ? (personTab === "partner" ? (inputs.partner?.name ? `${inputs.partner.name}'s` : "your partner's") : (inputs.name ? `${inputs.name}'s` : "your")) : (inputs.name ? `${inputs.name}'s` : "your");
  const whoContrib = isCouple && personTab === "partner" ? (inputs.partner?.name ? `${inputs.partner.name} contributes` : "they contribute") : (inputs.name ? `${inputs.name} contributes` : "you contribute");
  return (
    <div>
      <SectionTitle icon="💰" title={`${who} Savings Today`}
        subtitle={`Enter ${whoLower} current account balances and how much ${whoContrib} each year.`} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
        <div>
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-4">Current Balances</h3>
          <Field label="RRSP" value={activePerson.rrspBal} onChange={v => activeSetField("rrspBal", v)} hint="Tax-deferred growth, taxable on withdrawal" />
          <Field label="TFSA" value={activePerson.tfsaBal} onChange={v => activeSetField("tfsaBal", v)} hint="Tax-free growth and withdrawal" />
          <Field label="Non-Registered Investment" value={activePerson.nonRegBal} onChange={v => activeSetField("nonRegBal", v)} hint="Investment growth taxed as capital gains (50% inclusion)" />
          <Field label="Savings Account (Cash)" value={activePerson.savingsBal} onChange={v => activeSetField("savingsBal", v)} hint="No investment growth — just cash" />
          <div className="border-t border-slate-700/50 pt-3 mt-2 flex justify-between">
            <span className="text-sm text-slate-400">Total Savings</span>
            <span className="text-lg font-bold text-white">{fmt(total)}</span>
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-4">Annual Contributions</h3>
          <Field label="RRSP" value={activePerson.rrspContrib} onChange={v => activeSetField("rrspContrib", v)} />
          <Field label="TFSA" value={activePerson.tfsaContrib} onChange={v => activeSetField("tfsaContrib", v)} />
          <Field label="Non-Registered" value={activePerson.nonRegContrib} onChange={v => activeSetField("nonRegContrib", v)} />
          <Field label="Savings Account" value={activePerson.savingsContrib} onChange={v => activeSetField("savingsContrib", v)} />
          <div className="border-t border-slate-700/50 pt-3 mt-2 flex justify-between">
            <span className="text-sm text-slate-400">Total Contributions</span>
            <span className="text-lg font-bold text-white">{fmt(totalContrib)}/yr</span>
          </div>
        </div>
      </div>
      <Explanation>
        We use a tax-aware withdrawal strategy: cash savings first (no growth benefit), then RRSP to fill low tax brackets (capped at the OAS clawback threshold), then non-registered (50% capital gains inclusion), and TFSA last (preserving tax-free compounding). If your current marginal tax rate is lower than the projected rate at death, extra RRSP is drawn now to reduce the future tax burden on your estate.
      </Explanation>
    </div>
  );
}
