const slotsEl = document.getElementById("slots");
const providerEl = document.getElementById("provider");
const refreshBtn = document.getElementById("refresh");
const form = document.getElementById("book-form");
const slotIdEl = document.getElementById("slot_id");
const selectedEl = document.getElementById("selected");
const bookBtn = document.getElementById("book-btn");
const statusEl = document.getElementById("status");
const confirmation = document.getElementById("confirmation");
const confirmationBody = document.getElementById("confirmation-body");
const cancelBtn = document.getElementById("cancel-btn");

let currentBooking = null;

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
  const res = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
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

function fillProviders(slots) {
  const current = providerEl.value;
  const names = [...new Set(slots.map((s) => s.provider))].sort();
  providerEl.innerHTML = `<option value="">All providers</option>`;
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    providerEl.appendChild(opt);
  }
  providerEl.value = names.includes(current) ? current : "";
}

async function loadSlots() {
  setStatus("Loading slots…");
  const qs = providerEl.value
    ? `?provider=${encodeURIComponent(providerEl.value)}`
    : "";
  const data = await api(`/web/slots${qs}`);
  if (!providerEl.dataset.ready) {
    fillProviders(data.slots);
    providerEl.dataset.ready = "1";
  }
  renderSlots(data.slots);
  setStatus(`${data.slots.length} slot(s) loaded.`, "ok");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!slotIdEl.value) return;

  bookBtn.disabled = true;
  setStatus("Booking…");

  try {
    const booking = await api("/web/bookings", {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        slot_id: slotIdEl.value,
        name: document.getElementById("name").value,
        email: document.getElementById("email").value,
      }),
    });

    currentBooking = booking;
    confirmation.hidden = false;
    confirmationBody.textContent = JSON.stringify(booking, null, 2);
    setStatus(`Booked ${booking.id}`, "ok");
    slotIdEl.value = "";
    selectedEl.textContent = "No slot selected yet.";
    await loadSlots();
  } catch (err) {
    setStatus(err.message, "err");
  } finally {
    bookBtn.disabled = !slotIdEl.value;
  }
});

cancelBtn.addEventListener("click", async () => {
  if (!currentBooking) return;
  try {
    const cancelled = await api(`/web/bookings/${encodeURIComponent(currentBooking.id)}`, {
      method: "DELETE",
    });
    currentBooking = cancelled;
    confirmationBody.textContent = JSON.stringify(cancelled, null, 2);
    setStatus(`Cancelled ${cancelled.id}`, "ok");
    await loadSlots();
  } catch (err) {
    setStatus(err.message, "err");
  }
});

refreshBtn.addEventListener("click", () => {
  providerEl.dataset.ready = "";
  loadSlots().catch((err) => setStatus(err.message, "err"));
});

providerEl.addEventListener("change", () => {
  loadSlots().catch((err) => setStatus(err.message, "err"));
});

loadSlots().catch((err) => setStatus(err.message, "err"));
