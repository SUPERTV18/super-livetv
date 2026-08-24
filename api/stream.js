import fs from "fs";
import path from "path";
import crypto from "crypto";

const channelsPath = path.join(
  process.cwd(),
  "channels.json"
);

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
 * =========================================================
 * AES-256-GCM SECRET
 * =========================================================
 *
 * ضع STREAM_SECRET في Vercel Environment Variables.
 *
 * يجب أن يكون Secret قويًا.
 */

const STREAM_SECRET =
  process.env.STREAM_SECRET ||
  "CHANGE_THIS_SECRET_IN_VERCEL";

/*
 * تحويل الـ Secret إلى مفتاح AES-256
 */
const AES_KEY = crypto
  .createHash("sha256")
  .update(STREAM_SECRET)
  .digest();

/*
 * =========================================================
 * ENCRYPT TOKEN
 * =========================================================
 *
 * الرابط الأصلي يتم تشفيره بالكامل.
 *
 * Token الناتج لا يحتوي على الرابط
 * كنص واضح.
 */

function encryptTarget(
  channelName,
  targetUrl
) {
  const iv =
    crypto.randomBytes(12);

  const cipher =
    crypto.createCipheriv(
      "aes-256-gcm",
      AES_KEY,
      iv
    );

  const payload =
    JSON.stringify({
      c: channelName,
      u: targetUrl,
      t: Date.now()
    });

  const encrypted = Buffer.concat([
    cipher.update(
      payload,
      "utf8"
    ),
    cipher.final()
  ]);

  const authTag =
    cipher.getAuthTag();

  /*
   * IV + AuthTag + Encrypted Data
   */
  return Buffer.concat([
    iv,
    authTag,
    encrypted
  ]).toString(
    "base64url"
  );
}

/*
 * =========================================================
 * DECRYPT TOKEN
 * =========================================================
 */

function decryptTarget(token) {
  try {
    const data =
      Buffer.from(
        String(token),
        "base64url"
      );

    /*
     * IV = 12 bytes
     * AuthTag = 16 bytes
     */
    if (
      data.length <
      12 + 16 + 1
    ) {
      return null;
    }

    const iv =
      data.subarray(
        0,
        12
      );

    const authTag =
      data.subarray(
        12,
        28
      );

    const encrypted =
      data.subarray(
        28
      );

    const decipher =
      crypto.createDecipheriv(
        "aes-256-gcm",
        AES_KEY,
        iv
      );

    decipher.setAuthTag(
      authTag
    );

    const decrypted =
      Buffer.concat([
        decipher.update(
          encrypted
        ),
        decipher.final()
      ]).toString(
        "utf8"
      );

    const payload =
      JSON.parse(
        decrypted
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
    /*
     * أي Token تم تعديله
     * أو Secret غير صحيح
     * يتم رفضه.
     */
    return null;
  }
}

/*
 * =========================================================
 * CHANNEL NAME
 * =========================================================
 */

function getChannelName(req) {
  const raw =
    req.query?.channel ||
    req.query?.id ||
    "";

  return String(raw)
    .replace(
      /^\/+/,
      ""
    )
    .replace(
      /\.m3u8$/i,
      ""
    );
}

/*
 * =========================================================
 * ALLOWED HOSTS
 * =========================================================
 */

function getAllowedHosts(
  channel
) {
  const hosts =
    new Set();

  try {
    const base =
      new URL(
        channel.url
      );

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
      const host of
        channel.allowedHosts
    ) {
      try {
        hosts.add(
          new URL(
            host.includes(
              "://"
            )
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
 * =========================================================
 * CHECK URL
 * =========================================================
 */

function isAllowedUrl(
  channel,
  target
) {
  try {
    const url =
      new URL(target);

    if (
      url.protocol !==
        "http:" &&
      url.protocol !==
        "https:"
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
 * CLEAN TOKEN URL
 * =========================================================
 */

function cleanProxyUrl(
  channelName,
  targetUrl,
  requestOrigin
) {
  const token =
    encryptTarget(
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
 * REWRITE M3U8
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
   */
  let output =
    text.replace(
      /URI="([^"]+)"/gi,
      (
        match,
        uri
      ) => {
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
  output =
    output
      .split(/\r?\n/)
      .map(
        (line) => {
          const trimmed =
            line.trim();

          if (
            !trimmed ||
            trimmed.startsWith(
              "#"
            )
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
        }
      )
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
      req.method !==
        "GET" &&
      req.method !==
        "HEAD"
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
     * منع url= نهائيًا
     * =====================================================
     */

    if (
      req.query?.url
    ) {
      return res
        .status(403)
        .json({
          success:
            false,
          error:
            "Direct upstream URL access is disabled"
        });
    }

    /*
     * Channel
     */
    const channelName =
      getChannelName(
        req
      );

    const channel =
      channels[
        channelName
      ];

    if (
      !channel?.url
    ) {
      return res
        .status(404)
        .json({
          success:
            false,
          error:
            "Channel not found"
        });
    }

    /*
     * =====================================================
     * TARGET
     * =====================================================
     */

    let target =
      channel.url;

    const token =
      req.query?.token;

    /*
     * طلب Token
     */
    if (token) {

      const decoded =
        decryptTarget(
          token
        );

      if (!decoded) {
        return res
          .status(403)
          .json({
            success:
              false,
            error:
              "Invalid or corrupted stream token"
          });
      }

      /*
       * التأكد من القناة
       */
      if (
        decoded.c !==
        channelName
      ) {
        return res
          .status(403)
          .json({
            success:
              false,
            error:
              "Invalid channel"
          });
      }

      /*
       * التأكد أن الرابط
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
            success:
              false,
            error:
              "Upstream URL is not allowed"
          });
      }

      target =
        decoded.u;
    }

    /*
     * =====================================================
     * HEADERS
     * =====================================================
     */

    const headers = {
      ...(channel.headers || {})
    };

    /*
     * إزالة Headers الفارغة
     */
    for (
      const key of
        Object.keys(
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
      !headers[
        "User-Agent"
      ] &&
      !headers[
        "user-agent"
      ]
    ) {
      headers[
        "User-Agent"
      ] = "SUPER2026";
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
     * FETCH
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
     * UPSTREAM ERROR
     * =====================================================
     */

    if (
      !upstream.ok
    ) {
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

    if (
      isM3U8
    ) {

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
     * BINARY
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

  } catch (
    error
  ) {

    console.error(
      "Proxy error:",
      error
    );

    return res
      .status(500)
      .json({
        success:
          false,
        error:
          "Proxy error",
        message:
          error.message
      });
  }
}
