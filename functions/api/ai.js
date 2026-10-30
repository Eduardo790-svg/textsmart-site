// Cloudflare Pages Function: POST /api/ai
const ALLOWED = [
  "Invent a realistic woman",
  "You play ",
  "You are a warm, honest texting coach",
];
const PREMIUM_ONLY = ["You are an honest dating-profile coach"];
const FREE_CALLS = 120, FREE_CHATS = 2, PREMIUM_CALLS = 600;

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request." }, 400); }
  const { prompt, image, code } = body || {};
  if (typeof prompt !== "string" || !prompt || prompt.length > 12000) return json({ error: "Bad request." }, 400);

  const hashes = (env.CODE_HASHES || "").split(",").map((s) => s.trim()).filter(Boolean);
  const codeHash = code ? await sha256("ts1:" + String(code).trim().toUpperCase()) : "";
  const premium = !!codeHash && hashes.includes(codeHash);

  const okPrefix = ALLOWED.some((p) => prompt.startsWith(p));
  const premPrefix = PREMIUM_ONLY.some((p) => prompt.startsWith(p));
  if (!okPrefix && !premPrefix) return json({ error: "Request not allowed." }, 400);
  if ((image || premPrefix) && !premium) return json({ error: "This is a Premium feature." }, 402);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const hit = async (k) =>
    (await env.DB.prepare("INSERT INTO usage(k,n) VALUES(?,1) ON CONFLICT(k) DO UPDATE SET n=n+1 RETURNING n").bind(k).first()).n;

  const total = await hit(`t:${premium ? codeHash : ip}:${day}`);
  if (total > (premium ? PREMIUM_CALLS : FREE_CALLS)) return json({ error: "Daily limit reached. Try again tomorrow." }, 429);
  if (!premium && prompt.startsWith("Invent a realistic woman")) {
    if ((await hit(`s:${ip}:${day}`)) > FREE_CHATS)
      return json({ error: "You’ve used your free chats for today. Upgrade to Premium for unlimited practice." }, 429);
  }

  const content = image
    ? [{ type: "image", source: { type: "base64", media_type: image.type, data: image.data } }, { type: "text", text: prompt }]
    : prompt;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: env.MODEL || "claude-haiku-5-5", max_tokens: 4000, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) return json({ error: "The AI is busy. Try again in a moment." }, 502);
  const d = await r.json();
  return json({ text: (d.content || []).map((b) => b.text || "").join("") });
}
