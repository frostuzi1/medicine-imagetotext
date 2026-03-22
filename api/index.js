const express = require("express");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const app = express();

const systemInstruction =
  'Analyze the product image(s). Return ONLY the text in this format per line: [quantity] [box or boxes or bottle or bottles] [Product Name] [Flavor] [Dosage/Size] [Pack contents]. QUANTITY RULES: Count how many separate identical units of the same product appear (e.g. two of the same bottle side by side, or two identical boxes). Use that count as the quantity prefix: "2 bottles ..." or "2 boxes ...". Use "1 bottle" / "1 box" when only one unit is visible. If multiple different medicines appear, use one line per distinct product. PREFIX TYPE: Use "bottle"/"bottles" when the product volume is in mL (liquids/syrups). Use "box"/"boxes" when strength is in mg (typical tablets/capsules), or when neither mg nor mL appears. If both mg and mL appear, prefer "bottle(s)" when mL is the product volume. STRICT RULES: Do not use other packaging words (blister, sachet). If a flavor is visible, include it right after the product name using the word "Flavor" (for example: "Orange Flavor", "Menthol Flavor"). If no flavor is found, skip flavor entirely and do not write "No Flavor". Keep medicine names complete and do not truncate words. Keep dosage/size complete and include full units (mg, mL, g, IU, etc.) when visible—always write milliliters as "mL", never "ml". When the label shows how many capsules, tablets, softgels, or similar units are in the pack, include that at the end (for example: "30 capsules", "60 softgels", "100 tablets"). If pack count is not visible, omit it—do not guess or write "unknown". Use all provided images to complete missing text before answering. When text is partially visible, infer only when strongly supported by at least one other image; otherwise omit that medicine line instead of returning incomplete text. Example outputs: "1 bottle Scott\'s Emulsion Orange Flavor 200 mL" or "2 bottles Scott\'s Emulsion Orange Flavor 200 mL" or "2 boxes Panadol Menthol Flavor 500mg 30 tablets".';

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
  return hasMl ? "bottle" : "box";
}

function formatQtyKind(qty, kind) {
  const n = Math.max(1, parseInt(String(qty), 10) || 1);
  if (kind === "bottle") {
    return n === 1 ? "1 bottle" : `${n} bottles`;
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

    const imageParts = validImages.map((imageBase64Value) => {
      const dataUrlMatch = imageBase64Value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      const mimeType = dataUrlMatch ? dataUrlMatch[1] : "image/jpeg";
      const base64Data = dataUrlMatch ? dataUrlMatch[2] : imageBase64Value;

      return {
        inlineData: {
          data: base64Data,
          mimeType,
        },
      };
    });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-3.1-flash-lite-preview",
      systemInstruction,
      generationConfig: {
        responseMimeType: "text/plain",
        temperature: 0,
        topP: 0.1,
        maxOutputTokens: 512,
      },
    });

    const result = await model.generateContent([
      ...imageParts,
      "Cross-check all images before final output. Count identical separate units of the same product (e.g. 2 same bottles) and use that quantity in the line prefix. Prefer complete medicine lines only; do not output partial/truncated names.",
    ]);

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

    const text = mergeFormatQuantityPrefixes(normalizeMlUnits(rawText));

    return res.json({ result: text });
  } catch (error) {
    console.error("Gemini API error:", error);
    const status = error?.status ?? error?.statusCode;
    const msg = String(error?.message || error || "");

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

    if (status === 404 || /not found|NOT_FOUND|model/i.test(msg)) {
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
