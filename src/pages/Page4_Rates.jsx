import { SectionTitle, Field, Explanation } from "../components.jsx";
import { PROVINCES } from "../tax.js";
import { fmt, pct } from "../formatters.js";

export default function Page4_Rates({ inputs, setField }) {
  const provData = PROVINCES[inputs.province] || PROVINCES.Ontario;
  return (
    <div>
      <SectionTitle icon="📊" title="Growth & Tax Assumptions"
        subtitle="These rates drive the compounding engine of your plan. Small differences in growth rate or inflation compound dramatically over 30+ years." />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
        <div>
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-4">Growth Rates</h3>
          <Field label="Pre-Retirement Growth Rate" value={inputs.preGrowth} onChange={v => setField("preGrowth", v)} type="percent" hint="Typically 5–8% for a balanced portfolio" />
          <Field label="Post-Retirement Growth Rate" value={inputs.postGrowth} onChange={v => setField("postGrowth", v)} type="percent" hint="Usually lower (3–5%) as you shift to conservative" />
          <Field label="Expected Inflation Rate" value={inputs.inflation} onChange={v => setField("inflation", v)} type="percent" hint="Bank of Canada targets 2%" />
          <div className="bg-slate-800/40 rounded-lg p-4 mt-2">
            <div className="flex justify-between text-sm"><span className="text-slate-400">Real return (pre-retirement)</span><span className="text-white font-medium">{pct(inputs.preGrowth - inputs.inflation)}</span></div>
            <div className="flex justify-between text-sm mt-1"><span className="text-slate-400">Real return (post-retirement)</span><span className="text-white font-medium">{pct(inputs.postGrowth - inputs.inflation)}</span></div>
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-amber-400/80 uppercase tracking-widest mb-4">Tax Brackets — {inputs.province}</h3>
          <div className="bg-slate-800/40 rounded-lg p-4 text-xs space-y-1.5">
            <div className="text-slate-500 uppercase tracking-wider mb-2 font-semibold">Federal (2026)</div>
            {inputs.fedBrackets.brackets.map(([t, r], i) => (
              <div key={i} className="flex justify-between"><span className="text-slate-400">{t === Infinity ? "Above" : `Up to ${fmt(t)}`}</span><span className="text-white">{(r * 100).toFixed(1)}%</span></div>
            ))}
            <div className="text-slate-500 uppercase tracking-wider mb-2 mt-4 font-semibold pt-3 border-t border-slate-700/40">Provincial — {inputs.province}</div>
            <div className="flex justify-between"><span className="text-slate-400">Personal amount</span><span className="text-amber-400">{fmt(provData.bpa)}</span></div>
            {provData.brackets.map(([t, r], i) => (
              <div key={i} className="flex justify-between"><span className="text-slate-400">{t === Infinity ? "Above" : `Up to ${fmt(t)}`}</span><span className="text-white">{(r * 100).toFixed(2)}%</span></div>
            ))}
          </div>
          <Explanation>
            Brackets are automatically inflation-adjusted in the projection. Both federal and provincial taxes are calculated progressively — you only pay the higher rate on income within that bracket, not on all your income.
          </Explanation>
        </div>
      </div>
    </div>
  );
}
