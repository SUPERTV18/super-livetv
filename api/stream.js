import fs from 'fs';
import path from 'path';

const channelsPath = path.join(process.cwd(), 'channels.json');
const channels = JSON.parse(
  fs.readFileSync(channelsPath, 'utf8')
);

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length'
]);

function getChannelName(req) {
  const raw =
    req.query?.channel ||
    req.query?.id ||
    '';

  return String(raw)
    .replace(/^\//, '')
    .replace(/\.m3u8$/i, '')
    .split('/')[0];
}

/*
 * المسار الداخلي النظيف بعد اسم القناة
 *
 * مثال:
 * /SUPERTV_1/proxy/playlist.m3u8
 *
 * يصبح:
 * /proxy/playlist.m3u8
 */
function getCleanPath(req) {
  let value =
    req.query?.path ||
    req.query?.p ||
    '';

  value = String(value);

  if (!value) {
    return '';
  }

  if (!value.startsWith('/')) {
    value = '/' + value;
  }

  return value;
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
          new URL(`https://${host}`).hostname
        );
      } catch {
        // Ignore invalid hosts
      }
    }
  }

  return hosts;
}

function getUpstreamUrl(channel, req) {
  /*
   * السماح بالطريقة القديمة أيضًا
   * حتى لا تتعطل أي روابط قديمة.
   */
  const requested =
    req.query?.url;

  if (requested) {
    let target;

    try {
      target = new URL(
        String(requested)
      );
    } catch {
      return null;
    }

    const allowedHosts =
      getAllowedHosts(channel);

    if (
      target.protocol !== 'http:' &&
      target.protocol !== 'https:'
    ) {
      return null;
    }

    if (
      !allowedHosts.has(
        target.hostname
      )
    ) {
      return null;
    }

    return target.toString();
  }

  /*
   * الرابط الأساسي للقناة
   */
  if (!getCleanPath(req)) {
    return channel.url;
  }

  const cleanPath =
    getCleanPath(req);

  let baseUrl;

  try {
    baseUrl = new URL(
      channel.url
    );
  } catch {
    return null;
  }

  /*
   * نأخذ مجلد الـ M3U8 الأساسي.
   *
   * مثال:
   * https://host.com/proxy/playlist.m3u8
   *
   * المجلد:
   * /proxy/
   */
  const baseDirectory =
    new URL(
      './',
      channel.url
    );

  /*
   * إذا كان المسار يبدأ بنفس مسار
   * مجلد الـ upstream نستخدمه مباشرة.
   */
  let target;

  try {
    target = new URL(
      cleanPath,
      baseUrl.origin
    );
  } catch {
    return null;
  }

  /*
   * لو الرابط النظيف كان:
   *
   * /proxy/segment.ts
   *
   * نستخدمه مباشرة.
   *
   * أما لو كان:
   *
   * /segment.ts
   *
   * نربطه بمجلد الـ M3U8 الأصلي.
   */
  if (
    cleanPath.split('/').filter(Boolean).length === 1
  ) {
    target = new URL(
      cleanPath.replace(/^\//, ''),
      baseDirectory
    );
  }

  const allowedHosts =
    getAllowedHosts(channel);

  if (
    !allowedHosts.has(
      target.hostname
    )
  ) {
    return null;
  }

  return target.toString();
}

/*
 * تحويل رابط الـ upstream إلى رابط نظيف.
 *
 * مثال:
 *
 * https://host.com/proxy/segment.ts
 *
 * يصبح:
 *
 * https://super-livetv.vercel.app/SUPERTV_1/proxy/segment.ts
 */
function proxyUrl(
  url,
  channelName,
  requestOrigin
) {
  const target =
    new URL(url);

  const cleanPath =
    target.pathname +
    target.search;

  const p =
    new URL(
      `/${channelName}${cleanPath}`,
      requestOrigin
    );

  return p.toString();
}

function rewriteM3U8(
  text,
  baseUrl,
  channelName,
  requestOrigin
) {
  /*
   * Rewrite URI="..."
   *
   * مثل:
   * EXT-X-KEY
   * EXT-X-MAP
   * EXT-X-MEDIA
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

          return `URI="${proxyUrl(
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
   * Rewrite playlists / segments
   */
  output = output
    .split(/\r?\n/)
    .map((line) => {
      const trimmed =
        line.trim();

      if (
        !trimmed ||
        trimmed.startsWith('#')
      ) {
        return line;
      }

      try {
        const absolute =
          new URL(
            trimmed,
            baseUrl
          ).toString();

        return proxyUrl(
          absolute,
          channelName,
          requestOrigin
        );
      } catch {
        return line;
      }
    })
    .join('\n');

  return output;
}

export default async function handler(
  req,
  res
) {
  try {
    if (
      req.method !== 'GET' &&
      req.method !== 'HEAD'
    ) {
      res.setHeader(
        'Allow',
        'GET, HEAD'
      );

      return res
        .status(405)
        .send(
          'Method Not Allowed'
        );
    }

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
            'Channel not found'
        });
    }

    const target =
      getUpstreamUrl(
        channel,
        req
      );

    if (!target) {
      return res
        .status(403)
        .json({
          success: false,
          error:
            'Upstream URL is not allowed for this channel'
        });
    }

    const headers = {
      ...(channel.headers || {})
    };

    /*
     * Remove empty headers
     */
    for (
      const key of Object.keys(
        headers
      )
    ) {
      if (!headers[key]) {
        delete headers[key];
      }
    }

    /*
     * Default User-Agent
     */
    if (
      !headers['User-Agent'] &&
      !headers['user-agent']
    ) {
      headers['User-Agent'] =
        'SUPER2026';
    }

    /*
     * Forward Range
     */
    if (req.headers.range) {
      headers.Range =
        req.headers.range;
    }

    const upstream =
      await fetch(
        target,
        {
          method: req.method,
          headers,
          redirect: 'follow'
        }
      );

    const contentType =
      upstream.headers.get(
        'content-type'
      ) || '';

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
      'Access-Control-Allow-Origin',
      '*'
    );

    res.setHeader(
      'Access-Control-Allow-Headers',
      '*'
    );

    res.setHeader(
      'Access-Control-Expose-Headers',
      '*'
    );

    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, proxy-revalidate'
    );

    /*
     * Upstream Error
     */
    if (!upstream.ok) {
      const body =
        await upstream
          .text()
          .catch(() => '');

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
              : ''
          }`
        );
    }

    /*
     * M3U8
     */
    if (isM3U8) {
      if (
        req.method === 'HEAD'
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
            'x-forwarded-proto'
          ] || 'https'
        }://${
          req.headers.host
        }`;

      /*
       * مهم جدًا:
       *
       * نستخدم finalUrl بعد redirects
       * كـ base للروابط الموجودة
       * داخل الـ M3U8.
       */
      const rewritten =
        rewriteM3U8(
          text,
          finalUrl,
          channelName,
          requestOrigin
        );

      res.setHeader(
        'Content-Type',
        'application/vnd.apple.mpegurl'
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
      req.method === 'HEAD'
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
      .send(buffer);

  } catch (error) {
    console.error(
      'Proxy error:',
      error
    );

    return res
      .status(500)
      .json({
        success: false,
        error: 'Proxy error',
        message:
          error.message
      });
  }
}
