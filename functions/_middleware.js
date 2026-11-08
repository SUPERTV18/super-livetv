import { handleStream } from "./_lib/proxy.js";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const segments = url.pathname.split("/").filter(Boolean);

  // /CHANNEL_NAME.m3u8
  if (segments.length === 1 && /\.m3u8$/i.test(segments[0])) {
    return handleStream(context.request, {
      channel: decodeURIComponent(segments[0].replace(/\.m3u8$/i, ""))
    }, context.env);
  }

  // /CHANNEL_NAME/TOKEN (rewritten playlists, keys and segments)
  if (segments.length === 2) {
    return handleStream(context.request, {
      channel: decodeURIComponent(segments[0]),
      token: decodeURIComponent(segments[1])
    }, context.env);
  }

  return context.next();
}
