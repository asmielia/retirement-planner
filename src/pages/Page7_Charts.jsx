import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from "recharts";
import { SectionTitle, Explanation, ShareButton } from "../components.jsx";
import { fmt, fmtK } from "../formatters.js";

export default function Page7_Charts({ inputs, results, surplusMode, setSurplusMode, isCouple, chartView, setChartView, names, isSharedView }) {
  // Determine the effective retirement age for filtering
  const youRetAge = surplusMode === "retire_early" && results.earlyYouRetirementAge != null
    ? results.earlyYouRetirementAge
    : surplusMode === "retire_early" && results.earlyRetirementAge != null
      ? results.earlyRetirementAge : inputs.retirementAge;
  const pRetAge = surplusMode === "retire_early" && results.earlyPartnerRetirementAge != null
    ? results.earlyPartnerRetirementAge : inputs.partner?.retirementAge;
  const retAge = isCouple
    ? chartView === "you" ? youRetAge
      : chartView === "partner" ? pRetAge
      : Math.min(youRetAge, pRetAge)
    : youRetAge;

  const chartData = results.rows.map((r, idx) => {
    const src = isCouple && chartView === "you" ? r.you : isCouple && chartView === "partner" ? r.partner : r;
    const portfolio = src.totalPortfolio ?? r.totalPortfolio;
    const infFactor = Math.pow(1 + (inputs.inflation || 0.02), idx + 1);
    const displayAge = isCouple
      ? chartView === "you" ? r.youAge : chartView === "partner" ? r.partnerAge : r.age
      : r.age;
    // Subtract RRSP→TFSA rebalance from rrspWd so gross income chart shows only the spending portion
    const transfer = src.rrspToTfsaTransfer ?? r.rrspToTfsaTransfer ?? 0;
    return {
      age: displayAge, youAge: r.youAge, partnerAge: r.partnerAge,
      portfolio, real: chartView === "combined" || !isCouple ? r.realPortfolio : portfolio / infFactor,
      rrsp: src.rrsp, tfsa: src.tfsa, nonReg: src.nonReg, savings: src.savings,
      cpp: src.cpp, oas: src.oasGross, pension: src.pension, bridge: src.bridge, other: src.other,
      employment: src.employment ?? r.employment ?? 0,
      savWd: src.savWd, nrWd: src.nrWd, rrspWd: Math.max(0, src.rrspWd - transfer), tfsaWd: src.tfsaWd,
      tax: src.totalTax ?? r.totalTax, clawback: src.oasClawback ?? r.oasClawback, net: src.netIncome ?? r.netIncome, desired: r.desiredNominal,
      // Per-partner breakdowns for couple mode
      youTax: r.you?.totalTax ?? 0, youClawback: r.you?.oasClawback ?? 0, youNet: r.you?.netIncome ?? 0,
      partnerTax: r.partner?.totalTax ?? 0, partnerClawback: r.partner?.oasClawback ?? 0, partnerNet: r.partner?.netIncome ?? 0,
    };
  });
  const retData = chartData.filter(d => d.age >= retAge);
  const hasEmployment = retData.some(d => d.employment > 0);
  const showDualAge = isCouple && chartView === "combined" && inputs.currentAge !== inputs.partner.currentAge;
  const ttStyle = { backgroundColor: "#1e293b", border: "1px solid #334155", borderRadius: "8px", fontSize: 12 };

  const DualAgeTick = ({ x, y, payload }) => {
    const d = chartData.find(dd => dd.age === payload.value);
    if (!d) return null;
    return (
      <g transform={`translate(${x},${y})`}>
        <text x={0} y={0} dy={12} textAnchor="middle" fill="#94a3b8" fontSize={10}>{d.youAge}</text>
        <text x={0} y={0} dy={24} textAnchor="middle" fill="#64748b" fontSize={9}>{d.partnerAge}</text>
      </g>
    );
  };

  const xAxisProps = showDualAge
    ? { dataKey: "age", tick: <DualAgeTick />, height: 40, interval: "preserveStartEnd" }
    : { dataKey: "age", tick: { fill: "#94a3b8", fontSize: 11 } };

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    return (
      <div style={ttStyle} className="p-3 shadow-xl">
        {isCouple && chartView === "combined" && d ? (
          <div className="text-amber-400 font-semibold mb-1">{names.youName}: {d.youAge} / {names.partnerName}: {d.partnerAge}</div>
        ) : (
          <div className="text-amber-400 font-semibold mb-1">Age {label}</div>
        )}
        {payload.map((p, i) => (
          <div key={i} className="flex justify-between gap-4">
            <span style={{ color: p.color }}>{p.name}</span>
            <span className="text-white font-medium">{fmtK(p.value)}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div>
      <SectionTitle icon="📈" title="Detailed Projections"
        subtitle="Visual breakdowns of how your wealth grows, where your retirement income comes from, and how tax optimization protects your money."
        action={!isSharedView && <ShareButton inputs={inputs} surplusMode={surplusMode} />} />

      {/* Sticky surplus mode toggle */}
      {results.hasSurplus && (
        <div className="sticky top-[52px] z-40 -mx-4 px-4 py-3 bg-slate-900/95 backdrop-blur border-b border-slate-800/60 mb-6">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-400">Viewing projections for:</span>
            <div className="flex gap-2">
              {[
                { key: "max_estate", label: "Maximize Estate", icon: "🏠" },
                { key: "boost_spending", label: "Increase Spending", icon: "✈️" },
                { key: "retire_early", label: "Retire Earlier", icon: "⏰" },
              ].map(opt => (
                <button key={opt.key}
                  onClick={() => setSurplusMode(opt.key)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${
                    surplusMode === opt.key
                      ? "bg-amber-400/15 text-amber-400 border border-amber-400/40"
                      : "bg-slate-800/60 text-slate-400 border border-slate-700/40 hover:text-white hover:border-slate-600"
                  }`}>
                  <span>{opt.icon}</span>
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Couple chart view toggle */}
      {isCouple && (
        <div className="flex items-center justify-end gap-2 mb-4">
          <span className="text-sm text-slate-400">View:</span>
          {[
            { key: "combined", label: "Combined" },
            { key: "you", label: names.youName },
            { key: "partner", label: names.partnerName },
          ].map(opt => (
            <button key={opt.key}
              onClick={() => setChartView(opt.key)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                chartView === opt.key
                  ? "bg-amber-400/15 text-amber-400 border border-amber-400/40"
                  : "bg-slate-800/60 text-slate-400 border border-slate-700/40 hover:text-white"
              }`}>
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {showDualAge && (
        <div className="text-xs text-slate-500 mb-2 text-right">X-axis: <span className="text-slate-400">{names.youPossessive} age</span> / <span className="text-slate-500">{names.partnerPossessive} age</span></div>
      )}

      {/* Chart 1: Portfolio */}
      <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-5 mb-8">
        <h3 className="text-sm font-semibold text-white mb-1">Portfolio Value Over Time</h3>
        <p className="text-xs text-slate-400 mb-4">Nominal value and inflation-adjusted (real) value in today's dollars</p>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="gPort" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#2563eb" stopOpacity={0.3}/><stop offset="95%" stopColor="#2563eb" stopOpacity={0}/></linearGradient>
              <linearGradient id="gReal" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#22c55e" stopOpacity={0.3}/><stop offset="95%" stopColor="#22c55e" stopOpacity={0}/></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis {...xAxisProps} />
            <YAxis tickFormatter={fmtK} tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="portfolio" name="Nominal" stroke="#2563eb" fill="url(#gPort)" />
            <Area type="monotone" dataKey="real" name="Real (Today's $)" stroke="#22c55e" fill="url(#gReal)" />
          </AreaChart>
        </ResponsiveContainer>
        <Explanation>The gap between nominal and real value shows the erosive effect of inflation. Even at 2%, your purchasing power is roughly halved over 35 years.</Explanation>
      </div>

      {/* Chart 2: Account Breakdown */}
      <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-5 mb-8">
        <h3 className="text-sm font-semibold text-white mb-1">Account Breakdown</h3>
        <p className="text-xs text-slate-400 mb-4">How your wealth is distributed across account types over time</p>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis {...xAxisProps} />
            <YAxis tickFormatter={fmtK} tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="rrsp" name="RRSP" stackId="1" stroke="#1e3a5f" fill="#1e3a5f" />
            <Area type="monotone" dataKey="tfsa" name="TFSA" stackId="1" stroke="#2563eb" fill="#2563eb" />
            <Area type="monotone" dataKey="nonReg" name="Non-Reg" stackId="1" stroke="#22c55e" fill="#22c55e" />
            <Area type="monotone" dataKey="savings" name="Savings" stackId="1" stroke="#eab308" fill="#eab308" />
          </AreaChart>
        </ResponsiveContainer>
        <Explanation>Notice how cash savings and non-registered funds are depleted first in retirement, while TFSA is preserved longest — maximizing tax-free compounding.</Explanation>
      </div>

      {/* Chart 3: Income Sources */}
      <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-5 mb-8">
        <h3 className="text-sm font-semibold text-white mb-1">Gross Retirement Income Sources</h3>
        <p className="text-xs text-slate-400 mb-4">Where your retirement income comes from each year (before tax)</p>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={retData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis {...xAxisProps} />
            <YAxis tickFormatter={fmtK} tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {hasEmployment && <Bar dataKey="employment" name="Employment" stackId="1" fill="#f59e0b" />}
            <Bar dataKey="cpp" name="CPP" stackId="1" fill="#1e3a5f" />
            <Bar dataKey="oas" name="OAS" stackId="1" fill="#2563eb" />
            <Bar dataKey="pension" name="Pension" stackId="1" fill="#0891b2" />
            <Bar dataKey="bridge" name="Bridge" stackId="1" fill="#06b6d4" />
            <Bar dataKey="other" name="Other" stackId="1" fill="#8b5cf6" />
            <Bar dataKey="savWd" name="Savings" stackId="1" fill="#eab308" />
            <Bar dataKey="nrWd" name="Non-Reg" stackId="1" fill="#22c55e" />
            <Bar dataKey="rrspWd" name="RRSP" stackId="1" fill="#dc2626" />
            <Bar dataKey="tfsaWd" name="TFSA" stackId="1" fill="#a855f7" />
          </BarChart>
        </ResponsiveContainer>
        <Explanation>
          {hasEmployment ? "Employment income from the working partner is shown until they retire. " : ""}
          CPP, OAS, pension, and other guaranteed income form the foundation. The bridge benefit covers the gap before age 65. Portfolio withdrawals fill the remainder, with the tax-optimized strategy keeping RRSP withdrawals moderate to avoid OAS clawback.
        </Explanation>
      </div>

      {/* Chart 3b: Net Retirement Income */}
      <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-5 mb-8">
        <h3 className="text-sm font-semibold text-white mb-1">Net Retirement Income</h3>
        <p className="text-xs text-slate-400 mb-4">Take-home income after federal + provincial tax and OAS clawback{isCouple ? ", broken down per partner" : ""}</p>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={retData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis {...xAxisProps} />
            <YAxis tickFormatter={fmtK} tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {isCouple && chartView === "combined" ? (
              <>
                <Bar dataKey="youNet" name={names.youName} stackId="1" fill="#2563eb" />
                <Bar dataKey="partnerNet" name={names.partnerName} stackId="1" fill="#22c55e" />
              </>
            ) : (
              <Bar dataKey="net" name="Net Income" fill="#22c55e" />
            )}
          </BarChart>
        </ResponsiveContainer>
        <Explanation>This is your actual spendable income — what remains after all taxes and OAS recovery tax are deducted from gross income{isCouple ? ". The per-partner split shows each person's contribution to household income" : ""}.</Explanation>
      </div>

      {/* Chart 4: Tax Impact */}
      <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-5 mb-8">
        <h3 className="text-sm font-semibold text-white mb-1">Tax & OAS Clawback</h3>
        <p className="text-xs text-slate-400 mb-4">Annual combined federal + provincial taxes{hasEmployment ? " (including on employment income)" : ""} and any OAS recovery tax{isCouple && chartView === "combined" ? ", broken down per partner" : ""}</p>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={retData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis {...xAxisProps} />
            <YAxis tickFormatter={fmtK} tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {isCouple && chartView === "combined" ? (
              <>
                <Bar dataKey="youTax" name={`${names.youName} Tax`} stackId="1" fill="#dc2626" />
                <Bar dataKey="youClawback" name={`${names.youName} Clawback`} stackId="1" fill="#f97316" />
                <Bar dataKey="partnerTax" name={`${names.partnerName} Tax`} stackId="1" fill="#991b1b" />
                <Bar dataKey="partnerClawback" name={`${names.partnerName} Clawback`} stackId="1" fill="#c2410c" />
              </>
            ) : (
              <>
                <Bar dataKey="tax" name="Fed + Prov Tax" stackId="1" fill="#dc2626" />
                <Bar dataKey="clawback" name="OAS Clawback" stackId="1" fill="#f97316" />
              </>
            )}
          </BarChart>
        </ResponsiveContainer>
        <Explanation>The withdrawal strategy keeps your taxable income below the OAS clawback threshold ({fmt(inputs.oasClawbackThreshold)} in today's dollars), preserving your full OAS benefit. Without optimization, high-income retirees can lose thousands per year to clawback.</Explanation>
      </div>

      {/* Year by Year Table */}
      <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-white mb-4">Year-by-Year Projection</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 border-b border-slate-700/50">
                {[...(isCouple && chartView === "combined" ? [names.youName, names.partnerName] : ["Age"]),
                  "Phase","Portfolio","CPP","OAS",
                  ...(inputs.pensionIncome > 0 || (isCouple && inputs.partner.pensionIncome > 0) ? ["Pension"] : []),
                  ...(inputs.pensionBridge > 0 && inputs.retirementAge < 65 ? ["Bridge"] : []),
                  ...((isCouple ? Math.max(inputs.otherIncome, inputs.partner.otherIncome) : inputs.otherIncome) > 0 ? ["Other"] : []),
                  ...(hasEmployment ? ["Employ"] : []),
                  "Sav Wd","NR Wd","RRSP Wd","TFSA Wd","Taxable","Tax","Clawback","Net Income"].map(h => (
                  <th key={h} className="px-2 py-2 text-right font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.rows.filter(r => {
                const dispAge = isCouple && chartView === "you" ? r.youAge : isCouple && chartView === "partner" ? r.partnerAge : r.age;
                return dispAge >= retAge;
              }).map(r => {
                const s = isCouple && chartView === "you" ? r.you : isCouple && chartView === "partner" ? r.partner : r;
                const dispAge = isCouple && chartView === "you" ? r.youAge : isCouple && chartView === "partner" ? r.partnerAge : r.age;
                const xfer = s.rrspToTfsaTransfer ?? r.rrspToTfsaTransfer ?? 0;
                return (
                  <tr key={r.age} className="border-b border-slate-800/50 hover:bg-slate-700/20">
                    {isCouple && chartView === "combined" ? (
                      <><td className="px-2 py-1.5 text-white font-medium">{r.youAge}</td><td className="px-2 py-1.5 text-slate-400">{r.partnerAge}</td></>
                    ) : (
                      <td className="px-2 py-1.5 text-white font-medium">{dispAge}</td>
                    )}
                    <td className="px-2 py-1.5 text-slate-400">{r.phase}</td>
                    {[s.totalPortfolio ?? r.totalPortfolio, s.cpp, s.oasGross,
                      ...(inputs.pensionIncome > 0 || (isCouple && inputs.partner.pensionIncome > 0) ? [s.pension] : []),
                      ...(inputs.pensionBridge > 0 && inputs.retirementAge < 65 ? [s.bridge] : []),
                      ...((isCouple ? Math.max(inputs.otherIncome, inputs.partner.otherIncome) : inputs.otherIncome) > 0 ? [s.other] : []),
                      ...(hasEmployment ? [s.employment ?? r.employment ?? 0] : []),
                      s.savWd, s.nrWd, Math.max(0, s.rrspWd - xfer), s.tfsaWd,
                      s.taxableIncome ?? r.taxableIncome, s.totalTax ?? r.totalTax, s.oasClawback ?? r.oasClawback, s.netIncome ?? r.netIncome].map((v,i) => (
                      <td key={i} className="px-2 py-1.5 text-right text-slate-300">{fmtK(v)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
