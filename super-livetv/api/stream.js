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

function rewriteM3U8(text, baseUrl, channelName) {
  const lines = text.split(/\r?\n/);
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;

    try {
      const absolute = new URL(trimmed, baseUrl).toString();
      const url = new URL('/api/stream', baseUrl);
      url.searchParams.set('channel', channelName);
      url.searchParams.set('url', absolute);
      return url.toString();
    } catch {
      return line;
    }
  }).join('\n');
}

export default async function handler(req, res) {
  try {
    const channelName = getChannelName(req);
    const channel = channels[channelName];

    if (!channel?.url) {
      return res.status(404).json({ success: false, error: 'Channel not found' });
    }

    const target = req.query?.url ? String(req.query.url) : channel.url;
    const headers = { ...(channel.headers || {}) };

    if (!headers['User-Agent'] && !headers['user-agent']) {
      headers['User-Agent'] = 'SUPER2026';
    }

    const upstream = await fetch(target, {
      method: 'GET',
      headers,
      redirect: 'follow'
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream error: ${upstream.status}`);
    }

    const contentType = upstream.headers.get('content-type') || '';
    const isM3U8 = /mpegurl|vnd\.apple\.mpegurl/i.test(contentType) || /\.m3u8(?:\?|$)/i.test(target);

    if (isM3U8) {
      const text = await upstream.text();
      const rewritten = rewriteM3U8(text, target, channelName);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).send(rewritten);
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    for (const [key, value] of upstream.headers.entries()) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) res.setHeader(key, value);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).send(buffer);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: 'Proxy error' });
  }
}
