const express = require("express");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const app = express();
let cachedWorkingModel = null;

const systemInstruction =
  'Analyze the product image(s). Return ONLY the text in this format per line: [quantity] [bottle(s)|box(es)] [Brand Name] [Dosage/Size]. If there are multiple medicines, return one line per distinct product. BRAND RULE: Use only the brand/trade name shown on the packaging. Do NOT include generic/active ingredient names. QUANTITY RULES: Count how many separate identical units of the same product appear and use that as the quantity prefix. PACK TYPE RULES: use "bottle/bottles" for liquid volume products in mL, and use "box/boxes" for everything else (including tablet/capsule products). Keep brand names complete and dosage/size complete (mg, mL, g, tabs, etc.) when visible. Always write milliliters as "mL". Do not include packaging words other than box(es)/bottle(s). Example outputs: "5 boxes Foskina 5g", "5 bottles Pecof Syrup 100 mL", "1 box Iberet Active 100 tabs".';

function cleanModelText(value) {
  return String(value || "").trim().replace(/^["']|["']$/g, "");
}

/** Normalize milliliter unit to mL (e.g. 200 ml → 200 mL). */
function normalizeMlUnits(value) {
  return String(value || "").replace(/\b(\d+)\s*ml\b/gi, "$1 mL");
}

/** Strip leading quantity + box/bottles without changing product text. */
function stripBoxBottlePrefix(line) {
  return String(line || "")
    .trim()
    .replace(/^\d+\s+(box|boxes|bottle|bottles)\s+/i, "")
    .replace(/^(box|boxes|bottle|bottles)\s+/i, "")
    .trim();
}

function kindFromProductText(rest) {
  const hasMl = /\d+\s*mL\b/i.test(rest);
  if (hasMl) return "bottle";
  return "box";
}

function formatQtyKind(qty, kind) {
  const n = Math.max(1, parseInt(String(qty), 10) || 1);
  if (kind === "bottle") {
    return n === 1 ? "1 bottle" : `${n} bottles`;
  }
  if (kind === "box") {
    return n === 1 ? "1 box" : `${n} boxes`;
  }
  return n === 1 ? "1 box" : `${n} boxes`;
}

/**
 * Parse lines, merge duplicate same-product lines (sum quantities), normalize box/bottle from mg/mL.
 */
function mergeFormatQuantityPrefixes(value) {
  const rawLines = cleanModelText(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const groups = new Map();

  for (const line of rawLines) {
    let qty = 1;
    let rest = line;
    const numbered = line.match(/^(\d+)\s+(box|boxes|bottle|bottles)\s+(.+)$/i);
    if (numbered) {
      qty = parseInt(numbered[1], 10) || 1;
      rest = numbered[3].trim();
    } else {
      rest = stripBoxBottlePrefix(line);
    }

    // Ignore OCR fragments like "3", "100", or empty/no-brand lines.
    const hasLetters = /[a-z]/i.test(rest);
    const isOnlyNumbersOrSymbols = /^[\d\s./%-]+$/.test(rest);
    if (!rest || !hasLetters || isOnlyNumbersOrSymbols) {
      continue;
    }

    const kind = kindFromProductText(rest);
    const key = `${rest.toLowerCase().replace(/\s+/g, " ")}|${kind}`;
    const prev = groups.get(key);
    if (prev) {
      prev.qty += qty;
    } else {
      groups.set(key, { qty, kind, rest });
    }
  }

  return Array.from(groups.values())
    .map(({ qty, kind, rest }) => `${formatQtyKind(qty, kind)} ${rest}`)
    .join("\n");
}

const GENERIC_NAME_PHRASES = [
  "cefuroxime axetil",
  "paracetamol",
  "ibuprofen",
  "amoxicillin",
  "azithromycin",
  "ciprofloxacin",
  "metformin",
  "omeprazole",
  "cetirizine",
  "loratadine",
  "salbutamol",
  "dextromethorphan",
  "guaifenesin",
  "phenylephrine",
  "diphenhydramine",
  "hydrochloride",
  "hcl",
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripGenericNameFragments(value) {
  const lines = cleanModelText(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines
    .map((line) => {
      const prefixMatch = line.match(/^(\d+\s+(?:box|boxes|bottle|bottles)\s+)/i);
      const prefix = prefixMatch ? prefixMatch[1] : "";
      let body = prefix ? line.slice(prefix.length) : line;

      for (const phrase of GENERIC_NAME_PHRASES) {
        const pattern = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "ig");
        body = body.replace(pattern, " ");
      }

      body = body.replace(/\(\s*\)/g, " ").replace(/\s{2,}/g, " ").trim();
      return `${prefix}${body}`.trim();
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

async function generateWithModelFallback(genAI, modelNames, promptParts) {
  let lastError;
  for (const modelName of modelNames) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction,
        generationConfig: {
          responseMimeType: "text/plain",
          temperature: 0,
          topP: 0.1,
          maxOutputTokens: 512,
        },
      });
      const result = await model.generateContent(promptParts);
      cachedWorkingModel = modelName;
      return { result, modelName };
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || "");
      const isModelUnavailable =
        error?.status === 404 ||
        /NOT_FOUND|not found|not supported for generateContent|unsupported model|invalid model/i.test(msg);
      if (!isModelUnavailable) {
        throw error;
      }
    }
  }
  throw lastError || new Error("No available Gemini model succeeded.");
}

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "../public")));

app.post("/identify", async (req, res) => {
  try {
    const { imageBase64, imagesBase64 } = req.body;
    const incomingImages = Array.isArray(imagesBase64) ? imagesBase64 : [imageBase64];
    const validImages = incomingImages.filter((image) => typeof image === "string" && image.trim().length > 0);

    if (validImages.length === 0) {
      return res.status(400).json({ error: "At least one base64 image is required." });
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "Missing GEMINI_API_KEY or GOOGLE_API_KEY environment variable.",
      });
    }

    const allowedMimeTypes = new Set([
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/heic",
      "image/heif",
    ]);
    const imageParts = validImages.map((imageBase64Value) => {
      const trimmed = imageBase64Value.trim();
      const anyDataUrlMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
      const mimeType = anyDataUrlMatch ? String(anyDataUrlMatch[1]).toLowerCase() : "image/jpeg";
      const base64Data = anyDataUrlMatch ? anyDataUrlMatch[2] : trimmed;

      if (!allowedMimeTypes.has(mimeType)) {
        const unsupportedErr = new Error(
          `Unsupported image format: ${mimeType}. Please upload JPG, PNG, WEBP, GIF, HEIC, or HEIF.`
        );
        unsupportedErr.status = 400;
        throw unsupportedErr;
      }

      return {
        inlineData: {
          data: base64Data,
          mimeType: mimeType === "image/jpg" ? "image/jpeg" : mimeType,
        },
      };
    });

    const genAI = new GoogleGenerativeAI(apiKey);
    const preferredModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const fallbackModels = [
      cachedWorkingModel,
      preferredModel,
      "gemini-2.5-flash",
      "gemini-1.5-flash",
    ].filter((v, i, arr) => v && arr.indexOf(v) === i);
    const promptParts = [
      ...imageParts,
      "Cross-check all images before final output. Count identical separate units of the same product (e.g. 2 same bottles) and use that quantity in the line prefix. Prefer complete medicine lines only; do not output partial/truncated names.",
    ];
    const { result } = await generateWithModelFallback(genAI, fallbackModels, promptParts);

    const response = result.response;
    const candidates = response?.candidates;
    if (!candidates || candidates.length === 0) {
      return res.status(500).json({
        error:
          "No text returned from the model (response may be blocked or empty). Try another image or check Gemini API status.",
      });
    }

    let rawText;
    try {
      rawText = response.text();
    } catch (textErr) {
      console.error("Gemini response.text() error:", textErr);
      return res.status(500).json({
        error:
          "Could not read model response. The image may have triggered safety filters—try a clearer product photo.",
      });
    }

    const text = mergeFormatQuantityPrefixes(stripGenericNameFragments(normalizeMlUnits(rawText)));

    return res.json({ result: text });
  } catch (error) {
    console.error("Gemini API error:", error);
    const status = error?.status ?? error?.statusCode;
    const msg = String(error?.message || error || "");

    if (status === 400 || /Unsupported image format|expected pattern|string did not match/i.test(msg)) {
      return res.status(400).json({
        error:
          "Unsupported image format. Please upload JPG/PNG/WEBP/GIF/HEIC/HEIF.",
      });
    }

    if (status === 429 || /429|quota|rate limit|Too Many Requests/i.test(msg)) {
      return res.status(429).json({
        error: "Gemini free-tier quota exceeded. Please wait a minute and try again.",
      });
    }

    if (status === 401 || status === 403 || /API key|API_KEY|permission|PERMISSION_DENIED|401|403/i.test(msg)) {
      return res.status(500).json({
        error:
          "API key rejected or missing on the server. In Vercel: Project → Settings → Environment Variables → add GOOGLE_API_KEY or GEMINI_API_KEY for Production, then Redeploy.",
      });
    }

    if (
      status === 404 ||
      /NOT_FOUND|not found|not supported for generateContent|unsupported model|invalid model/i.test(msg)
    ) {
      return res.status(500).json({
        error:
          "Gemini model not found or not enabled for this API key. Check the model name and Google AI Studio settings.",
      });
    }

    return res.status(500).json({
      error: "Failed to identify product.",
      details: msg.length > 0 ? msg.slice(0, 280) : undefined,
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public", "index.html"));
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

module.exports = app;
