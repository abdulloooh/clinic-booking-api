import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { migrate, sql, type BookingRow, type SlotRow } from "./db.js";
import { newBookingId } from "./ids.js";
import {
  decodeCursor,
  encodeCursor,
  hashBody,
  isValidEmail,
  jsonError,
  toIso,
} from "./util.js";

const API_KEY = process.env.API_KEY || "";
const ready = migrate();

type SlotInput = {
  id: string;
  provider: string;
  start: string;
  end: string;
};

export function createApp() {
  const app = new Hono();

  // Vercel Hono entry expects `export default app` (see vercel.json framework).
  app.use("*", async (_c, next) => {
    await ready;
    await next();
  });

  app.use("*", cors());

  // Local: serve public/ from disk. On Vercel, assets are on the CDN; "/" proxies
  // the static index so the browser URL stays "/" (no redirect to /index.html).
  if (process.env.VERCEL) {
    app.get("/", async (c) => {
      const res = await fetch(new URL("/index.html", c.req.url));
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
  } else {
    app.use("/assets/*", serveStatic({ root: "./public" }));
    app.get("/", serveStatic({ root: "./public", path: "index.html" }));
  }

  app.use("/reset", requireApiKey);
  app.use("/slots", requireApiKey);
  app.use("/bookings", requireApiKey);
  app.use("/bookings/*", requireApiKey);

  app.post("/reset", async (c) => {
    let body: { slots?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json(jsonError("invalid json"), 400);
    }

    if (!body || !Array.isArray(body.slots)) {
      return c.json(jsonError("slots array is required"), 400);
    }

    for (const slot of body.slots) {
      if (
        !slot ||
        typeof slot !== "object" ||
        typeof (slot as SlotInput).id !== "string" ||
        typeof (slot as SlotInput).provider !== "string" ||
        typeof (slot as SlotInput).start !== "string" ||
        typeof (slot as SlotInput).end !== "string"
      ) {
        return c.json(jsonError("invalid slot"), 400);
      }
    }

    const slots = body.slots as SlotInput[];

    await sql.begin(async (tx) => {
      await tx`delete from booking_attempts`;
      await tx`delete from idempotency_keys`;
      await tx`delete from bookings`;
      await tx`delete from slots`;

      if (slots.length > 0) {
        await tx`
          insert into slots ${tx(
            slots.map((s) => ({
              id: s.id,
              provider: s.provider,
              start_at: new Date(s.start),
              end_at: new Date(s.end),
            })),
          )}
        `;
      }
    });

    return c.json({ ok: true });
  });

  app.get("/slots", async (c) => {
    const provider = c.req.query("provider");

    const rows = provider
      ? await sql`
          select
            s.id,
            s.provider,
            s.start_at,
            s.end_at,
            not exists (
              select 1 from bookings b
              where b.slot_id = s.id and b.status = 'confirmed'
            ) as available
          from slots s
          where s.provider = ${provider}
          order by s.start_at asc, s.id asc
        `
      : await sql`
          select
            s.id,
            s.provider,
            s.start_at,
            s.end_at,
            not exists (
              select 1 from bookings b
              where b.slot_id = s.id and b.status = 'confirmed'
            ) as available
          from slots s
          order by s.start_at asc, s.id asc
        `;

    return c.json({
      slots: rows.map((r) => ({
        id: r.id as string,
        provider: r.provider as string,
        start: toIso(r.start_at as Date),
        end: toIso(r.end_at as Date),
        available: Boolean(r.available),
      })),
    });
  });

  app.post("/bookings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(jsonError("invalid json"), 400);
    }

    const idempotencyKey = c.req.header("Idempotency-Key")?.trim() || null;
    const bodyHash = hashBody(body);

    // Serialize concurrent retries that share the same idempotency key.
    if (idempotencyKey) {
      return await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${idempotencyKey}))`;

        const existing = await tx<{
          body_hash: string;
          status_code: number;
          response: unknown;
        }[]>`
          select body_hash, status_code, response
          from idempotency_keys
          where key = ${idempotencyKey}
        `;

        if (existing[0]) {
          if (existing[0].body_hash !== bodyHash) {
            return c.json(jsonError("idempotency key reused with a different body"), 422);
          }
          const replayed = c.json(
            existing[0].response as object,
            existing[0].status_code as 200,
          );
          replayed.headers.set("Idempotent-Replayed", "true");
          return replayed;
        }

        return await handleNewBooking(c, tx, body, idempotencyKey, bodyHash);
      });
    }

    return await handleNewBooking(c, sql, body, null, bodyHash);
  });

  app.get("/bookings", async (c) => {
    const emailRaw = c.req.query("email");
    if (!emailRaw || !emailRaw.trim()) {
      return c.json(jsonError("email is required"), 400);
    }
    const email = emailRaw.trim().toLowerCase();

    const limitRaw = c.req.query("limit");
    let limit = 10;
    if (limitRaw !== undefined) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        return c.json(jsonError("limit must be between 1 and 50"), 400);
      }
    }

    const cursorRaw = c.req.query("cursor");
    let afterSeq = 0;
    if (cursorRaw) {
      const decoded = decodeCursor(cursorRaw);
      if (decoded === null) {
        return c.json(jsonError("invalid cursor"), 400);
      }
      afterSeq = decoded;
    }

    const rows = await sql<BookingRow[]>`
      select *
      from bookings
      where email = ${email}
        and seq > ${afterSeq}
      order by seq asc
      limit ${limit + 1}
    `;

    const page = rows.slice(0, limit);
    const next = rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null;

    return c.json({
      bookings: page.map(serializeBooking),
      next_cursor: next,
    });
  });

  app.get("/bookings/:id", async (c) => {
    const id = normalizeBookingId(c.req.param("id"));
    const rows = await sql<BookingRow[]>`
      select * from bookings where upper(replace(id, ' ', '')) = ${id}
    `;
    if (!rows[0]) {
      return c.json(jsonError("booking not found"), 404);
    }
    return c.json(serializeBooking(rows[0]));
  });

  app.delete("/bookings/:id", async (c) => {
    const id = normalizeBookingId(c.req.param("id"));
    const existing = await sql<BookingRow[]>`
      select * from bookings where upper(replace(id, ' ', '')) = ${id}
    `;
    if (!existing[0]) {
      return c.json(jsonError("booking not found"), 404);
    }
    if (existing[0].status === "cancelled") {
      return c.json(jsonError("booking already cancelled"), 409);
    }

    const updated = await sql<BookingRow[]>`
      update bookings
      set status = 'cancelled'
      where id = ${existing[0].id} and status = 'confirmed'
      returning *
    `;

    if (!updated[0]) {
      return c.json(jsonError("booking already cancelled"), 409);
    }

    return c.json(serializeBooking(updated[0]));
  });

  // Page helpers inject the API key so the browser never sees it.
  app.get("/web/slots", async (c) => {
    const provider = c.req.query("provider");
    const qs = provider ? `?provider=${encodeURIComponent(provider)}` : "";
    return app.request(`/slots${qs}`, {
      headers: { "X-API-Key": API_KEY },
    });
  });

  app.post("/web/bookings", async (c) => {
    const body = await c.req.text();
    const headers: Record<string, string> = {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
    };
    const key = c.req.header("Idempotency-Key");
    if (key) headers["Idempotency-Key"] = key;
    return app.request("/bookings", { method: "POST", headers, body });
  });

  app.get("/web/bookings", async (c) => {
    return app.request(`/bookings${new URL(c.req.url).search}`, {
      headers: { "X-API-Key": API_KEY },
    });
  });

  app.get("/web/bookings/:id", async (c) => {
    return app.request(`/bookings/${encodeURIComponent(c.req.param("id"))}`, {
      headers: { "X-API-Key": API_KEY },
    });
  });

  app.delete("/web/bookings/:id", async (c) => {
    return app.request(`/bookings/${encodeURIComponent(c.req.param("id"))}`, {
      method: "DELETE",
      headers: { "X-API-Key": API_KEY },
    });
  });

  app.get("/health", (c) => c.json({ ok: true }));

  return app;
}

// sql.begin's last overload is (options, cb); take the transaction client from that cb.
type SqlLike = typeof sql | Parameters<Parameters<typeof sql.begin>[1]>[0];

async function handleNewBooking(
  c: any,
  db: SqlLike,
  body: unknown,
  idempotencyKey: string | null,
  bodyHash: string,
) {
  const input = body as {
    slot_id?: unknown;
    name?: unknown;
    email?: unknown;
  };

  const slotId = typeof input.slot_id === "string" ? input.slot_id.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const emailRaw = typeof input.email === "string" ? input.email.trim() : "";
  const email = emailRaw.toLowerCase();

  // Cap attempts per email; idempotent replays never reach this path.
  if (email) {
    const limited = await checkRateLimit(db, email);
    if (limited) {
      const res = c.json(jsonError("too many booking attempts for this email"), 429);
      res.headers.set("Retry-After", String(limited.retryAfter));
      return res;
    }
    await db`insert into booking_attempts (email) values (${email})`;
  }

  if (!slotId || !name || !email) {
    return storeAndRespond(
      c,
      db,
      idempotencyKey,
      bodyHash,
      400,
      jsonError("slot_id, name and email are required"),
    );
  }
  if (!isValidEmail(email)) {
    return storeAndRespond(c, db, idempotencyKey, bodyHash, 400, jsonError("invalid email"));
  }

  const slots = await db<SlotRow[]>`select * from slots where id = ${slotId}`;
  const slot = slots[0];
  if (!slot) {
    return storeAndRespond(c, db, idempotencyKey, bodyHash, 404, jsonError("slot not found"));
  }

  if (new Date(slot.start_at).getTime() <= Date.now()) {
    return storeAndRespond(
      c,
      db,
      idempotencyKey,
      bodyHash,
      400,
      jsonError("slot has already started"),
    );
  }

  const bookingId = newBookingId();

  // Partial unique index on confirmed bookings decides the winner under races.
  const inserted = await db<BookingRow[]>`
    insert into bookings (id, slot_id, name, email, status)
    values (${bookingId}, ${slotId}, ${name}, ${email}, 'confirmed')
    on conflict do nothing
    returning *
  `;

  if (!inserted[0]) {
    return storeAndRespond(
      c,
      db,
      idempotencyKey,
      bodyHash,
      409,
      jsonError("slot already booked"),
    );
  }

  return storeAndRespond(c, db, idempotencyKey, bodyHash, 201, serializeBooking(inserted[0]));
}

/** Returns Retry-After seconds when this email already has 5 attempts in the last 60s. */
async function checkRateLimit(
  db: SqlLike,
  email: string,
): Promise<{ retryAfter: number } | null> {
  const windowStart = new Date(Date.now() - 60_000);
  const rows = await db<{ attempted_at: Date }[]>`
    select attempted_at
    from booking_attempts
    where email = ${email}
      and attempted_at > ${windowStart}
    order by attempted_at asc
  `;

  if (rows.length < 5) return null;

  const oldest = new Date(rows[0].attempted_at).getTime();
  const retryAfter = Math.max(1, Math.ceil((oldest + 60_000 - Date.now()) / 1000));
  return { retryAfter };
}

async function storeAndRespond(
  c: any,
  db: SqlLike,
  idempotencyKey: string | null,
  bodyHash: string,
  status: number,
  payload: object,
) {
  if (idempotencyKey && status !== 429) {
    await db`
      insert into idempotency_keys (key, body_hash, status_code, response)
      values (${idempotencyKey}, ${bodyHash}, ${status}, ${sql.json(payload as any)})
      on conflict (key) do nothing
    `;
  }
  return c.json(payload, status);
}

function serializeBooking(row: BookingRow) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: toIso(row.created_at),
  };
}

function normalizeBookingId(id: string): string {
  return id.replace(/\s+/g, "").toUpperCase();
}

async function requireApiKey(c: any, next: () => Promise<void>) {
  const key = c.req.header("X-API-Key");
  if (!API_KEY || key !== API_KEY) {
    return c.json(jsonError("unauthorized"), 401);
  }
  await next();
}

// Vercel detects Hono apps via default export of a Hono instance.
export default createApp();
