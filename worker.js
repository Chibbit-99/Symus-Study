/**
 * Symus Study Cloudflare Worker
 * Deployed at https://symus-backend.chibbit99.workers.dev
 *
 * Routes:
 *   GET  /health     - health check
 *   POST /api/notes  - forwards a request to NVIDIA NIM. The caller supplies
 *                      their own API key in the Authorization header; it is
 *                      forwarded upstream and never stored or logged here.
 *
 * Configuration (wrangler.toml [vars] or the dashboard):
 *   SYMUS_ORIGIN  - comma-separated list of allowed browser origins.
 *                   Defaults to https://chibbit-99.github.io.
 *                   localhost / 127.0.0.1 / [::1] on any port is always
 *                   allowed so the app can be run over `python3 -m http.server`.
 *   SYMUS_MODELS  - comma-separated list of allowed model ids.
 *                   Defaults to nvidia/nemotron-3.5-lightning-30b-a3b.
 */

const NIM_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";

const DEFAULT_ALLOWED_ORIGINS = ["https://chibbit-99.github.io"];
const DEFAULT_ALLOWED_MODELS = ["nvidia/nemotron-3.5-lightning-30b-a3b"];

// Local development origins. Browsers send an Origin header for these too.
const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

const MAX_BODY_BYTES = 1_000_000;
const MAX_MESSAGES = 32;
const MAX_MESSAGE_CHARS = 500_000;
const MAX_OUTPUT_TOKENS = 8192;
const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

function parseList(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function isAllowedOrigin(origin, allowedOrigins) {
  if (!origin) return false;
  return allowedOrigins.includes(origin) || LOCAL_ORIGIN.test(origin);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

/**
 * Validate the incoming payload and build the exact upstream body.
 *
 * Only known fields are forwarded, so the Worker cannot be used as a general
 * relay for arbitrary NVIDIA NIM requests.
 */
function prepareUpstreamBody(raw, allowedModels) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: "Invalid JSON request body." };
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object." };
  }

  if (typeof data.model !== "string" || !data.model.trim()) {
    return { error: "model is required." };
  }
  if (!allowedModels.includes(data.model)) {
    return {
      error: `Model "${data.model}" is not allowed by this Worker.`,
      detail: `Allowed models: ${allowedModels.join(", ")}.`,
    };
  }

  if (!Array.isArray(data.messages) || data.messages.length === 0) {
    return { error: "messages must be a non-empty array." };
  }
  if (data.messages.length > MAX_MESSAGES) {
    return { error: `messages cannot contain more than ${MAX_MESSAGES} entries.` };
  }

  let totalChars = 0;
  const messages = [];
  for (const message of data.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { error: "Each message must be an object." };
    }
    if (!ALLOWED_ROLES.has(message.role)) {
      return { error: 'Each message role must be "system", "user", or "assistant".' };
    }
    if (typeof message.content !== "string" || !message.content.trim()) {
      return { error: "Each message content must be a non-empty string." };
    }
    if (message.content.length > MAX_MESSAGE_CHARS) {
      return { error: `A single message cannot exceed ${MAX_MESSAGE_CHARS} characters.` };
    }
    totalChars += message.content.length;
    messages.push({ role: message.role, content: message.content });
  }
  if (totalChars > MAX_MESSAGE_CHARS) {
    return { error: `Request text cannot exceed ${MAX_MESSAGE_CHARS} characters in total.` };
  }

  const body = {
    model: data.model,
    messages,
    stream: false,
  };

  if (data.max_tokens !== undefined) {
    if (!Number.isInteger(data.max_tokens) || data.max_tokens < 1 || data.max_tokens > MAX_OUTPUT_TOKENS) {
      return { error: `max_tokens must be an integer between 1 and ${MAX_OUTPUT_TOKENS}.` };
    }
    body.max_tokens = data.max_tokens;
  }
  if (data.temperature !== undefined) {
    if (typeof data.temperature !== "number" || data.temperature < 0 || data.temperature > 2) {
      return { error: "temperature must be a number between 0 and 2." };
    }
    body.temperature = data.temperature;
  }
  if (data.top_p !== undefined) {
    if (typeof data.top_p !== "number" || data.top_p <= 0 || data.top_p > 1) {
      return { error: "top_p must be a number greater than 0 and at most 1." };
    }
    body.top_p = data.top_p;
  }
  if (data.chat_template_kwargs !== undefined) {
    const kwargs = data.chat_template_kwargs;
    if (!kwargs || typeof kwargs !== "object" || Array.isArray(kwargs)) {
      return { error: "chat_template_kwargs must be an object." };
    }
    if (typeof kwargs.enable_thinking !== "boolean") {
      return { error: "chat_template_kwargs.enable_thinking must be a boolean." };
    }
    body.chat_template_kwargs = { enable_thinking: kwargs.enable_thinking };
  }

  return { body: JSON.stringify(body) };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = parseList(env.SYMUS_ORIGIN, DEFAULT_ALLOWED_ORIGINS);
    const allowedModels = parseList(env.SYMUS_MODELS, DEFAULT_ALLOWED_MODELS);
    const originAllowed = isAllowedOrigin(origin, allowedOrigins);
    const cors = originAllowed ? corsHeaders(origin) : {};

    if (request.method === "OPTIONS") {
      if (!originAllowed) {
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

    // Browser requests must come from an allowed origin. Requests without an
    // Origin header (curl, server-to-server) are still subject to the payload
    // validation and model allow-list below.
    if (origin && !originAllowed) {
      return json({ error: "Origin not allowed" }, 403);
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
    if (declaredLength > MAX_BODY_BYTES) {
      return json({ error: "Request body is too large (maximum 1 MB)." }, 413, cors);
    }

    let rawBody;
    try {
      rawBody = await request.text();
    } catch (error) {
      return json({ error: "Could not read the request body." }, 400, cors);
    }
    if (rawBody.length > MAX_BODY_BYTES) {
      return json({ error: "Request body is too large (maximum 1 MB)." }, 413, cors);
    }

    const prepared = prepareUpstreamBody(rawBody, allowedModels);
    if (prepared.error) {
      return json({ error: prepared.error, detail: prepared.detail }, 400, cors);
    }

    try {
      const upstream = await fetch(NIM_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: prepared.body,
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
      return json(
        {
          error: "Could not reach NVIDIA NIM.",
          detail: error instanceof Error ? error.message : String(error),
        },
        502,
        cors,
      );
    }
  },
};
