const express = require("express");
const twilio = require("twilio");
const { google } = require("googleapis");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const GOOGLE_SHEET_ID    = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;

console.log("=== SERVER STARTING ===");
console.log("GEMINI_API_KEY:", GEMINI_API_KEY ? "SET (" + GEMINI_API_KEY.substring(0,6) + "...)" : "MISSING");

let parsedCreds = null;
try {
  parsedCreds = JSON.parse(GOOGLE_CREDENTIALS);
  console.log("GOOGLE_CREDENTIALS: OK");
} catch(e) {
  console.error("GOOGLE_CREDENTIALS parse error:", e.message);
}
console.log("=== SERVER READY ===");

async function parseExpense(message, receivedAt) {
  const today = new Date(receivedAt).toLocaleDateString("en-PK", {
    day: "2-digit", month: "2-digit", year: "numeric",
    timeZone: "Asia/Karachi",
  });

  const prompt = `You are an expense parser. Extract details from a casual expense message (may be Urdu/English mix) and return ONLY a JSON object, no explanation, no markdown.

Message: "${message}"
Today's date: ${today}

Return ONLY this exact JSON format:
{"amount":3500,"currency":"PKR","category":"Food","description":"Dinner at Kababjees","date":"27/05/2025"}

Categories: Food, Transport, Shopping, Health, Entertainment, Housing, Utilities, Education, Other`;

  // Try v1beta first, then v1 as fallback
  const urls = [
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
  ];

  let lastError = null;
  for (const url of urls) {
    try {
      console.log("Trying:", url.split("models/")[1].split(":")[0]);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 200 },
        }),
      });

      const data = await res.json();
      console.log("Response status:", res.status);
      console.log("Response:", JSON.stringify(data).substring(0, 200));

      if (data.error) {
        console.log("API error:", data.error.message);
        lastError = data.error.message;
        continue;
      }

      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!raw) {
        lastError = "Empty response";
        continue;
      }

      const clean = raw.replace(/```json|```/g, "").trim();
      return JSON.parse(clean);
    } catch(e) {
      lastError = e.message;
      console.error("Fetch error:", e.message);
    }
  }

  throw new Error("Gemini failed: " + lastError);
}

async function appendToSheet(expense) {
  const auth = new google.auth.GoogleAuth({
    credentials: parsedCreds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const row = [expense.date, expense.amount, expense.currency, expense.category, expense.description, expense.rawMessage];
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "Sheet1!A:F",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

app.post("/webhook", async (req, res) => {
  console.log("=== WEBHOOK HIT ===");
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const incomingMsg = req.body.Body?.trim();
    console.log("Message:", incomingMsg);

    if (!incomingMsg) {
      twiml.message("No message received.");
      return res.type("text/xml").send(twiml.toString());
    }

    if (!parsedCreds) throw new Error("Google credentials not loaded");

    const expense = await parseExpense(incomingMsg, new Date());
    expense.rawMessage = incomingMsg;
    console.log("Parsed:", JSON.stringify(expense));

    await appendToSheet(expense);
    console.log("Sheet updated!");

    twiml.message(
      `✅ Logged!\n📅 ${expense.date}\n💰 PKR ${Number(expense.amount).toLocaleString()}\n🏷️ ${expense.category}\n📝 ${expense.description}`
    );

  } catch (err) {
    console.error("ERROR:", err.message);
    twiml.message("❌ Error: " + err.message);
  }

  res.type("text/xml").send(twiml.toString());
});

app.get("/", (req, res) => res.send("WhatsApp Expense Tracker ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
