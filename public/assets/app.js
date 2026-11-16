const slotsEl = document.getElementById("slots");
const providerEl = document.getElementById("provider");
const refreshBtn = document.getElementById("refresh");
const form = document.getElementById("book-form");
const slotIdEl = document.getElementById("slot_id");
const selectedEl = document.getElementById("selected");
const bookBtn = document.getElementById("book-btn");
const nameEl = document.getElementById("name");
const emailEl = document.getElementById("email");
const statusEl = document.getElementById("status");
const confirmation = document.getElementById("confirmation");
const confirmationBody = document.getElementById("confirmation-body");
const cancelBtn = document.getElementById("cancel-btn");
const retryBtn = document.getElementById("retry-btn");
const lookupForm = document.getElementById("lookup-form");
const lookupEmailEl = document.getElementById("lookup-email");
const bookingsEl = document.getElementById("bookings");
const bookingsPager = document.getElementById("bookings-pager");
const nextPageBtn = document.getElementById("next-page");
const bookingsMeta = document.getElementById("bookings-meta");

let currentBooking = null;
let lastBookRequest = null;
let bookingsCursor = null;
let bookingsEmail = "";
let allProviderNames = [];

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`.trim();
}

function formatWhen(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return { data, headers: res.headers };
}

function renderSlots(slots) {
  if (!slots.length) {
    slotsEl.innerHTML = `<p class="muted">No slots yet. Seed some with POST /reset.</p>`;
    return;
  }

  slotsEl.innerHTML = "";
  for (const slot of slots) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `slot ${slot.available ? "available" : "taken"}`;
    if (slotIdEl.value === slot.id) btn.classList.add("selected");
    btn.disabled = !slot.available;
    btn.innerHTML = `
      <div>
        <strong>${slot.provider}</strong>
        <span>${formatWhen(slot.start)} → ${formatWhen(slot.end)}</span>
      </div>
      <span>${slot.available ? "Available" : "Taken"}</span>
    `;
    btn.addEventListener("click", () => {
      slotIdEl.value = slot.id;
      selectedEl.textContent = `Selected: ${slot.provider} · ${formatWhen(slot.start)}`;
      bookBtn.disabled = false;
      renderSlots(slots);
    });
    slotsEl.appendChild(btn);
  }
}

function fillProviders(names, selected = "") {
  allProviderNames = names;
  providerEl.innerHTML = `<option value="">All providers</option>`;
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    providerEl.appendChild(opt);
  }
  providerEl.value = names.includes(selected) ? selected : "";
}

async function fetchAllSlots() {
  const { data } = await api("/web/slots");
  return data.slots;
}

async function loadSlots({ resetFilter = false } = {}) {
  setStatus("Loading slots…");
  if (resetFilter) providerEl.value = "";

  const provider = providerEl.value;
  const slots = provider
    ? (await api(`/web/slots?provider=${encodeURIComponent(provider)}`)).data.slots
    : await fetchAllSlots();

  // Provider list must always come from the full unfiltered set.
  if (!allProviderNames.length || resetFilter || !provider) {
    const allSlots = provider ? await fetchAllSlots() : slots;
    const names = [...new Set(allSlots.map((s) => s.provider))].sort();
    fillProviders(names, provider);
  }

  renderSlots(slots);
  setStatus(`${slots.length} slot(s) loaded.`, "ok");
}

function showConfirmation(booking, note = "") {
  currentBooking = booking;
  confirmation.hidden = false;
  confirmationBody.textContent = JSON.stringify(booking, null, 2);
  retryBtn.hidden = !lastBookRequest;
  setStatus(note || `Booked ${booking.id}`, "ok");
}

function renderBookings(bookings, nextCursor) {
  bookingsCursor = nextCursor;
  bookingsPager.hidden = false;
  nextPageBtn.disabled = !nextCursor;
  bookingsMeta.textContent = nextCursor
    ? `${bookings.length} on this page · more available`
    : `${bookings.length} on this page · end of list`;

  if (!bookings.length) {
    bookingsEl.innerHTML = `<p class="muted">No bookings for this email yet.</p>`;
    return;
  }

  bookingsEl.innerHTML = "";
  for (const booking of bookings) {
    const row = document.createElement("div");
    row.className = `slot booking-row ${booking.status}`;
    row.innerHTML = `
      <div>
        <strong>${booking.id}</strong>
        <span>slot ${booking.slot_id} · ${booking.status} · ${formatWhen(booking.created_at)}</span>
      </div>
    `;
    if (booking.status === "confirmed") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "secondary";
      btn.textContent = "Cancel";
      btn.addEventListener("click", async () => {
        try {
          await api(`/web/bookings/${encodeURIComponent(booking.id)}`, {
            method: "DELETE",
          });
          setStatus(`Cancelled ${booking.id}`, "ok");
          await loadSlots();
          await loadBookings(bookingsEmail, null);
        } catch (err) {
          setStatus(err.message, "err");
        }
      });
      row.appendChild(btn);
    } else {
      const tag = document.createElement("span");
      tag.textContent = "Cancelled";
      row.appendChild(tag);
    }
    bookingsEl.appendChild(row);
  }
}

async function loadBookings(email, cursor) {
  const trimmed = email.trim();
  if (!trimmed) throw new Error("email is required");
  bookingsEmail = trimmed;
  lookupEmailEl.value = trimmed;

  const params = new URLSearchParams({
    email: trimmed,
    limit: "2",
  });
  if (cursor) params.set("cursor", cursor);

  setStatus("Loading bookings…");
  const { data } = await api(`/web/bookings?${params}`);
  renderBookings(data.bookings, data.next_cursor);
  setStatus(
    data.next_cursor
      ? `Loaded ${data.bookings.length} booking(s); use Next page for more.`
      : `Loaded ${data.bookings.length} booking(s).`,
    "ok",
  );
}

async function createBooking({ slotId, name, email, idempotencyKey }) {
  const body = {
    slot_id: slotId,
    name,
    email,
  };
  const { data: booking, headers } = await api("/web/bookings", {
    method: "POST",
    headers: {
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });

  lastBookRequest = { body, idempotencyKey };
  const replayed = headers.get("Idempotent-Replayed") === "true";
  showConfirmation(
    booking,
    replayed
      ? `Replay returned the same booking ${booking.id} (no duplicate).`
      : `Booked ${booking.id}`,
  );

  lookupEmailEl.value = email;
  await loadSlots();
  await loadBookings(email, null);
  return booking;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!slotIdEl.value) return;

  bookBtn.disabled = true;
  setStatus("Booking…");

  try {
    await createBooking({
      slotId: slotIdEl.value,
      name: nameEl.value,
      email: emailEl.value,
      idempotencyKey: crypto.randomUUID(),
    });
    slotIdEl.value = "";
    selectedEl.textContent = "No slot selected yet.";
  } catch (err) {
    setStatus(err.message, "err");
  } finally {
    bookBtn.disabled = !slotIdEl.value;
  }
});

cancelBtn.addEventListener("click", async () => {
  if (!currentBooking) return;
  try {
    const { data: cancelled } = await api(
      `/web/bookings/${encodeURIComponent(currentBooking.id)}`,
      { method: "DELETE" },
    );
    currentBooking = cancelled;
    confirmationBody.textContent = JSON.stringify(cancelled, null, 2);
    setStatus(`Cancelled ${cancelled.id}`, "ok");
    await loadSlots();
    if (bookingsEmail) await loadBookings(bookingsEmail, null);
  } catch (err) {
    setStatus(err.message, "err");
  }
});

retryBtn.addEventListener("click", async () => {
  if (!lastBookRequest) return;
  try {
    setStatus("Retrying last booking request…");
    const { data: booking, headers } = await api("/web/bookings", {
      method: "POST",
      headers: {
        "Idempotency-Key": lastBookRequest.idempotencyKey,
      },
      body: JSON.stringify(lastBookRequest.body),
    });
    const replayed = headers.get("Idempotent-Replayed") === "true";
    showConfirmation(
      booking,
      replayed
        ? `Same key + body → same id ${booking.id} (level 4 idempotency).`
        : `Booked ${booking.id}`,
    );
    await loadSlots();
    await loadBookings(lastBookRequest.body.email, null);
  } catch (err) {
    setStatus(err.message, "err");
  }
});

lookupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await loadBookings(lookupEmailEl.value, null);
  } catch (err) {
    setStatus(err.message, "err");
  }
});

nextPageBtn.addEventListener("click", async () => {
  if (!bookingsCursor || !bookingsEmail) return;
  try {
    await loadBookings(bookingsEmail, bookingsCursor);
  } catch (err) {
    setStatus(err.message, "err");
  }
});

refreshBtn.addEventListener("click", () => {
  slotsEl.innerHTML = `<p class="muted">Refreshing…</p>`;
  loadSlots({ resetFilter: true }).catch((err) => setStatus(err.message, "err"));
});

providerEl.addEventListener("change", () => {
  loadSlots().catch((err) => setStatus(err.message, "err"));
});

emailEl.addEventListener("change", () => {
  if (!lookupEmailEl.value) lookupEmailEl.value = emailEl.value;
});

loadSlots({ resetFilter: true }).catch((err) => setStatus(err.message, "err"));
