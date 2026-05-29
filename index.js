const express = require("express");
const twilio = require("twilio");
const { google } = require("googleapis");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const GOOGLE_SHEET_ID    = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;

// Safe startup logging - won't crash
console.log("=== SERVER STARTING ===");
console.log("GEMINI_API_KEY:", GEMINI_API_KEY ? "SET" : "MISSING");
console.log("GOOGLE_SHEET_ID:", GOOGLE_SHEET_ID || "MISSING");
console.log("GOOGLE_CREDENTIALS length:", GOOGLE_CREDENTIALS ? GOOGLE_CREDENTIALS.length : 0);

let parsedCreds = null;
try {
  parsedCreds = JSON.parse(GOOGLE_CREDENTIALS);
  console.log("GOOGLE_CREDENTIALS: parsed OK, email:", parsedCreds.client_email);
} catch(e) {
  console.error("GOOGLE_CREDENTIALS parse error:", e.message);
  console.error("First 100 chars:", GOOGLE_CREDENTIALS ? GOOGLE_CREDENTIALS.substring(0, 100) : "null");
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
  if (!raw) throw new Error("Empty Gemini response");
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
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

    if (!parsedCreds) {
      throw new Error("Google credentials not loaded");
    }

    console.log("Calling Gemini...");
    const expense = await parseExpense(incomingMsg, new Date());
    expense.rawMessage = incomingMsg;
    console.log("Parsed:", JSON.stringify(expense));

    console.log("Writing to sheet...");
    await appendToSheet(expense);
    console.log("Done!");

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
