import { cleanup, isCronAuthorized } from "../lib/handlers.js";
import { blobStore } from "../lib/blob-store.js";

// Vercel Cron calls this with GET and sends Authorization: Bearer <CRON_SECRET>.
export async function GET(request: Request): Promise<Response> {
  if (!isCronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response(null, { status: 401 });
  }
  const deleted = await cleanup(blobStore, new Date());
  return Response.json({ deleted });
}
