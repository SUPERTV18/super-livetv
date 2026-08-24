import fs from "fs";
import path from "path";
import crypto from "crypto";

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

/*
 * Token مؤقت للرابط الأصلي.
 *
 * مهم:
 * لا نضع الرابط الأصلي داخل الـ URL الظاهر.
 */
const TOKEN_SECRET =
  process.env.STREAM_SECRET || "SUPER_TV_2026_SECRET";

function encodeTarget(channelName, targetUrl) {
  const payload = JSON.stringify({
    c: channelName,
    u: targetUrl
  });

  const encoded = Buffer.from(
    payload,
    "utf8"
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(encoded)
    .digest("base64url")
    .slice(0, 32);

  return `${encoded}.${signature}`;
}

function decodeTarget(token) {
  try {
    const [encoded, signature] =
      String(token).split(".");

    if (!encoded || !signature) {
      return null;
    }

    const expected = crypto
      .createHmac("sha256", TOKEN_SECRET)
      .update(encoded)
      .digest("base64url")
      .slice(0, 32);

    if (signature !== expected) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(
        encoded,
        "base64url"
      ).toString("utf8")
    );

    if (
      !payload?.c ||
      !payload?.u
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

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
    const base = new URL(channel.url);
    hosts.add(base.hostname);
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

function isAllowedUrl(channel, target) {
  try {
    const url = new URL(target);

    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {
      return false;
    }

    return getAllowedHosts(channel).has(
      url.hostname
    );
  } catch {
    return false;
  }
}

/*
 * إنشاء الرابط النظيف.
 *
 * مثال:
 *
 * /SUPERTV_1/AbCdEf...
 */
function cleanProxyUrl(
  channelName,
  targetUrl,
  requestOrigin
) {
  const token = encodeTarget(
    channelName,
    targetUrl
  );

  return new URL(
    `/${channelName}/${token}`,
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
   * EXT-X-KEY
   * EXT-X-MAP
   * EXT-X-MEDIA
   * إلخ
   */
  let output = text.replace(
    /URI="([^"]+)"/gi,
    (match, uri) => {
      try {
        const absolute = new URL(
          uri,
          baseUrl
        ).toString();

        return `URI="${cleanProxyUrl(
          channelName,
          absolute,
          requestOrigin
        )}"`;
      } catch {
        return match;
      }
    }
  );

  /*
   * Playlists + Segments
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
        const absolute = new URL(
          trimmed,
          baseUrl
        ).toString();

        return cleanProxyUrl(
          channelName,
          absolute,
          requestOrigin
        );
      } catch {
        return line;
      }
    })
    .join("\n");

  return output;
}

export default async function handler(
  req,
  res
) {
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

    /*
     * تحديد الرابط الأصلي.
     *
     * أول طلب:
     *
     * /SUPERTV_1.m3u8
     *
     * يستخدم channel.url
     *
     * أما الطلبات التالية:
     *
     * /SUPERTV_1/TOKEN
     *
     * تستخرج الرابط الأصلي من الـ token.
     */
    let target = channel.url;

    const token =
      req.query?.token;

    if (token) {
      const decoded =
        decodeTarget(token);

      if (!decoded) {
        return res.status(403).json({
          success: false,
          error: "Invalid stream token"
        });
      }

      if (
        decoded.c !== channelName
      ) {
        return res.status(403).json({
          success: false,
          error: "Invalid channel"
        });
      }

      if (
        !isAllowedUrl(
          channel,
          decoded.u
        )
      ) {
        return res.status(403).json({
          success: false,
          error:
            "Upstream URL is not allowed for this channel"
        });
      }

      target = decoded.u;
    }

    /*
     * دعم الرابط القديم أيضًا
     */
    if (!token && req.query?.url) {
      const requested =
        String(req.query.url);

      if (
        !isAllowedUrl(
          channel,
          requested
        )
      ) {
        return res.status(403).json({
          success: false,
          error:
            "Upstream URL is not allowed for this channel"
        });
      }

      target = requested;
    }

    /*
     * Headers
     */
    const headers = {
      ...(channel.headers || {})
    };

    for (
      const key of Object.keys(headers)
    ) {
      if (!headers[key]) {
        delete headers[key];
      }
    }

    /*
     * Default User-Agent
     */
    if (
      !headers["User-Agent"] &&
      !headers["user-agent"]
    ) {
      headers["User-Agent"] =
        "SUPER2026";
    }

    /*
     * Forward Range
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

    const contentType =
      upstream.headers.get(
        "content-type"
      ) || "";

    const finalUrl =
      upstream.url || target;

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
          `Upstream error: ${
            upstream.status
          }${
            body
              ? `\n${body.slice(
                  0,
                  500
                )}`
              : ""
          }`
        );
    }

    /*
     * M3U8
     */
    if (isM3U8) {
      if (
        req.method === "HEAD"
      ) {
        return res
          .status(200)
          .end();
      }

      const text =
        await upstream.text();

      const requestOrigin =
        `${
          req.headers[
            "x-forwarded-proto"
          ] || "https"
        }://${
          req.headers.host
        }`;

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
     * Binary segments
     */
    for (
      const [
        key,
        value
      ] of upstream.headers
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

    if (
      req.method === "HEAD"
    ) {
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
