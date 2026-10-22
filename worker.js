/**
 * Symus Study Cloudflare Worker
 * Deployed at https://symus-backend.chibbit99.workers.dev
 *
 * Routes:
 *   GET  /health      - health check
 *   GET  /api/models  - lists the NVIDIA NIM models this app may use, filtered
 *                       to the families configured below. The caller's key is
 *                       forwarded upstream so NVIDIA decides what is visible to
 *                       their account; nothing is stored or logged here.
 *   POST   /api/shares      - store a one-time study-kit share (all of its study
 *                             documents) in the SHARING_KV namespace. Returns the
 *                             id the app puts in #/share/<id>.
 *   GET    /api/shares/<id> - read a share. Does not delete it: the recipient's
 *                             browser deletes it only after they add the kit to
 *                             their library, so cancelling leaves the link alive.
 *   DELETE /api/shares/<id> - delete a share (one-time links).
 *
 *   POST /api/notes   - forwards a chat request to NVIDIA NIM. The caller
 *                       supplies their own API key in the Authorization header.
 *                       Pass {"stream": true} in the body to receive the
 *                       upstream server-sent events (SSE) as they arrive, so
 *                       the app can show a study document being written.
 *
 * Configuration (wrangler.toml [vars] or the dashboard):
 *   SYMUS_ORIGIN        - comma-separated allowed browser origins.
 *                         Defaults to https://chibbit-99.github.io.
 *                         localhost / 127.0.0.1 / [::1] on any port is always
 *                         allowed for local development.
 *   SYMUS_MODEL_FILTER  - comma-separated substrings. A model id is offered (and
 *                         accepted) only if it contains at least one of them.
 *                         Default: deepseek,step,nemotron,mistral,gemma,glm,muse
 *   SYMUS_MODELS        - optional extra comma-separated model ids that are
 *                         allowed even if they match no filter substring.
 *
 * Bindings:
 *   SHARING_KV          - KV namespace used for one-time kit shares.
 *   SYMUS_SHARE_TTL     - optional share lifetime in seconds (default 604800,
 *                         i.e. seven days). Shares are deleted when first read.
 */

const NIM_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const NIM_MODELS_ENDPOINT = "https://integrate.api.nvidia.com/v1/models";

const DEFAULT_ALLOWED_ORIGINS = ["https://chibbit-99.github.io"];

// Model families this app offers. Keep in sync with MODEL_FILTER in src/ai.js,
// which filters defensively on the client too.
const DEFAULT_MODEL_FILTER = ["deepseek", "step", "nemotron", "mistral", "gemma", "glm", "muse"];

// Local development origins. Browsers send an Origin header for these too.
const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

const MAX_BODY_BYTES = 1_000_000;
// Shares carry the finished study documents (markdown), not the PDFs.
const MAX_SHARE_BYTES = 900_000;
const MAX_SHARE_RESOURCES = 40;
const MAX_SHARE_DOC_CHARS = 400_000;
const MAX_SHARE_NAME_CHARS = 200;
const DEFAULT_SHARE_TTL = 604800; // 7 days
const SHARE_ID_LENGTH = 10;
// No look-alike characters, so a link can be read aloud or retyped.
const SHARE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const MAX_MESSAGES = 32;
const MAX_MESSAGE_CHARS = 500_000;
const MAX_OUTPUT_TOKENS = 8192;
const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

/** Normalise a model id for matching: lowercase, no vendor prefix. */
function modelKey(id) {
  return String(id || "")
    .toLowerCase()
    .trim();
}

/** True if the id contains at least one filter substring, or is explicitly listed. */
function isAllowedModel(id, filter, extra) {
  const key = modelKey(id);
  if (!key) return false;
  if (extra.some((entry) => modelKey(entry) === key)) return true;
  return filter.some((part) => part && key.includes(modelKey(part)));
}

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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

/** Random, unguessable share id. */
function newShareId() {
  const bytes = new Uint8Array(SHARE_ID_LENGTH);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) id += SHARE_ALPHABET[byte % SHARE_ALPHABET.length];
  return id;
}

function shareKey(id) {
  return "share:" + id;
}

/** Route a share id out of /api/shares/<id>, or null if the path is not one. */
function shareIdFromPath(pathname) {
  const match = /^\/api\/shares\/([a-z0-9]{4,64})\/?$/.exec(pathname);
  return match ? match[1] : null;
}

/**
 * Validate a share payload and return the exact record to store.
 *
 * Only what the reader needs is kept: the kit's name and subject, and each
 * resource's name and finished study document. No API keys, no questions, no
 * file bytes.
 */
function prepareShare(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: "Invalid JSON request body." };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object." };
  }

  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name) return { error: "name is required." };
  if (name.length > MAX_SHARE_NAME_CHARS) {
    return { error: `name cannot exceed ${MAX_SHARE_NAME_CHARS} characters.` };
  }

  const subject = typeof data.subject === "string" ? data.subject.trim().slice(0, MAX_SHARE_NAME_CHARS) : "";

  if (!Array.isArray(data.resources) || data.resources.length === 0) {
    return { error: "resources must be a non-empty array of study documents." };
  }
  if (data.resources.length > MAX_SHARE_RESOURCES) {
    return { error: `A share cannot contain more than ${MAX_SHARE_RESOURCES} resources.` };
  }

  const resources = [];
  for (const entry of data.resources) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: "Each resource must be an object." };
    }
    const resourceName = typeof entry.name === "string" ? entry.name.trim() : "";
    const document = typeof entry.document === "string" ? entry.document : "";
    if (!resourceName) return { error: "Each resource needs a name." };
    if (!document.trim()) return { error: `Resource "${resourceName}" has an empty study document.` };
    if (document.length > MAX_SHARE_DOC_CHARS) {
      return { error: `Resource "${resourceName}" is too large to share (limit ${MAX_SHARE_DOC_CHARS} characters).` };
    }
    resources.push({
      name: resourceName.slice(0, MAX_SHARE_NAME_CHARS),
      type: entry.type === "pdf" ? "pdf" : "text",
      document,
    });
  }

  const record = {
    name,
    subject,
    sharedAt: new Date().toISOString(),
    resources,
  };
  const body = JSON.stringify(record);
  if (body.length > MAX_SHARE_BYTES) {
    return { error: `This kit is too large to share (limit ${Math.round(MAX_SHARE_BYTES / 1000)} kB of study documents).` };
  }
  return { record, body };
}

function shareTtl(env) {
  const configured = Number(env.SYMUS_SHARE_TTL);
  if (Number.isFinite(configured) && configured >= 60 && configured <= 31536000) return Math.round(configured);
  return DEFAULT_SHARE_TTL;
}

function kvMissing(cors) {
  return json(
    {
      error: "Sharing is not configured on this Worker.",
      detail: "Add a KV namespace binding named SHARING_KV and redeploy.",
    },
    503,
    cors,
  );
}

/**
 * Validate the incoming payload and build the exact upstream body.
 *
 * Only known fields are forwarded, so the Worker cannot be used as a general
 * relay for arbitrary NVIDIA NIM requests.
 */
function prepareUpstreamBody(raw, filter, extraModels) {
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
  if (!isAllowedModel(data.model, filter, extraModels)) {
    return {
      error: `Model "${data.model}" is not allowed by this Worker.`,
      detail: `Allowed model families: ${filter.join(", ")}.`,
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

  // Streaming is opt-in. The response is piped straight through, so the client
  // sees the model's Server-Sent Events as they arrive.
  let stream = false;
  if (data.stream !== undefined) {
    if (typeof data.stream !== "boolean") {
      return { error: "stream must be a boolean." };
    }
    stream = data.stream;
  }

  const body = {
    model: data.model,
    messages,
    stream,
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

  return { body: JSON.stringify(body), stream };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = parseList(env.SYMUS_ORIGIN, DEFAULT_ALLOWED_ORIGINS);
    const modelFilter = parseList(env.SYMUS_MODEL_FILTER, DEFAULT_MODEL_FILTER);
    const extraModels = parseList(env.SYMUS_MODELS, []);
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

    /* ---------------- one-time kit shares ---------------- */

    if (url.pathname === "/api/shares" || url.pathname === "/api/shares/") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405, cors);
      }
      if (!env.SHARING_KV) return kvMissing(cors);

      const contentType = request.headers.get("Content-Type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        return json({ error: "Content-Type must be application/json." }, 415, cors);
      }

      const declared = Number(request.headers.get("Content-Length") || 0);
      if (declared > MAX_SHARE_BYTES + 10_000) {
        return json({ error: "A share cannot be larger than 900 kB." }, 413, cors);
      }

      let rawBody;
      try {
        rawBody = await request.text();
      } catch (error) {
        return json({ error: "Could not read the request body." }, 400, cors);
      }
      if (rawBody.length > MAX_SHARE_BYTES + 10_000) {
        return json({ error: "A share cannot be larger than 900 kB." }, 413, cors);
      }

      const prepared = prepareShare(rawBody);
      if (prepared.error) return json({ error: prepared.error }, 400, cors);

      const ttl = shareTtl(env);
      try {
        // Retry once on the (very unlikely) id collision.
        for (let attempt = 0; attempt < 3; attempt++) {
          const id = newShareId();
          const existing = await env.SHARING_KV.get(shareKey(id));
          if (existing !== null) continue;
          await env.SHARING_KV.put(shareKey(id), prepared.body, { expirationTtl: ttl });
          return json(
            {
              id,
              expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
              resources: prepared.record.resources.length,
            },
            201,
            cors,
          );
        }
        return json({ error: "Could not allocate a share id. Try again." }, 503, cors);
      } catch (error) {
        return json(
          { error: "Could not store the share.", detail: error instanceof Error ? error.message : String(error) },
          502,
          cors,
        );
      }
    }

    const shareId = shareIdFromPath(url.pathname);
    if (shareId) {
      if (!env.SHARING_KV) return kvMissing(cors);

      if (request.method === "GET") {
        let stored;
        try {
          stored = await env.SHARING_KV.get(shareKey(shareId));
        } catch (error) {
          return json(
            { error: "Could not read the share.", detail: error instanceof Error ? error.message : String(error) },
            502,
            cors,
          );
        }
        if (stored === null) {
          return json({ error: "This link has already been used or has expired.", gone: true }, 404, cors);
        }
        // Returned as stored JSON; re-wrapped so the response is always ours.
        let payload;
        try {
          payload = JSON.parse(stored);
        } catch {
          return json({ error: "This share is unreadable." }, 502, cors);
        }
        return json({ id: shareId, ...payload }, 200, cors);
      }

      if (request.method === "DELETE") {
        try {
          await env.SHARING_KV.delete(shareKey(shareId));
        } catch (error) {
          return json(
            { error: "Could not delete the share.", detail: error instanceof Error ? error.message : String(error) },
            502,
            cors,
          );
        }
        // Deleting an already-gone share is not an error: it is the goal.
        return json({ ok: true, id: shareId }, 200, cors);
      }

      return json({ error: "Method not allowed" }, 405, cors);
    }

    if (url.pathname === "/api/models") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405, cors);
      }

      const key = request.headers.get("Authorization");
      if (!key || !/^Bearer\s+\S+$/i.test(key)) {
        return json({ error: "Missing NVIDIA API key. Send Authorization: Bearer YOUR_KEY." }, 401, cors);
      }

      try {
        const upstream = await fetch(NIM_MODELS_ENDPOINT, {
          method: "GET",
          headers: { Authorization: key, Accept: "application/json" },
        });
        const raw = await upstream.text();

        if (!upstream.ok) {
          let detail = `HTTP ${upstream.status}`;
          try {
            const parsed = JSON.parse(raw);
            detail = (parsed.error && (parsed.error.message || parsed.error)) || detail;
          } catch {
            /* keep the status text */
          }
          return json({ error: "NVIDIA could not list models.", detail: String(detail) }, upstream.status, cors);
        }

        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return json({ error: "NVIDIA returned an unexpected model list." }, 502, cors);
        }

        const entries = Array.isArray(payload && payload.data)
          ? payload.data
          : Array.isArray(payload && payload.models)
            ? payload.models
            : [];

        const models = entries
          .map((entry) => (typeof entry === "string" ? { id: entry } : entry))
          .filter((entry) => entry && typeof entry.id === "string")
          .filter((entry) => isAllowedModel(entry.id, modelFilter, extraModels))
          .map((entry) => ({
            id: entry.id,
            ownedBy: typeof entry.owned_by === "string" ? entry.owned_by : typeof entry.publisher === "string" ? entry.publisher : "",
          }))
          .sort((a, b) => a.id.localeCompare(b.id));

        return json({ models, filter: modelFilter, count: models.length }, 200, cors);
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

    const prepared = prepareUpstreamBody(rawBody, modelFilter, extraModels);
    if (prepared.error) {
      return json({ error: prepared.error, detail: prepared.detail }, 400, cors);
    }

    try {
      const upstream = await fetch(NIM_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: prepared.stream ? "text/event-stream" : "application/json",
        },
        body: prepared.body,
      });

      // Streaming: hand the SSE body straight back. Content-Type is pinned (and
      // any buffering hint set) so no intermediary holds the events back.
      if (prepared.stream && upstream.ok && upstream.body) {
        const streamHeaders = new Headers(cors);
        streamHeaders.set("Content-Type", "text/event-stream; charset=utf-8");
        streamHeaders.set("Cache-Control", "no-store, no-transform");
        streamHeaders.set("X-Accel-Buffering", "no");
        return new Response(upstream.body, { status: 200, headers: streamHeaders });
      }

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
