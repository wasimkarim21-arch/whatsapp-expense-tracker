const express = require("express");
const twilio = require("twilio");
const { google } = require("googleapis");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const GOOGLE_SHEET_ID    = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;
// ─────────────────────────────────────────────────────────────────────────────

// ── Parse expense using Gemini Flash (free) ───────────────────────────────────
async function parseExpense(message, receivedAt) {
  const today = new Date(receivedAt).toLocaleDateString("en-PK", {
    day: "2-digit", month: "2-digit", year: "numeric",
    timeZone: "Asia/Karachi",
  }); // e.g. 27/05/2025

  const prompt = `You are an expense parser. Extract details from a casual expense message (may be Urdu/English mix) and return ONLY a JSON object, no explanation, no markdown.

Message: "${message}"
Today's date: ${today}

Rules:
- amount: number only (no symbols). Handle "Rs.", "PKR", "₨", "k" (3.5k = 3500), "lakh" (1.5 lakh = 150000)
- currency: "PKR" always unless another currency clearly stated
- category: pick ONE from [Food, Transport, Shopping, Health, Entertainment, Housing, Utilities, Education, Other]
- description: short clean English description of what was bought/paid (e.g. "Dinner at Kababjees")
- date: DD/MM/YYYY — use date from message if mentioned, otherwise use today's date: ${today}

Return ONLY this exact JSON:
{"amount":3500,"currency":"PKR","category":"Food","description":"Dinner at Kababjees","date":"27/05/2025"}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 200 },
      }),
    }
  );

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!raw) throw new Error("Empty response from Gemini");

  // Strip markdown fences if Gemini wraps in ```json
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ── Append a row to Google Sheets ─────────────────────────────────────────────
async function appendToSheet(expense) {
  const credentials = JSON.parse(GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  const row = [
    expense.date,
    expense.amount,
    expense.currency,
    expense.category,
    expense.description,
    expense.rawMessage,
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "Sheet1!A:F",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

// ── WhatsApp webhook ──────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const incomingMsg = req.body.Body?.trim();
    if (!incomingMsg) {
      twiml.message("⚠️ Empty message received.");
      return res.type("text/xml").send(twiml.toString());
    }

    console.log("Incoming:", incomingMsg);

    const expense = await parseExpense(incomingMsg, new Date());
    expense.rawMessage = incomingMsg;

    if (!expense.amount || expense.amount <= 0) {
      twiml.message("❌ Couldn't find an amount.\nTry: *Rs. 500 food lunch biryani*");
      return res.type("text/xml").send(twiml.toString());
    }

    await appendToSheet(expense);

    twiml.message(
      `✅ Logged!\n` +
      `📅 ${expense.date}\n` +
      `💰 PKR ${Number(expense.amount).toLocaleString()}\n` +
      `🏷️ ${expense.category}\n` +
      `📝 ${expense.description}`
    );

    console.log("Logged:", expense);

  } catch (err) {
    console.error("Error:", err.message);
    twiml.message("❌ Something went wrong. Try again in a moment.");
  }

  res.type("text/xml").send(twiml.toString());
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("WhatsApp Expense Tracker is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
