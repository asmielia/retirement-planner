/**
 * T4 Tax Slip Parser — converts PDF/JPG/PNG to base64, sends to Claude Vision API,
 * and parses the structured response.
 */

/**
 * Convert a File (PDF, JPG, or PNG) to a base64-encoded image suitable for Claude Vision.
 * PDFs are rendered to canvas at 2× scale and exported as PNG.
 */
export async function fileToBase64Image(file) {
  const type = file.type;

  if (type === "application/pdf") {
    const pdfjsLib = await import("pdfjs-dist");
    const workerModule = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default;

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(1);

    const scale = 3;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;

    const dataUrl = canvas.toDataURL("image/png");
    return { base64: dataUrl.split(",")[1], mediaType: "image/png" };
  }

  // JPG or PNG — read directly
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(",")[1];
      const mediaType = type === "image/jpeg" ? "image/jpeg" : "image/png";
      resolve({ base64, mediaType });
    };
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}

/**
 * Send a base64 image to Claude Vision API via the Vite dev proxy and request T4 parsing.
 */
export async function callClaudeVision(base64, mediaType, apiKey) {
  const response = await fetch("/api/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            {
              type: "text",
              text: `This is a Canadian T4 Statement of Remuneration Paid. Each box on a T4 has a box number printed next to it. Read each box number carefully and match it to the correct value.

IMPORTANT:
- Each box is labeled with its number (e.g., "14", "16", "18", etc.). Match the NUMBER printed on the form, not the position.
- Transcribe each dollar amount EXACTLY as printed, digit by digit. Do not round or approximate.
- Include cents if shown (e.g., 152567.45, not 152567 or 125568).

Extract these specific boxes:
- Box 14: Employment income
- Box 16: Employee's CPP/QPP contributions
- Box 18: Employee's EI premiums
- Box 20: RPP contributions
- Box 22: Income tax deducted
- Box 24: EI insurable earnings
- Box 26: CPP/QPP pensionable earnings
- Box 44: Union dues
- Box 52: Pension adjustment

Also extract the employer name and tax year from the top of the slip.

Return ONLY a JSON object (no markdown, no explanation):
{"isT4":true,"employerName":"...","taxYear":2025,"box14":0.00,"box16":0.00,"box18":0.00,"box20":0.00,"box22":0.00,"box24":null,"box26":null,"box44":null,"box52":null}

Use null for any box not visible. Set isT4 to false if this is not a T4.`,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error("Invalid API key. Please check your Anthropic API key and try again.");
    if (response.status === 429) throw new Error("Rate limit exceeded. Please wait a moment and try again.");
    const body = await response.text().catch(() => "");
    throw new Error(`API error (${response.status}): ${body || response.statusText}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error("No response content from Claude API");
  return text;
}

/**
 * Parse Claude's JSON text response into a structured T4 data object.
 */
export function parseT4Response(text) {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Failed to parse T4 data from response");
  }

  if (!parsed.isT4) {
    throw new Error("This document does not appear to be a Canadian T4 tax slip");
  }
  if (parsed.box14 == null) {
    throw new Error("Could not read Box 14 (Employment Income) from the T4");
  }

  return {
    employerName: parsed.employerName || null,
    taxYear: parsed.taxYear || null,
    box14: Number(parsed.box14),
    box16: parsed.box16 != null ? Number(parsed.box16) : null,
    box18: parsed.box18 != null ? Number(parsed.box18) : null,
    box20: parsed.box20 != null ? Number(parsed.box20) : null,
    box22: parsed.box22 != null ? Number(parsed.box22) : null,
    box24: parsed.box24 != null ? Number(parsed.box24) : null,
    box26: parsed.box26 != null ? Number(parsed.box26) : null,
    box44: parsed.box44 != null ? Number(parsed.box44) : null,
    box52: parsed.box52 != null ? Number(parsed.box52) : null,
  };
}
