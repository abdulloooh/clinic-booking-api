import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/load-env.js";

config();

process.env.API_KEY = process.env.API_KEY || "test-api-key";

const { migrate, sql } = await import("../src/db.js");
const { createApp } = await import("../src/app.js");

const API_KEY = process.env.API_KEY!;
const app = createApp();

function futureSlots() {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 14);
  day.setUTCHours(9, 0, 0, 0);

  const mk = (id: string, provider: string, hour: number) => {
    const start = new Date(day);
    start.setUTCHours(hour, 0, 0, 0);
    const end = new Date(start);
    end.setUTCMinutes(30);
    return {
      id,
      provider,
      start: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
      end: end.toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
  };

  return [
    mk("s1", "Dr Ade", 9),
    mk("s2", "Dr Ade", 10),
    mk("s3", "Dr Bola", 9),
    mk("past", "Dr Ade", 8), // will overwrite to past below
  ].map((slot, index) => {
    if (slot.id === "past") {
      return {
        ...slot,
        start: "2020-01-01T09:00:00Z",
        end: "2020-01-01T09:30:00Z",
      };
    }
    return { ...slot, id: index === 3 ? "past" : slot.id };
  });
}

async function api(
  path: string,
  init: RequestInit & { apiKey?: string | null } = {},
) {
  const headers = new Headers(init.headers || {});
  if (init.apiKey !== null) {
    headers.set("X-API-Key", init.apiKey ?? API_KEY);
  }
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await app.request(path, { ...init, headers });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { res, json, headers: res.headers };
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await api("/reset", {
    method: "POST",
    body: JSON.stringify({ slots: futureSlots() }),
  });
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("auth (level 2)", () => {
  it("rejects missing or wrong API key", async () => {
    const missing = await api("/slots", { apiKey: null });
    expect(missing.res.status).toBe(401);
    expect(missing.json).toEqual({ error: "unauthorized" });

    const wrong = await api("/slots", { apiKey: "nope" });
    expect(wrong.res.status).toBe(401);
  });
});

describe("level 1 basics", () => {
  it("lists slots earliest first with availability", async () => {
    const { res, json } = await api("/slots");
    expect(res.status).toBe(200);
    expect(json.slots.map((s: any) => s.id)).toEqual(["past", "s1", "s3", "s2"]);
    expect(json.slots.every((s: any) => typeof s.available === "boolean")).toBe(true);
  });

  it("filters by provider", async () => {
    const { json } = await api("/slots?provider=Dr%20Bola");
    expect(json.slots).toHaveLength(1);
    expect(json.slots[0].id).toBe("s3");
  });

  it("books a slot and looks it up", async () => {
    const booked = await api("/bookings", {
      method: "POST",
      body: JSON.stringify({
        slot_id: "s1",
        name: " Ada Obi ",
        email: "Ada@Example.com",
      }),
    });
    expect(booked.res.status).toBe(201);
    expect(booked.json.status).toBe("confirmed");
    expect(booked.json.name).toBe("Ada Obi");
    expect(booked.json.email).toBe("ada@example.com");

    const got = await api(`/bookings/${booked.json.id}`);
    expect(got.res.status).toBe(200);
    expect(got.json.id).toBe(booked.json.id);

    const slots = await api("/slots");
    expect(slots.json.slots.find((s: any) => s.id === "s1").available).toBe(false);
  });
});

describe("level 2 validation", () => {
  it("turns away missing fields, bad email, unknown slot, and past slot", async () => {
    const missing = await api("/bookings", {
      method: "POST",
      body: JSON.stringify({ slot_id: "s1", name: "", email: "a@b.com" }),
    });
    expect(missing.res.status).toBe(400);

    const badEmail = await api("/bookings", {
      method: "POST",
      body: JSON.stringify({ slot_id: "s1", name: "Ada", email: "not-an-email" }),
    });
    expect(badEmail.res.status).toBe(400);

    const missingSlot = await api("/bookings", {
      method: "POST",
      body: JSON.stringify({ slot_id: "nope", name: "Ada", email: "ada@example.com" }),
    });
    expect(missingSlot.res.status).toBe(404);

    const past = await api("/bookings", {
      method: "POST",
      body: JSON.stringify({ slot_id: "past", name: "Ada", email: "ada@example.com" }),
    });
    expect(past.res.status).toBe(400);
  });
});

describe("level 3 concurrency and cancel", () => {
  it("allows only one winner when many book the same slot at once", async () => {
    const requests = Array.from({ length: 25 }, (_, i) =>
      api("/bookings", {
        method: "POST",
        body: JSON.stringify({
          slot_id: "s2",
          name: `Person ${i}`,
          email: `p${i}@example.com`,
        }),
      }),
    );

    const results = await Promise.all(requests);
    const created = results.filter((r) => r.res.status === 201);
    const conflicted = results.filter((r) => r.res.status === 409);

    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(24);

    const slots = await api("/slots");
    expect(slots.json.slots.find((s: any) => s.id === "s2").available).toBe(false);
  });

  it("cancels a booking and frees the slot", async () => {
    const booked = await api("/bookings", {
      method: "POST",
      body: JSON.stringify({
        slot_id: "s3",
        name: "Ada",
        email: "ada@example.com",
      }),
    });

    const cancelled = await api(`/bookings/${booked.json.id}`, { method: "DELETE" });
    expect(cancelled.res.status).toBe(200);
    expect(cancelled.json.status).toBe("cancelled");

    const again = await api(`/bookings/${booked.json.id}`, { method: "DELETE" });
    expect(again.res.status).toBe(409);

    const rebook = await api("/bookings", {
      method: "POST",
      body: JSON.stringify({
        slot_id: "s3",
        name: "Bola",
        email: "bola@example.com",
      }),
    });
    expect(rebook.res.status).toBe(201);
  });
});

describe("level 4 idempotency and pagination", () => {
  it("replays the same booking for the same key+body", async () => {
    const body = {
      slot_id: "s1",
      name: "Ada",
      email: "ada@example.com",
    };

    const first = await api("/bookings", {
      method: "POST",
      headers: { "Idempotency-Key": "key-1" },
      body: JSON.stringify(body),
    });
    expect(first.res.status).toBe(201);

    const second = await api("/bookings", {
      method: "POST",
      headers: { "Idempotency-Key": "key-1" },
      body: JSON.stringify(body),
    });
    expect(second.res.status).toBe(201);
    expect(second.json.id).toBe(first.json.id);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");

    const mismatch = await api("/bookings", {
      method: "POST",
      headers: { "Idempotency-Key": "key-1" },
      body: JSON.stringify({ ...body, name: "Other" }),
    });
    expect(mismatch.res.status).toBe(422);
  });

  it("pages a person's bookings oldest first", async () => {
    for (const slot of ["s1", "s2", "s3"]) {
      const r = await api("/bookings", {
        method: "POST",
        body: JSON.stringify({
          slot_id: slot,
          name: "Ada",
          email: "Ada@Example.com",
        }),
      });
      expect(r.res.status).toBe(201);
    }

    const page1 = await api("/bookings?email=ada@example.com&limit=2");
    expect(page1.res.status).toBe(200);
    expect(page1.json.bookings).toHaveLength(2);
    expect(page1.json.next_cursor).toBeTruthy();

    const page2 = await api(
      `/bookings?email=ada@example.com&limit=2&cursor=${page1.json.next_cursor}`,
    );
    expect(page2.json.bookings).toHaveLength(1);
    expect(page2.json.next_cursor).toBeNull();

    const badLimit = await api("/bookings?email=ada@example.com&limit=99");
    expect(badLimit.res.status).toBe(400);
  });
});

describe("level 5 rate limit", () => {
  it("blocks the 6th attempt for the same email within a minute", async () => {
    const email = `rate-${Date.now()}@example.com`;

    for (let i = 0; i < 5; i++) {
      const r = await api("/bookings", {
        method: "POST",
        body: JSON.stringify({
          slot_id: "missing",
          name: "Ada",
          email,
        }),
      });
      expect(r.res.status).toBe(404);
    }

    const sixth = await api("/bookings", {
      method: "POST",
      body: JSON.stringify({
        slot_id: "s1",
        name: "Ada",
        email,
      }),
    });
    expect(sixth.res.status).toBe(429);
    expect(sixth.headers.get("Retry-After")).toBeTruthy();
    expect(Number(sixth.headers.get("Retry-After"))).toBeGreaterThan(0);

    const other = await api("/bookings", {
      method: "POST",
      body: JSON.stringify({
        slot_id: "s1",
        name: "Other",
        email: "someone-else@example.com",
      }),
    });
    expect(other.res.status).toBe(201);
  });
});

describe("web helpers", () => {
  it("lets the page book, list, and page without sending an API key", async () => {
    const slots = await app.request("/web/slots");
    expect(slots.status).toBe(200);

    const booked = await app.request("/web/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot_id: "s1",
        name: "Web User",
        email: "web@example.com",
      }),
    });
    expect(booked.status).toBe(201);

    await app.request("/web/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot_id: "s2",
        name: "Web User",
        email: "web@example.com",
      }),
    });

    const page1 = await app.request("/web/bookings?email=web@example.com&limit=1");
    expect(page1.status).toBe(200);
    const page1Json = await page1.json();
    expect(page1Json.bookings).toHaveLength(1);
    expect(page1Json.next_cursor).toBeTruthy();

    const page2 = await app.request(
      `/web/bookings?email=web@example.com&limit=1&cursor=${page1Json.next_cursor}`,
    );
    const page2Json = await page2.json();
    expect(page2Json.bookings).toHaveLength(1);
    expect(page2Json.next_cursor).toBeNull();
  });
});
