/**
 * Symus Study Cloudflare Worker
 *
 * Routes:
 *   GET  /health     - health check
 *   POST /api/notes  - forwards a request to NVIDIA NIM without exposing a
 *                      server-side API key (the user's key is forwarded in
 *                      the Authorization header and is never stored here).
 *
 * Deploy this as a Cloudflare Worker, then set SYMUS_ORIGIN to the exact
 * frontend origin, e.g. https://chibbit-99.github.io
 */

const NIM_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_ALLOWED_ORIGIN = "https://chibbit-99.github.io";

function corsHeaders(origin, allowedOrigin) {
  const allowed = origin === allowedOrigin ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.SYMUS_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
    const cors = corsHeaders(origin, allowedOrigin);

    if (request.method === "OPTIONS") {
      if (origin !== allowedOrigin) {
        return new Response("Origin not allowed", { status: 403 });
      }
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405, cors);
      }
      return json({ ok: true, service: "symus-study-worker" }, 200, cors);
    }

    if (origin && origin !== allowedOrigin) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    if (url.pathname !== "/api/notes") {
      return json({ error: "Not found" }, 404, cors);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, cors);
    }

    const authorization = request.headers.get("Authorization");
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
      return json({ error: "Missing NVIDIA API key. Send Authorization: Bearer YOUR_KEY." }, 401, cors);
    }

    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return json({ error: "Content-Type must be application/json." }, 415, cors);
    }

    const declaredLength = Number(request.headers.get("Content-Length") || 0);
    if (declaredLength > 1_000_000) {
      return json({ error: "Request body is too large (maximum 1 MB)." }, 413, cors);
    }

    let body;
    try {
      body = await request.text();
      if (body.length > 1_000_000) {
        return json({ error: "Request body is too large (maximum 1 MB)." }, 413, cors);
      }
      JSON.parse(body);
    } catch {
      return json({ error: "Invalid JSON request body." }, 400, cors);
    }

    try {
      const upstream = await fetch(NIM_ENDPOINT, {
        method: "POST",
        headers: {
          "Authorization": authorization,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body,
      });

      const responseHeaders = new Headers(cors);
      responseHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "application/json; charset=utf-8");
      responseHeaders.set("Cache-Control", "no-store");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      return json({ error: "Could not reach NVIDIA NIM.", detail: error instanceof Error ? error.message : String(error) }, 502, cors);
    }
  },
};
