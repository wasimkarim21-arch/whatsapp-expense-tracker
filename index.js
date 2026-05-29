const express = require("express");
const twilio = require("twilio");
const { google } = require("googleapis");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const GROQ_API_KEY       = process.env.GROQ_API_KEY;
const GOOGLE_SHEET_ID    = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;

console.log("=== SERVER STARTING ===");
console.log("GROQ_API_KEY:", GROQ_API_KEY ? "SET (" + GROQ_API_KEY.substring(0,8) + "...)" : "MISSING");
console.log("GOOGLE_SHEET_ID:", GOOGLE_SHEET_ID || "MISSING");

let parsedCreds = null;
try {
  parsedCreds = JSON.parse(GOOGLE_CREDENTIALS);
  console.log("GOOGLE_CREDENTIALS: OK, email:", parsedCreds.client_email);
} catch(e) {
  console.error("GOOGLE_CREDENTIALS parse error:", e.message);
}
console.log("=== SERVER READY ===");

async function parseExpense(message, receivedAt) {
  const today = new Date(receivedAt).toLocaleDateString("en-PK", {
    day: "2-digit", month: "2-digit", year: "numeric",
    timeZone: "Asia/Karachi",
  });

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      temperature: 0,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content: `You are an expense parser. Extract details from casual expense messages (may be Urdu/English mix) and return ONLY a JSON object, no explanation, no markdown, no code fences.
Categories: Food, Transport, Shopping, Health, Entertainment, Housing, Utilities, Education, Other
Return ONLY this format: {"amount":3500,"currency":"PKR","category":"Food","description":"Dinner at Kababjees","date":"27/05/2025"}`
        },
        {
          role: "user",
          content: `Message: "${message}"\nToday's date: ${today}\nReturn ONLY the JSON.`
        }
      ],
    }),
  });

  const data = await res.json();
  console.log("Groq response status:", res.status);

  if (data.error) throw new Error("Groq error: " + data.error.message);

  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("Empty Groq response");

  console.log("Groq raw output:", raw);
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

async function appendToSheet(expense) {
  const auth = new google.auth.GoogleAuth({
    credentials: parsedCreds,
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
