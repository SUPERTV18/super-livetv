import fs from "fs";
import path from "path";

const channelsPath = path.join(process.cwd(), "channels.json");
const channels = JSON.parse(
  fs.readFileSync(channelsPath, "utf8")
);

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length"
]);

function getChannelName(req) {
  const raw =
    req.query?.channel ||
    req.query?.id ||
    "";

  return String(raw)
    .replace(/^\/+/, "")
    .replace(/\.m3u8$/i, "");
}

function getAllowedHosts(channel) {
  const hosts = new Set();

  try {
    hosts.add(new URL(channel.url).hostname);
  } catch {}

  if (Array.isArray(channel.allowedHosts)) {
    for (const host of channel.allowedHosts) {
      try {
        hosts.add(
          new URL(
            host.includes("://")
              ? host
              : `https://${host}`
          ).hostname
        );
      } catch {}
    }
  }

  return hosts;
}

/*
 * استخراج المسار المطلوب من الرابط النظيف
 *
 * /SUPERTV_1/proxy/playlist.m3u8
 *
 * path =
 * /proxy/playlist.m3u8
 */
function getRequestedPath(req) {
  let p = req.query?.path || "";

  if (Array.isArray(p)) {
    p = p.join("/");
  }

  p = String(p);

  if (!p) {
    return "";
  }

  if (!p.startsWith("/")) {
    p = "/" + p;
  }

  return p;
}

/*
 * تحويل المسار النظيف إلى رابط المصدر
 *
 * مثال:
 *
 * channel.url =
 * https://example.com/proxy/playlist.m3u8
 *
 * path =
 * /proxy/segment.ts
 *
 * الناتج =
 * https://example.com/proxy/segment.ts
 */
function getUpstreamUrl(channel, req) {
  const requestedUrl = req.query?.url;

  /*
   * دعم الطريقة القديمة أيضًا
   */
  if (requestedUrl) {
    try {
      const target = new URL(
        String(requestedUrl)
      );

      const allowedHosts =
        getAllowedHosts(channel);

      if (
        target.protocol !== "http:" &&
        target.protocol !== "https:"
      ) {
        return null;
      }

      if (!allowedHosts.has(target.hostname)) {
        return null;
      }

      return target.toString();
    } catch {
      return null;
    }
  }

  const requestedPath =
    getRequestedPath(req);

  /*
   * أول طلب:
   *
   * /SUPERTV_1.m3u8
   *
   * استخدم رابط القناة الأساسي.
   */
  if (!requestedPath) {
    return channel.url;
  }

  let base;

  try {
    base = new URL(channel.url);
  } catch {
    return null;
  }

  /*
   * المسار النظيف يمثل نفس المسار
   * الموجود على السيرفر الأصلي.
   */
  const target = new URL(
    requestedPath,
    `${base.protocol}//${base.host}`
  );

  const allowedHosts =
    getAllowedHosts(channel);

  if (!allowedHosts.has(target.hostname)) {
    return null;
  }

  return target.toString();
}

/*
 * إنشاء رابط نظيف
 *
 * المصدر:
 * https://source.com/proxy/segment.ts
 *
 * الناتج:
 * https://super-livetv.vercel.app/SUPERTV_1/proxy/segment.ts
 */
function makeCleanUrl(
  upstreamUrl,
  channelName,
  requestOrigin
) {
  const url =
    new URL(upstreamUrl);

  let result =
    `/${channelName}${url.pathname}`;

  if (url.search) {
    result += url.search;
  }

  return new URL(
    result,
    requestOrigin
  ).toString();
}

function rewriteM3U8(
  text,
  baseUrl,
  channelName,
  requestOrigin
) {
  /*
   * URI="..."
   *
   * EXT-X-KEY
   * EXT-X-MAP
   * EXT-X-MEDIA
   * وغيرها
   */
  let output = text.replace(
    /URI="([^"]+)"/gi,
    (match, uri) => {
      try {
        const absolute =
          new URL(
            uri,
            baseUrl
          ).toString();

        return `URI="${makeCleanUrl(
          absolute,
          channelName,
          requestOrigin
        )}"`;
      } catch {
        return match;
      }
    }
  );

  /*
   * Playlists / segments
   */
  output = output
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();

      if (
        !trimmed ||
        trimmed.startsWith("#")
      ) {
        return line;
      }

      try {
        const absolute =
          new URL(
            trimmed,
            baseUrl
          ).toString();

        return makeCleanUrl(
          absolute,
          channelName,
          requestOrigin
        );
      } catch {
        return line;
      }
    })
    .join("\n");

  return output;
}

export default async function handler(req, res) {
  try {
    if (
      req.method !== "GET" &&
      req.method !== "HEAD"
    ) {
      res.setHeader(
        "Allow",
        "GET, HEAD"
      );

      return res
        .status(405)
        .send("Method Not Allowed");
    }

    const channelName =
      getChannelName(req);

    const channel =
      channels[channelName];

    if (!channel?.url) {
      return res.status(404).json({
        success: false,
        error: "Channel not found"
      });
    }

    const target =
      getUpstreamUrl(
        channel,
        req
      );

    if (!target) {
      return res.status(403).json({
        success: false,
        error:
          "Upstream URL is not allowed for this channel"
      });
    }

    /*
     * Headers
     */
    const headers = {
      ...(channel.headers || {})
    };

    for (const key of Object.keys(headers)) {
      if (!headers[key]) {
        delete headers[key];
      }
    }

    /*
     * User-Agent
     */
    if (
      !headers["User-Agent"] &&
      !headers["user-agent"]
    ) {
      headers["User-Agent"] = "SUPER2026";
    }

    /*
     * Range
     */
    if (req.headers.range) {
      headers.Range =
        req.headers.range;
    }

    const upstream = await fetch(
      target,
      {
        method: req.method,
        headers,
        redirect: "follow"
      }
    );

    const finalUrl =
      upstream.url || target;

    const contentType =
      upstream.headers.get(
        "content-type"
      ) || "";

    const isM3U8 =
      /mpegurl|vnd\.apple\.mpegurl/i.test(
        contentType
      ) ||
      /\.m3u8(?:\?|$)/i.test(
        finalUrl
      );

    /*
     * CORS
     */
    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "*"
    );

    res.setHeader(
      "Access-Control-Expose-Headers",
      "*"
    );

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );

    /*
     * Upstream error
     */
    if (!upstream.ok) {
      const body =
        await upstream
          .text()
          .catch(() => "");

      return res
        .status(upstream.status)
        .send(
          `Upstream error: ${upstream.status}${
            body
              ? `\n${body.slice(0, 500)}`
              : ""
          }`
        );
    }

    /*
     * M3U8
     */
    if (isM3U8) {
      if (req.method === "HEAD") {
        return res
          .status(200)
          .end();
      }

      const text =
        await upstream.text();

      const protocol =
        req.headers[
          "x-forwarded-proto"
        ] || "https";

      const requestOrigin =
        `${protocol}://${req.headers.host}`;

      const rewritten =
        rewriteM3U8(
          text,
          finalUrl,
          channelName,
          requestOrigin
        );

      res.setHeader(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );

      return res
        .status(200)
        .send(rewritten);
    }

    /*
     * Binary
     */
    for (
      const [key, value]
      of upstream.headers
    ) {
      if (
        !HOP_BY_HOP.has(
          key.toLowerCase()
        )
      ) {
        res.setHeader(
          key,
          value
        );
      }
    }

    if (req.method === "HEAD") {
      return res
        .status(upstream.status)
        .end();
    }

    const buffer =
      Buffer.from(
        await upstream.arrayBuffer()
      );

    return res
      .status(upstream.status)
      .send(buffer);

  } catch (error) {
    console.error(
      "Proxy error:",
      error
    );

    return res.status(500).json({
      success: false,
      error: "Proxy error",
      message: error.message
    });
  }
}
