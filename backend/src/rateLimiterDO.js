export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const key = typeof payload?.key === "string" ? payload.key : null;
    const limit = Number.isFinite(payload?.limit) ? payload.limit : null;
    const windowMs = Number.isFinite(payload?.windowMs) ? payload.windowMs : null;

    if (!key || !limit || !windowMs || limit <= 0 || windowMs <= 0) {
      return new Response("Bad Request", { status: 400 });
    }

    const now = Date.now();
    const storageKey = `rl:${key}`;
    const entry = (await this.state.storage.get(storageKey)) || { count: 0, resetAt: 0 };

    let count = entry.count || 0;
    let resetAt = entry.resetAt || 0;

    if (!resetAt || now >= resetAt) {
      count = 0;
      resetAt = now + windowMs;
    }

    if (count >= limit) {
      return Response.json({ ok: false, remaining: 0, resetAt }, { status: 200 });
    }

    count += 1;
    await this.state.storage.put(storageKey, { count, resetAt });
    return Response.json({ ok: true, remaining: Math.max(0, limit - count), resetAt }, { status: 200 });
  }
}

