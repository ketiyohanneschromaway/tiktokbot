/**
 * Telegram webhook: anyone sends a TikTok link, the owner receives the video via DM.
 *
 * Telegram POSTs each update here. We acknowledge immediately and do the slow work
 * (download + upload) in `waitUntil`, so Telegram never times out and re-sends the update.
 */

import { waitUntil } from "@vercel/functions";

// Telegram Bot API upload limit for bots using the public API server.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const TIKTOK_URL_RE = /https?:\/\/(?:www\.|vm\.|vt\.|m\.)?tiktok\.com\/[^\s]+/gi;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
  caption?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TikTokVideo {
  data: Uint8Array<ArrayBuffer>;
  source: "direct" | "tikwm";
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------

async function callTelegram<T>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/${method}`, {
    method: "POST",
    headers: isForm ? undefined : { "Content-Type": "application/json" },
    body: isForm ? body : JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description}`);
  return json.result;
}

function sendMessage(chatId: number, text: string, replyTo?: number) {
  return callTelegram<TelegramMessage>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
  });
}

function editMessage(chatId: number, messageId: number, text: string) {
  return callTelegram("editMessageText", { chat_id: chatId, message_id: messageId, text });
}

function sendVideo(chatId: number, video: Uint8Array<ArrayBuffer>, caption: string) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("supports_streaming", "true");
  form.append("video", new Blob([video], { type: "video/mp4" }), "tiktok.mp4");
  return callTelegram("sendVideo", form);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function describeSender(user?: TelegramUser): string {
  if (!user) return "someone";
  const name = escapeHtml([user.first_name, user.last_name].filter(Boolean).join(" "));
  return user.username
    ? `${name} (@${escapeHtml(user.username)})`
    : `<a href="tg://user?id=${user.id}">${name}</a>`;
}

// ---------------------------------------------------------------------------
// TikTok download
// ---------------------------------------------------------------------------

async function downloadBytes(url: string, headers: Record<string, string> = {}): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...headers } });
  if (!res.ok) throw new Error(`Video download failed with HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw new Error("Video exceeds Telegram's 50 MB bot upload limit");
  return new Uint8Array<ArrayBuffer>(await res.arrayBuffer());
}

/** Scrape the TikTok page for the video URL, then download it with the page's cookies. */
async function fetchDirect(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const page = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!page.ok) throw new Error(`TikTok page returned HTTP ${page.status}`);
  const html = await page.text();

  const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s);
  if (!match) throw new Error("TikTok page did not contain video data");
  const data = JSON.parse(match[1]);
  const item = data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;
  if (!item) throw new Error("TikTok video not found (private or removed?)");
  if (item.imagePost) throw new Error("Photo slideshows are not supported");

  const videoUrl: string | undefined = item.video?.playAddr || item.video?.downloadAddr;
  if (!videoUrl) throw new Error("TikTok video URL missing from page data");

  // The CDN rejects requests that lack the cookies set by the page response.
  const cookies = page.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  return downloadBytes(videoUrl, { Referer: "https://www.tiktok.com/", Cookie: cookies });
}

/** Fallback: the free tikwm.com API, useful when TikTok blocks cloud-provider IPs. */
async function fetchViaTikwm(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(`https://www.tikwm.com/api/?hd=1&url=${encodeURIComponent(url)}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  const json = (await res.json()) as {
    code: number;
    msg: string;
    data?: { play?: string; hdplay?: string; hd_size?: number; images?: string[] };
  };
  if (json.code !== 0 || !json.data) throw new Error(`tikwm: ${json.msg}`);
  if (json.data.images?.length) throw new Error("Photo slideshows are not supported");

  const { play, hdplay, hd_size } = json.data;
  const videoUrl = hdplay && (hd_size ?? 0) <= MAX_UPLOAD_BYTES ? hdplay : play;
  if (!videoUrl) throw new Error("tikwm returned no video URL");
  return downloadBytes(videoUrl);
}

export async function getTikTokVideo(url: string): Promise<TikTokVideo> {
  try {
    return { data: await fetchDirect(url), source: "direct" };
  } catch (directError) {
    console.warn(`Direct download failed for ${url}:`, directError);
    try {
      return { data: await fetchViaTikwm(url), source: "tikwm" };
    } catch (tikwmError) {
      throw new Error(`${(directError as Error).message}; fallback: ${(tikwmError as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Update handling
// ---------------------------------------------------------------------------

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text ?? message.caption ?? "";
  const ownerId = Number(env("OWNER_CHAT_ID"));
  const isOwner = message.from?.id === ownerId;

  if (text.startsWith("/start")) {
    await sendMessage(chatId, "Send me a TikTok link and I'll pass it along.");
    return;
  }

  const urls = text.match(TIKTOK_URL_RE) ?? [];
  if (urls.length === 0) {
    await sendMessage(chatId, "That doesn't look like a TikTok link.", message.message_id);
    return;
  }

  const sender = describeSender(message.from);

  for (const url of urls) {
    const status = await sendMessage(chatId, "Downloading…", message.message_id);
    try {
      const video = await getTikTokVideo(url);
      if (video.data.byteLength > MAX_UPLOAD_BYTES) {
        throw new Error("Video exceeds Telegram's 50 MB bot upload limit");
      }
      await sendVideo(ownerId, video.data, `From ${sender}\n${escapeHtml(url)}`);
      await editMessage(chatId, status.message_id, isOwner ? "Done ✅" : "Sent ✅ Thanks!");
    } catch (error) {
      console.error(`Failed to process ${url}:`, error);
      await editMessage(chatId, status.message_id, "Sorry, I couldn't get that video.");
      if (!isOwner) {
        await sendMessage(
          ownerId,
          `⚠️ Failed to fetch a link from ${sender}:\n${escapeHtml(url)}\n<code>${escapeHtml(
            String((error as Error).message ?? error).slice(0, 500),
          )}</code>`,
        );
      }
    }
  }
}

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== env("WEBHOOK_SECRET")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = (await request.json()) as TelegramUpdate;
  waitUntil(handleUpdate(update).catch((error) => console.error("Unhandled error:", error)));
  return new Response("OK");
}

export function GET(): Response {
  return new Response("TikTok bot is running.");
}
