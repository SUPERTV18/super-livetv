import fs from 'fs';
import path from 'path';

const channelsPath = path.join(process.cwd(), 'channels.json');
const channels = JSON.parse(fs.readFileSync(channelsPath, 'utf8'));

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length'
]);

function getChannelName(req) {
  const raw = req.query?.channel || req.query?.id || '';
  return String(raw).replace(/^\//, '').replace(/\.m3u8$/i, '');
}

function getUpstreamUrl(channel, req) {
  const requested = req.query?.url;
  if (!requested) return channel.url;

  let target;
  try {
    target = new URL(String(requested));
  } catch {
    return null;
  }

  // Do not turn this endpoint into a general-purpose open proxy.
  const base = new URL(channel.url);
  if (target.protocol !== base.protocol || target.hostname !== base.hostname) return null;

  return target.toString();
}

function proxyUrl(url, channelName, requestOrigin) {
  const p = new URL('/api/stream', requestOrigin);
  p.searchParams.set('channel', channelName);
  p.searchParams.set('url', url);
  return p.toString();
}

function rewriteM3U8(text, baseUrl, channelName, requestOrigin) {
  // Rewrite URI="..." attributes such as EXT-X-KEY and EXT-X-MAP.
  let output = text.replace(/URI="([^"]+)"/gi, (match, uri) => {
    try {
      const absolute = new URL(uri, baseUrl).toString();
      return `URI="${proxyUrl(absolute, channelName, requestOrigin)}"`;
    } catch {
      return match;
    }
  });

  // Rewrite playlist/segment lines.
  output = output.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;

    try {
      const absolute = new URL(trimmed, baseUrl).toString();
      return proxyUrl(absolute, channelName, requestOrigin);
    } catch {
      return line;
    }
  }).join('\n');

  return output;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return res.status(405).send('Method Not Allowed');
    }

    const channelName = getChannelName(req);
    const channel = channels[channelName];

    if (!channel?.url) {
      return res.status(404).json({ success: false, error: 'Channel not found' });
    }

    const target = getUpstreamUrl(channel, req);
    if (!target) {
      return res.status(403).json({ success: false, error: 'Upstream URL is not allowed for this channel' });
    }

    const headers = { ...(channel.headers || {}) };
    if (!headers['User-Agent'] && !headers['user-agent']) {
      headers['User-Agent'] = 'SUPER2026';
    }

    // Forward Range when a player requests partial media data.
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      redirect: 'follow'
    });

    const contentType = upstream.headers.get('content-type') || '';
    const isM3U8 = /mpegurl|vnd\.apple\.mpegurl/i.test(contentType) || /\.m3u8(?:\?|$)/i.test(target);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      return res.status(upstream.status).send(`Upstream error: ${upstream.status}${body ? `\n${body.slice(0, 500)}` : ''}`);
    }

    if (isM3U8) {
      if (req.method === 'HEAD') return res.status(200).end();

      const text = await upstream.text();
      const requestOrigin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
      const rewritten = rewriteM3U8(text, target, channelName, requestOrigin);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.status(200).send(rewritten);
    }

    for (const [key, value] of upstream.headers.entries()) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) res.setHeader(key, value);
    }

    if (req.method === 'HEAD') return res.status(upstream.status).end();

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ success: false, error: 'Proxy error', message: error.message });
  }
}
