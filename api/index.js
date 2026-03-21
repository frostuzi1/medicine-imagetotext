const express = require("express");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const app = express();

const systemInstruction =
  'Analyze the product image(s). Return ONLY the text in this format: [Product Name] [Flavor] [Dosage/Size]. If there are multiple medicines, put each medicine on a new line. STRICT RULES: Do not include packaging words (box, bottle, blister, sachet). If a flavor is visible, include it right after the product name using the word "Flavor" (for example: "Orange Flavor", "Menthol Flavor"). If no flavor is found, skip flavor entirely and do not write "No Flavor". Keep medicine names complete and do not truncate words. Keep dosage/size complete and include full units (mg, ml, g, IU, etc.) when visible. Use all provided images to complete missing text before answering. When text is partially visible, infer only when strongly supported by at least one other image; otherwise omit that medicine line instead of returning incomplete text. NO quantities (no 1, 2, or 100pcs). Example outputs: "Scott\'s Emulsion Orange Flavor 200ml" or "Panadol Menthol Flavor 500mg".';

function cleanModelText(value) {
  return String(value || "").trim().replace(/^["']|["']$/g, "");
}

function dedupeResultLines(value) {
  const seen = new Set();
  const lines = cleanModelText(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const uniqueLines = lines.filter((line) => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });

  return uniqueLines.join("\n");
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
      "Cross-check all images before final output. Prefer complete medicine lines only; do not output partial/truncated names.",
    ]);

    const text = dedupeResultLines(result.response.text());

    return res.json({ result: text });
  } catch (error) {
    console.error("Gemini API error:", error);
    if (error && error.status === 429) {
      return res.status(429).json({
        error: "Gemini free-tier quota exceeded. Please wait a minute and try again.",
      });
    }
    return res.status(500).json({ error: "Failed to identify product." });
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
