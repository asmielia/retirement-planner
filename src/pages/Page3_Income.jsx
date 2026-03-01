import { SectionTitle, Field, Explanation } from "../components.jsx";

export default function Page3_Income({ inputs, setField, isCouple, names }) {
  const coupleTitle = inputs.name && inputs.partner?.name
    ? `${inputs.name} & ${inputs.partner.name}'s Retirement Lifestyle`
    : "Your Combined Retirement Lifestyle";
  const coupleSubtitle = inputs.name && inputs.partner?.name
    ? `How much combined annual income do ${inputs.name} and ${inputs.partner.name} need in retirement? These are your total household spending targets.`
    : "How much combined annual income do you and your partner need in retirement? These are your total household spending targets.";
  return (
    <div>
      <SectionTitle icon="🏖️" title={isCouple ? coupleTitle : `${names.youPossessive} Retirement Lifestyle`}
        subtitle={isCouple ? coupleSubtitle : "How much annual income do you need in retirement? Most people spend more in early retirement (travel, hobbies) and less as they age."} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        {[
          { key: "activeIncome", label: "Active Phase", ages: `Retirement–65, ramps 65–70`, icon: "✈️", desc: "Travel, dining out, new hobbies" },
          { key: "slowdownIncome", label: "Slowdown Phase", ages: "70–80, ramps 80–85", icon: "🏡", desc: "Quieter lifestyle, less travel" },
          { key: "inactiveIncome", label: "Inactive Phase", ages: "85+", icon: "🪑", desc: "Mostly home-based, possible care costs" },
        ].map(p => (
          <div key={p.key} className="bg-slate-800/50 border border-slate-700/40 rounded-xl p-5">
            <div className="text-2xl mb-2">{p.icon}</div>
            <div className="text-sm font-semibold text-white mb-1">{p.label} <span className="text-slate-500 font-normal">({p.ages})</span></div>
            <div className="text-xs text-slate-400 mb-3">{p.desc}</div>
            <Field label={isCouple ? "Combined Annual Income (Today's $)" : "Annual Income (Today's $)"} value={inputs[p.key]} onChange={v => setField(p.key, v)} />
          </div>
        ))}
      </div>
      <Explanation>
        These amounts are in today's dollars — the model automatically adjusts for inflation each year. Income transitions smoothly over 5 years between phases (ages 65–70 and 80–85) to avoid unrealistic spending cliffs. {isCouple ? "These are your combined household spending targets. Phases are based on the older partner's age." : "A common rule of thumb is 70% of pre-retirement income, declining about 20% per phase."}
      </Explanation>
    </div>
  );
}
