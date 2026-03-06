import { useState, useRef, useEffect } from "react";
const fmtCents = (n) => {
  if (n == null || isNaN(n)) return "$0.00";
  return "$" + Number(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
import { ANTHROPIC_API_KEY_STORAGE_KEY, T4_DATA_STORAGE_KEY } from "./constants.js";
import { fileToBase64Image, callClaudeVision, parseT4Response } from "./t4Parser.js";

const BOX_LABELS = {
  box14: { num: "14", label: "Employment Income" },
  box16: { num: "16", label: "Employee's CPP Contributions" },
  box18: { num: "18", label: "Employee's EI Premiums" },
  box20: { num: "20", label: "RPP Contributions" },
  box22: { num: "22", label: "Income Tax Deducted" },
  box24: { num: "24", label: "EI Insurable Earnings" },
  box26: { num: "26", label: "CPP/QPP Pensionable Earnings" },
  box44: { num: "44", label: "Union Dues" },
  box52: { num: "52", label: "Pension Adjustment" },
};

export default function T4UploadButton({ onIncomeExtracted }) {
  const fileInputRef = useRef(null);
  const [status, setStatus] = useState("idle"); // idle | loading | success | error
  const [error, setError] = useState(null);
  const [t4Data, setT4Data] = useState(() => {
    try {
      const saved = localStorage.getItem(T4_DATA_STORAGE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(ANTHROPIC_API_KEY_STORAGE_KEY) || "");
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState(null);
  const [showFullImage, setShowFullImage] = useState(false);
  const pendingFileRef = useRef(null);

  // Persist T4 data to localStorage
  useEffect(() => {
    if (t4Data) {
      localStorage.setItem(T4_DATA_STORAGE_KEY, JSON.stringify(t4Data));
    }
  }, [t4Data]);

  function handleButtonClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset file input so same file can be re-uploaded
    e.target.value = "";

    const validTypes = ["application/pdf", "image/jpeg", "image/png"];
    if (!validTypes.includes(file.type)) {
      setStatus("error");
      setError("Please upload a PDF, JPG, or PNG file.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setStatus("error");
      setError("File is too large. Please upload a file under 10 MB.");
      return;
    }

    const key = apiKey || localStorage.getItem(ANTHROPIC_API_KEY_STORAGE_KEY) || "";
    if (!key) {
      pendingFileRef.current = file;
      setKeyInput("");
      setShowKeyModal(true);
      return;
    }

    processFile(file, key);
  }

  function handleKeySave() {
    const key = keyInput.trim();
    if (!key) return;
    localStorage.setItem(ANTHROPIC_API_KEY_STORAGE_KEY, key);
    setApiKey(key);
    setShowKeyModal(false);

    if (pendingFileRef.current) {
      const file = pendingFileRef.current;
      pendingFileRef.current = null;
      processFile(file, key);
    }
  }

  function handleKeyCancel() {
    setShowKeyModal(false);
    pendingFileRef.current = null;
  }

  async function processFile(file, key) {
    setStatus("loading");
    setError(null);
    setT4Data(null);
    setImageDataUrl(null);

    try {
      const { base64, mediaType } = await fileToBase64Image(file);
      setImageDataUrl(`data:${mediaType};base64,${base64}`);
      const responseText = await callClaudeVision(base64, mediaType, key);
      const data = parseT4Response(responseText);

      setT4Data(data);
      setStatus("success");
      onIncomeExtracted(data.box14);
    } catch (err) {
      setStatus("error");
      setError(err.message);

      // Clear API key on auth errors so user is re-prompted
      if (err.message.includes("Invalid API key")) {
        localStorage.removeItem(ANTHROPIC_API_KEY_STORAGE_KEY);
        setApiKey("");
      }
    }
  }

  function dismiss() {
    setStatus("idle");
    setError(null);
  }

  return (
    <div className="mb-4">
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png"
        className="hidden"
        onChange={handleFileChange}
      />

      <button
        onClick={handleButtonClick}
        disabled={status === "loading"}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
          bg-slate-800/60 border border-slate-700/40 text-slate-300
          hover:border-amber-400/50 hover:text-amber-400 transition-all
          disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {status === "loading" ? (
          <>
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Parsing T4...
          </>
        ) : (
          <>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            Upload a T4
          </>
        )}
      </button>

      <button
          onClick={() => { setKeyInput(apiKey); setShowKeyModal(true); }}
          className="inline-flex items-center gap-1 px-3 py-2 ml-2 rounded-lg text-xs
            text-slate-500 hover:text-slate-300 transition-colors"
          title="Update Anthropic API key"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
          </svg>
          API Key
        </button>

      {/* API Key Modal */}
      {showKeyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-md mx-4 shadow-xl">
            <h3 className="text-white font-semibold text-lg mb-2">Anthropic API Key Required</h3>
            <p className="text-slate-400 text-sm mb-4">
              To parse T4 documents, an Anthropic API key is needed. Your key is stored locally in your browser and never sent to any server other than Anthropic's API.
            </p>
            <input
              type="password"
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleKeySave()}
              placeholder="sk-ant-..."
              className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-600 text-white text-sm
                placeholder-slate-500 focus:outline-none focus:border-amber-400/50 mb-4"
              autoFocus
            />
            <div className="flex gap-3 justify-end">
              <button onClick={handleKeyCancel}
                className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white transition-colors">
                Cancel
              </button>
              <button onClick={handleKeySave}
                disabled={!keyInput.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-amber-400/15 border border-amber-400/50 text-amber-400
                  hover:bg-amber-400/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                Save & Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image Preview */}
      {imageDataUrl && (status === "success" || status === "loading") && (
        <>
          <div className="mt-3 mb-2">
            <div className="text-xs text-slate-500 mb-1">Scanned image sent to API:</div>
            <img
              src={imageDataUrl}
              alt="Scanned T4"
              onClick={() => setShowFullImage(true)}
              className="max-h-40 rounded-lg border border-slate-700/40 cursor-pointer hover:border-slate-500 transition-colors"
            />
          </div>
          {showFullImage && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-pointer"
              onClick={() => setShowFullImage(false)}
            >
              <img
                src={imageDataUrl}
                alt="Scanned T4 (full size)"
                className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
                onClick={e => e.stopPropagation()}
              />
              <button
                onClick={() => setShowFullImage(false)}
                className="absolute top-4 right-4 text-white/70 hover:text-white text-2xl"
              >&times;</button>
            </div>
          )}
        </>
      )}

      {/* Success Box */}
      {status === "success" && t4Data && (
        <div className="mt-3 bg-emerald-900/20 border border-emerald-400/30 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-emerald-400 text-sm font-semibold">T4 Parsed Successfully</span>
              {t4Data.employerName && <span className="text-slate-400 text-xs">— {t4Data.employerName}</span>}
              {t4Data.taxYear && <span className="text-slate-500 text-xs">({t4Data.taxYear})</span>}
            </div>
            <button onClick={dismiss} className="text-slate-500 hover:text-slate-300 text-xs">dismiss</button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {Object.entries(BOX_LABELS).map(([key, { num, label }]) => {
              const value = t4Data[key];
              if (value == null) return null;
              const isBox14 = key === "box14";
              return (
                <div key={key} className={`rounded-lg px-3 py-2 text-xs ${
                  isBox14
                    ? "bg-amber-400/10 border border-amber-400/30"
                    : "bg-slate-800/40 border border-slate-700/30"
                }`}>
                  <div className={`font-mono ${isBox14 ? "text-amber-400" : "text-slate-500"}`}>Box {num}</div>
                  <div className={`font-semibold ${isBox14 ? "text-amber-300" : "text-slate-300"}`}>{fmtCents(value)}</div>
                  <div className="text-slate-500 truncate">{label}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Error Box */}
      {status === "error" && error && (
        <div className="mt-3 bg-red-900/20 border border-red-400/30 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-red-400 text-sm">{error}</span>
            <button onClick={dismiss} className="text-slate-500 hover:text-slate-300 text-xs ml-3">dismiss</button>
          </div>
        </div>
      )}
    </div>
  );
}
