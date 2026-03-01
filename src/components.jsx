import { useState } from "react";
import { encodeShareData } from "./share.js";

// ═══════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════

export function Field({ label, value, onChange, type = "currency", min, max, step, hint }) {
  const handleChange = (e) => {
    let v = e.target.value;
    if (type === "currency") v = parseFloat(v.replace(/[^0-9.-]/g, "")) || 0;
    else if (type === "percent") v = parseFloat(v) / 100 || 0;
    else v = parseInt(v) || 0;
    onChange(v);
  };
  const displayVal = type === "currency" ? value : type === "percent" ? (value * 100).toFixed(1) : value;
  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-slate-300 mb-1.5 tracking-wide">{label}</label>
      <div className="relative">
        {type === "currency" && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-amber-400/60 text-sm">$</span>}
        <input
          type="number"
          value={displayVal}
          onChange={handleChange}
          min={min} max={max} step={step || (type === "percent" ? 0.1 : type === "number" ? 1 : 1000)}
          className="w-full bg-slate-800/80 border border-slate-600/50 rounded-lg px-3 py-2.5 text-white text-right focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400/50 transition-all"
          style={type === "currency" ? { paddingLeft: "1.5rem" } : type === "percent" ? { paddingRight: "2rem" } : {}}
        />
        {type === "percent" && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-amber-400/60 text-sm">%</span>}
      </div>
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

export function TextField({ label, value, onChange, placeholder, hint }) {
  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-slate-300 mb-1.5 tracking-wide">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-slate-800/80 border border-slate-600/50 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400/50 transition-all placeholder:text-slate-600"
      />
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

export function SelectField({ label, value, onChange, options }) {
  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-slate-300 mb-1.5 tracking-wide">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full bg-slate-800/80 border border-slate-600/50 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-amber-400/50 transition-all appearance-none">
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

export function StatCard({ label, value, sub, accent }) {
  return (
    <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-xl p-5 text-center">
      <div className="text-xs uppercase tracking-widest text-slate-400 mb-2">{label}</div>
      <div className={`text-2xl font-bold ${accent ? "text-amber-400" : "text-white"}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

export function SectionTitle({ icon, title, subtitle, action }) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-3xl">{icon}</span>
        <h2 className="text-2xl font-bold text-white" style={{ fontFamily: "'Playfair Display', serif" }}>{title}</h2>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {subtitle && <p className="text-slate-400 text-sm leading-relaxed max-w-2xl">{subtitle}</p>}
    </div>
  );
}

export function Explanation({ children }) {
  return (
    <div className="bg-slate-800/40 border-l-2 border-amber-400/40 rounded-r-lg px-4 py-3 my-4">
      <p className="text-sm text-slate-300 leading-relaxed">{children}</p>
    </div>
  );
}

export function ShareButton({ inputs, surplusMode }) {
  const [copied, setCopied] = useState(false);
  const handleShare = async () => {
    const encoded = encodeShareData(inputs, surplusMode);
    const url = `${window.location.origin}${window.location.pathname}?share=${encoded}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const t = document.createElement("textarea");
      t.value = url;
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      document.body.removeChild(t);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleShare}
      disabled={copied}
      className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 whitespace-nowrap ${
        copied
          ? "bg-emerald-400/15 text-emerald-400 border border-emerald-400/40 cursor-default"
          : "bg-slate-800/60 text-slate-400 border border-slate-700/40 hover:text-white hover:border-slate-600"
      }`}>
      <span>{copied ? "✓" : "🔗"}</span>
      <span>{copied ? "Copied to clipboard" : "Share"}</span>
    </button>
  );
}
