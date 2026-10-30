/**
 * Points the Telegram bot at the deployed Vercel function.
 *
 * Usage: npm run set-webhook -- https://your-app.vercel.app
 */

const baseUrl = process.argv[2]?.replace(/\/+$/, "");
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.WEBHOOK_SECRET;

if (!baseUrl?.startsWith("https://") || !token || !secret) {
  console.error("Usage: npm run set-webhook -- https://your-app.vercel.app");
  console.error("Requires TELEGRAM_BOT_TOKEN and WEBHOOK_SECRET in .env");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: `${baseUrl}/api/telegram`,
    secret_token: secret,
    allowed_updates: ["message", "business_message"],
    drop_pending_updates: true,
  }),
});
console.log(await res.json());

const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
console.log(await info.json());
