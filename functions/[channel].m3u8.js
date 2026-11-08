import { handleStream } from "./_lib/proxy.js";

export async function onRequest(context) {
  return handleStream(context.request, {
    channel: context.params.channel
  }, context.env);
}
