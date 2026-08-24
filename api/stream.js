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

const TOKEN_SECRET =
  process.env.STREAM_SECRET ||
  "SUPER_TV_2026_SECRET";

/*
 * =========================================================
 * TOKEN
 * =========================================================
 */

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
    .createHmac(
      "sha256",
      TOKEN_SECRET
    )
    .update(encoded)
    .digest("base64url")
    .slice(0, 32);

  return `${encoded}.${signature}`;
}

function decodeTarget(token) {
  try {
    const parts = String(token).split(".");

    if (parts.length !== 2) {
      return null;
    }

    const encoded = parts[0];
    const signature = parts[1];

    if (!encoded || !signature) {
      return null;
    }

    const expected = crypto
      .createHmac(
        "sha256",
        TOKEN_SECRET
      )
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
      !payload ||
      !payload.c ||
      !payload.u
    ) {
      return null;
    }

    return payload;

  } catch {
    return null;
  }
}

/*
 * =========================================================
 * CHANNEL
 * =========================================================
 */

function getChannelName(req) {
  const raw =
    req.query?.channel ||
    req.query?.id ||
    "";

  return String(raw)
    .replace(/^\/+/, "")
    .replace(/\.m3u8$/i, "");
}

/*
 * =========================================================
 * ALLOWED HOSTS
 * =========================================================
 */

function getAllowedHosts(channel) {
  const hosts = new Set();

  try {
    const base = new URL(channel.url);

    hosts.add(
      base.hostname
    );
  } catch {}

  if (
    Array.isArray(
      channel.allowedHosts
    )
  ) {
    for (
      const host of channel.allowedHosts
    ) {
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

function isAllowedUrl(
  channel,
  target
) {
  try {
    const url =
      new URL(target);

    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {
      return false;
    }

    return getAllowedHosts(
      channel
    ).has(
      url.hostname
    );

  } catch {
    return false;
  }
}

/*
 * =========================================================
 * CLEAN URL
 * =========================================================
 *
 * المصدر:
 *
 * https://original-server.com/path/segment.ts
 *
 * يصبح:
 *
 * https://super-livetv.vercel.app/SUPERTV_1/TOKEN
 *
 * بدون إظهار الرابط الأصلي.
 */

function cleanProxyUrl(
  channelName,
  targetUrl,
  requestOrigin
) {
  const token =
    encodeTarget(
      channelName,
      targetUrl
    );

  return new URL(
    `/${channelName}/${token}`,
    requestOrigin
  ).toString();
}

/*
 * =========================================================
 * M3U8 REWRITE
 * =========================================================
 */

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
   * وغيرها
   */
  let output =
    text.replace(
      /URI="([^"]+)"/gi,
      (match, uri) => {
        try {
          const absolute =
            new URL(
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
   * Playlists / Segments
   */
  output = output
    .split(/\r?\n/)
    .map((line) => {
      const trimmed =
        line.trim();

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

/*
 * =========================================================
 * HANDLER
 * =========================================================
 */

export default async function handler(
  req,
  res
) {
  try {

    /*
     * GET / HEAD فقط
     */
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
        .send(
          "Method Not Allowed"
        );
    }

    /*
     * =====================================================
     * منع ?url= نهائيًا
     * =====================================================
     *
     * أي محاولة مثل:
     *
     * /api/stream?channel=SUPERTV_1&url=https://...
     *
     * يتم رفضها.
     */

    if (
      req.query?.url
    ) {
      return res
        .status(403)
        .json({
          success: false,
          error:
            "Direct upstream URL access is disabled"
        });
    }

    /*
     * Channel
     */
    const channelName =
      getChannelName(req);

    const channel =
      channels[channelName];

    if (!channel?.url) {
      return res
        .status(404)
        .json({
          success: false,
          error:
            "Channel not found"
        });
    }

    /*
     * =====================================================
     * تحديد المصدر
     * =====================================================
     *
     * أول طلب:
     *
     * /SUPERTV_1.m3u8
     *
     * يستخدم channel.url
     *
     * الطلبات التالية:
     *
     * /SUPERTV_1/TOKEN
     *
     * تستخرج المصدر من الـ Token.
     */

    let target =
      channel.url;

    const token =
      req.query?.token;

    if (token) {

      const decoded =
        decodeTarget(
          token
        );

      if (!decoded) {
        return res
          .status(403)
          .json({
            success: false,
            error:
              "Invalid stream token"
          });
      }

      /*
       * التأكد أن الـ Token
       * خاص بنفس القناة
       */
      if (
        decoded.c !==
        channelName
      ) {
        return res
          .status(403)
          .json({
            success: false,
            error:
              "Invalid channel"
          });
      }

      /*
       * التأكد أن المصدر
       * من Host مسموح
       */
      if (
        !isAllowedUrl(
          channel,
          decoded.u
        )
      ) {
        return res
          .status(403)
          .json({
            success: false,
            error:
              "Upstream URL is not allowed"
          });
      }

      target =
        decoded.u;
    }

    /*
     * =====================================================
     * Headers
     * =====================================================
     */

    const headers = {
      ...(channel.headers || {})
    };

    /*
     * إزالة Headers الفارغة
     */
    for (
      const key of Object.keys(
        headers
      )
    ) {
      if (
        !headers[key]
      ) {
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
      headers["User-Agent"] =
        "SUPER2026";
    }

    /*
     * Range
     */
    if (
      req.headers.range
    ) {
      headers.Range =
        req.headers.range;
    }

    /*
     * =====================================================
     * Fetch
     * =====================================================
     */

    const upstream =
      await fetch(
        target,
        {
          method:
            req.method,
          headers,
          redirect:
            "follow"
        }
      );

    const contentType =
      upstream.headers.get(
        "content-type"
      ) || "";

    const finalUrl =
      upstream.url ||
      target;

    const isM3U8 =
      /mpegurl|vnd\.apple\.mpegurl/i.test(
        contentType
      ) ||
      /\.m3u8(?:\?|$)/i.test(
        finalUrl
      );

    /*
     * =====================================================
     * CORS
     * =====================================================
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
     * =====================================================
     * Upstream Error
     * =====================================================
     */

    if (!upstream.ok) {

      const body =
        await upstream
          .text()
          .catch(
            () => ""
          );

      return res
        .status(
          upstream.status
        )
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
     * =====================================================
     * M3U8
     * =====================================================
     */

    if (isM3U8) {

      if (
        req.method ===
        "HEAD"
      ) {
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

      /*
       * منع أي URL أصلي
       * ممكن يكون متبقي
       *
       * الروابط التي يسمح بها
       * فقط هي الروابط التي
       * تم تحويلها إلى Token.
       */

      res.setHeader(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );

      return res
        .status(200)
        .send(
          rewritten
        );
    }

    /*
     * =====================================================
     * Binary Segments
     * =====================================================
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
      req.method ===
      "HEAD"
    ) {
      return res
        .status(
          upstream.status
        )
        .end();
    }

    const buffer =
      Buffer.from(
        await upstream.arrayBuffer()
      );

    return res
      .status(
        upstream.status
      )
      .send(
        buffer
      );

  } catch (error) {

    console.error(
      "Proxy error:",
      error
    );

    return res
      .status(500)
      .json({
        success: false,
        error:
          "Proxy error",
        message:
          error.message
      });
  }
}
