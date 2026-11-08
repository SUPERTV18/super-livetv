import { handleStream } from "../functions/_lib/proxy.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    // Main channel playlist: /SUPERTV_1.m3u8
    if (segments.length === 1 && /\\.m3u8$/i.test(segments[0])) {
      return handleStream(request, {
        channel: decodeURIComponent(segments[0].replace(/\\.m3u8$/i, ""))
      }, env);
    }

    // Rewritten playlists, keys and media segments: /SUPERTV_1/TOKEN
    if (segments.length === 2) {
      return handleStream(request, {
        channel: decodeURIComponent(segments[0]),
        token: decodeURIComponent(segments[1])
      }, env);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS"
        }
      });
    }

    return new Response("SUPER LIVE TV Worker is running", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
};
