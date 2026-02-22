import { SectionTitle, TextField, Field, Explanation, SelectField } from "../components.jsx";
import { PROVINCES } from "../tax.js";

export default function Page1_Personal({ inputs, setField, personTab, isCouple, activePerson, activeSetField, names }) {
  const who = isCouple ? (personTab === "partner" ? names.partnerPossessive : names.youPossessive) : names.youPossessive;
  const whoLower = isCouple ? (personTab === "partner" ? (inputs.partner?.name ? `${inputs.partner.name}'s` : "your partner's") : (inputs.name ? `${inputs.name}'s` : "your")) : (inputs.name ? `${inputs.name}'s` : "your");
  return (
    <div>
      <SectionTitle icon="🍁" title={isCouple ? `${who} Details` : "Let's Plan Your Retirement"}
        subtitle={isCouple ? `Enter ${whoLower} personal details.` : "We'll start with some basics about you. These determine the time horizon for your savings to grow and how long your retirement income needs to last."} />

      {/* Mode selector — only show on "You" tab */}
      {(!isCouple || personTab === "you") && (
        <div className="mb-8">
          <label className="block text-sm font-medium text-slate-300 mb-2 tracking-wide">Who is this plan for?</label>
          <div className="grid grid-cols-2 gap-3 max-w-md">
            {[
              { key: "single", label: "Just Me", icon: "👤" },
              { key: "couple", label: "Me & My Partner", icon: "👫" },
            ].map(opt => (
              <button key={opt.key}
                onClick={() => setField("mode", opt.key)}
                className={`rounded-lg p-4 border text-left transition-all ${
                  inputs.mode === opt.key
                    ? "bg-amber-400/15 border-amber-400/50 text-white"
                    : "bg-slate-800/40 border-slate-700/40 text-slate-400 hover:border-slate-600"
                }`}>
                <div className="text-xl mb-1">{opt.icon}</div>
                <div className="text-sm font-semibold">{opt.label}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
        <div>
          <TextField
            label={isCouple ? (personTab === "partner" ? "Partner's Name" : "Your Name") : "Your Name"}
            value={personTab === "partner" ? (inputs.partner?.name || "") : (inputs.name || "")}
            onChange={v => personTab === "partner" ? activeSetField("name", v) : setField("name", v)}
            placeholder="Optional — leave blank for default labels"
            hint="Used in labels and results for sharing with others"
          />
          <Field label={`${who} Current Age`} value={activePerson.currentAge} onChange={v => activeSetField("currentAge", v)} type="number" min={18} max={80} hint="How old are you today?" />
          <Field label={`${who} Desired Retirement Age`} value={activePerson.retirementAge} onChange={v => activeSetField("retirementAge", v)} type="number" min={50} max={75} hint="When do you want to stop working?" />
          <Field label={`${who} Life Expectancy`} value={activePerson.lifeExpectancy} onChange={v => activeSetField("lifeExpectancy", v)} type="number" min={70} max={105} hint="Plan conservatively — the average Canadian lives to 82" />
          <Field label={`${who} Employment Income (Today's $)`} value={activePerson.employmentIncome} onChange={v => activeSetField("employmentIncome", v)} hint="Current annual salary or self-employment income" />
        </div>
        <div>
          {/* Province is shared — only show on "You" tab */}
          {personTab !== "partner" && (
            <>
              <SelectField label="Province of Residence" value={inputs.province} onChange={v => setField("province", v)} options={Object.keys(PROVINCES)} />
              <Explanation>
                Your province determines your tax brackets, which directly affect how much of your retirement income you keep. Tax optimization is one of the most impactful levers in retirement planning.
              </Explanation>
            </>
          )}
          <div className="mt-6 bg-gradient-to-br from-slate-800/60 to-slate-900/60 border border-slate-700/30 rounded-xl p-5">
            <div className="text-xs uppercase tracking-widest text-amber-400/70 mb-3">Planning Horizon</div>
            <div className="flex justify-between items-end">
              <div><div className="text-3xl font-bold text-white">{activePerson.retirementAge - activePerson.currentAge}</div><div className="text-xs text-slate-400">years to save</div></div>
              <div className="text-slate-600 text-2xl">→</div>
              <div><div className="text-3xl font-bold text-amber-400">{activePerson.lifeExpectancy - activePerson.retirementAge}</div><div className="text-xs text-slate-400">years in retirement</div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
