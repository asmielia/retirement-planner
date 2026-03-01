import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import { DEFAULTS, PARTNER_DEFAULTS, STORAGE_KEY, SURPLUS_STORAGE_KEY } from "./constants.js";

export function encodeShareData(inputs, surplusMode) {
  const { fedBrackets, ...rest } = inputs;
  return compressToEncodedURIComponent(JSON.stringify({ ...rest, surplusMode }));
}

export function decodeShareData(encoded) {
  try {
    const json = decompressFromEncodedURIComponent(encoded);
    if (!json) return null;
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const { surplusMode, ...fields } = parsed;
    return {
      inputs: {
        ...DEFAULTS,
        ...fields,
        fedBrackets: DEFAULTS.fedBrackets,
        partner: { ...PARTNER_DEFAULTS, ...(fields.partner || {}) },
      },
      surplusMode: surplusMode || "max_estate",
    };
  } catch (e) { return null; }
}

export function loadSavedInputs() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        ...DEFAULTS,
        ...parsed,
        fedBrackets: DEFAULTS.fedBrackets,
        partner: { ...PARTNER_DEFAULTS, ...(parsed.partner || {}) },
      };
    }
  } catch (e) { /* ignore corrupt data */ }
  return DEFAULTS;
}

export function loadSurplusMode() {
  try {
    const saved = localStorage.getItem(SURPLUS_STORAGE_KEY);
    if (saved === "boost_spending" || saved === "max_estate" || saved === "retire_early") return saved;
  } catch (e) { /* ignore */ }
  return "max_estate";
}
