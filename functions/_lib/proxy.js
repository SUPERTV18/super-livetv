import channels from "../../channels.json";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length"
]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Expose-Headers": "*",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
};

function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function getAesKey(secret) {
  if (!secret) throw new Error("STREAM_SECRET is not configured");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptTarget(channelName, targetUrl, secret) {
  const key = await getAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(JSON.stringify({
    c: channelName, u: targetUrl, t: Date.now()
  }));
  // Web Crypto returns ciphertext || 16-byte tag. Reorder to IV || tag || ciphertext.
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, payload));
  const tag = encrypted.slice(encrypted.length - 16);
  const ciphertext = encrypted.slice(0, encrypted.length - 16);
  const packed = new Uint8Array(iv.length + tag.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(tag, iv.length);
  packed.set(ciphertext, iv.length + tag.length);
  return toBase64Url(packed);
}

async function decryptTarget(token, secret) {
  try {
    const data = fromBase64Url(token);
    if (data.length < 29) return null;
    const iv = data.slice(0, 12);
    const tag = data.slice(12, 28);
    const ciphertext = data.slice(28);
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.length);
    const key = await getAesKey(secret);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 }, key, combined
    );
    const payload = JSON.parse(new TextDecoder().decode(decrypted));
    return payload && payload.c && payload.u ? payload : null;
  } catch {
    return null;
  }
}

function allowedHosts(channel) {
  const hosts = new Set();
  try { hosts.add(new URL(channel.url).hostname); } catch {}
  if (Array.isArray(channel.allowedHosts)) {
    for (const entry of channel.allowedHosts) {
      if (!entry) continue;
      try {
        hosts.add(new URL(entry.includes("://") ? entry : "https://" + entry).hostname);
      } catch {}
    }
  }
  return hosts;
}

function isAllowedUrl(channel, target) {
  try {
    const url = new URL(target);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      allowedHosts(channel).has(url.hostname);
  } catch {
    return false;
  }
}

async function makeProxyUrl(channelName, targetUrl, requestUrl, secret) {
  const token = await encryptTarget(channelName, targetUrl, secret);
  return new URL("/" + encodeURIComponent(channelName) + "/" + token, requestUrl.origin).toString();
}

async function rewriteM3U8(body, baseUrl, channelName, requestUrl, secret) {
  let output = body.replace(/URI="([^"]+)"/gi, asyncMatch => asyncMatch);
  const uriPattern = /URI="([^"]+)"/gi;
  const uriMatches = [...body.matchAll(uriPattern)];
  for (const match of uriMatches) {
    try {
      const absolute = new URL(match[1], baseUrl).toString();
      const proxied = await makeProxyUrl(channelName, absolute, requestUrl, secret);
      output = output.replace(match[0], 'URI="' + proxied + '"');
    } catch {}
  }

  const lines = output.split(/\r?\n/);
  const rewritten = await Promise.all(lines.map(async line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    try {
      const absolute = new URL(trimmed, baseUrl).toString();
      return await makeProxyUrl(channelName, absolute, requestUrl, secret);
    } catch {
      return line;
    }
  }));
  return rewritten.join("\n");
}

function responseHeaders(extra = {}) {
  return new Headers({ ...corsHeaders, ...extra });
}

export async function handleStream(request, params, env) {
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders() });
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405, headers: responseHeaders({ Allow: "GET, HEAD, OPTIONS" })
    });
  }

  const channelName = String(params.channel || "").replace(/\.m3u8$/i, "");
  const channel = channels[channelName];
  if (!channel?.url) {
    return new Response(JSON.stringify({ success: false, error: "Channel not found" }), {
      status: 404, headers: responseHeaders({ "Content-Type": "application/json; charset=utf-8" })
    });
  }

  const requestUrl = new URL(request.url);
  let target = channel.url;
  if (params.token) {
    const decoded = await decryptTarget(params.token, env.STREAM_SECRET);
    if (!decoded) {
      return new Response(JSON.stringify({ success: false, error: "Invalid or corrupted stream token" }), {
        status: 403, headers: responseHeaders({ "Content-Type": "application/json; charset=utf-8" })
      });
    }
    if (decoded.c !== channelName) {
      return new Response(JSON.stringify({ success: false, error: "Invalid channel" }), {
        status: 403, headers: responseHeaders({ "Content-Type": "application/json; charset=utf-8" })
      });
    }
    if (!isAllowedUrl(channel, decoded.u)) {
      return new Response(JSON.stringify({ success: false, error: "Upstream URL is not allowed" }), {
        status: 403, headers: responseHeaders({ "Content-Type": "application/json; charset=utf-8" })
      });
    }
    target = decoded.u;
  }

  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(channel.headers || {})) {
      if (value) headers.set(key, String(value));
    }
    if (!headers.has("User-Agent")) headers.set("User-Agent", "SUPER2026");
    const range = request.headers.get("Range");
    if (range) headers.set("Range", range);

    const upstream = await fetch(target, {
      method,
      headers,
      redirect: "follow"
    });

    const contentType = upstream.headers.get("content-type") || "";
    const finalUrl = upstream.url || target;
    const isM3U8 = /mpegurl|vnd\.apple\.mpegurl/i.test(contentType) ||
      /\.m3u8(?:\?|$)/i.test(finalUrl);

    if (!upstream.ok) {
      const body = method === "HEAD" ? "" : (await upstream.text().catch(() => "")).slice(0, 500);
      return new Response("Upstream error: " + upstream.status + (body ? "\n" + body : ""), {
        status: upstream.status, headers: responseHeaders()
      });
    }

    if (isM3U8) {
      if (method === "HEAD") {
        return new Response(null, { status: upstream.status, headers: responseHeaders({
          "Content-Type": "application/vnd.apple.mpegurl"
        }) });
      }
      const text = await upstream.text();
      const rewritten = await rewriteM3U8(text, finalUrl, channelName, requestUrl, env.STREAM_SECRET);
      return new Response(rewritten, {
        status: upstream.status,
        headers: responseHeaders({ "Content-Type": "application/vnd.apple.mpegurl" })
      });
    }

    const outgoing = responseHeaders();
    for (const [key, value] of upstream.headers) {
      if (!HOP_BY_HOP.has(key.toLowerCase()) &&
          !["access-control-allow-origin", "cache-control"].includes(key.toLowerCase())) {
        outgoing.set(key, value);
      }
    }
    return new Response(method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outgoing
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Cloudflare Pages stream proxy error:", message);
    return new Response(JSON.stringify({
      success: false,
      error: "Proxy error",
      message: message === "STREAM_SECRET is not configured" ? message : "Upstream request failed"
    }), {
      status: 500,
      headers: responseHeaders({ "Content-Type": "application/json; charset=utf-8" })
    });
  }
}
