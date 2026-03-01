export const fmt = (n) => {
  if (n == null || isNaN(n)) return "$0";
  return "$" + Math.round(n).toLocaleString("en-CA");
};

export const fmtK = (n) => {
  if (n == null || isNaN(n)) return "$0";
  if (Math.abs(n) >= 1000000) return "$" + (n / 1000000).toFixed(1) + "M";
  if (Math.abs(n) >= 1000) return "$" + (n / 1000).toFixed(0) + "K";
  return "$" + Math.round(n);
};

export const pct = (n) => (n * 100).toFixed(1) + "%";

export function getNames(inputs) {
  const youName = inputs.name || "You";
  const partnerName = inputs.partner?.name || "Your Partner";
  const youPossessive = inputs.name ? `${inputs.name}'s` : "Your";
  const partnerPossessive = inputs.partner?.name ? `${inputs.partner.name}'s` : "Your Partner's";
  return { youName, partnerName, youPossessive, partnerPossessive };
}
