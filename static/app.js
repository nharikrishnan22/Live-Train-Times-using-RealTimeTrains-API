// app.js - live board rendering + shared state used by pip.js

const boardRows = document.getElementById("board-rows");
const rowTemplate = document.getElementById("train-row-template");

const TRAIN_ICON_SVG = `
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="5" y="3" width="14" height="13" rx="4" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="8.5" cy="13" r="1.1" fill="currentColor"/>
    <circle cx="15.5" cy="13" r="1.1" fill="currentColor"/>
    <path d="M8 20l-2 2M16 20l2 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M5 8h14" stroke="currentColor" stroke-width="1.6"/>
  </svg>
`;

// Shared, global state so pip.js (loaded separately, and running inside the
// floating PiP window) can read the latest trains without a second socket.
window.TrainTracker = {
  trains: [],
  listeners: [],
  onUpdate(fn) {
    this.listeners.push(fn);
  },
  setTrains(trains) {
    this.trains = trains;
    this.listeners.forEach((fn) => fn(trains));
  },
};

function statusClass(status) {
  if (status === "Delayed") return "status-delayed";
  if (status === "Cancelled") return "status-cancelled";
  return "status-on-time";
}

// Renders the departure cards into any container element (main page or PiP window)
function renderTrains(trains, container, isPip = false) {
  container.innerHTML = "";

  if (!trains || trains.length === 0) {
    const empty = document.createElement("p");
    empty.className = isPip ? "pip-empty" : "loading";
    empty.textContent = "No upcoming departures.";
    container.appendChild(empty);
    return;
  }

  trains.forEach((t) => {
    let card;
    if (isPip) {
      card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-icon">${TRAIN_ICON_SVG}</div>
        <div class="card-main">
          <div class="card-time"></div>
          <div class="card-dest"></div>
          <div class="card-plat"></div>
        </div>
        <div class="card-status">
          <span class="status-pill"></span>
        </div>
      `;
    } else {
      card = rowTemplate.content.firstElementChild.cloneNode(true);
    }

    card.dataset.id = t.id;
    card.querySelector(".card-time").textContent = t.time;
    card.querySelector(".card-dest").textContent = t.destination;
    card.querySelector(".card-plat").textContent = t.platform;

    const pill = card.querySelector(".status-pill");
    pill.textContent = t.expected;
    pill.className = `status-pill ${statusClass(t.status)}`;

    container.appendChild(card);
  });
}

function renderBoard() {
  renderTrains(window.TrainTracker.trains, boardRows, false);
}

// --- Socket.IO live connection ---
const socket = io();

socket.on("connect", () => {
  console.log("Connected to live train feed");
});

socket.on("train_update", (data) => {
  window.TrainTracker.setTrains(data.trains);
});

window.TrainTracker.onUpdate(() => {
  renderBoard();
  if (window.__pipRender) window.__pipRender();
});

// --- Station autocomplete + live from/to route selection ---
let allStops = [];

async function loadStops() {
  try {
    const res = await fetch("/api/stops");
    const data = await res.json();
    allStops = data.stops || [];
  } catch (err) {
    console.error("Failed to load station list:", err);
  }
}

function setupAutocomplete(inputId, codeInputId, listId) {
  const input = document.getElementById(inputId);
  const codeInput = document.getElementById(codeInputId);
  const list = document.getElementById(listId);

  function renderSuggestions(query) {
    list.innerHTML = "";
    const q = query.trim().toLowerCase();
    if (!q) {
      list.classList.remove("open");
      return;
    }

    const matches = allStops
      .filter((s) => s.description.toLowerCase().includes(q) || s.shortCode.toLowerCase().includes(q))
      .slice(0, 8);

    if (matches.length === 0) {
      list.classList.remove("open");
      return;
    }

    matches.forEach((s) => {
      const li = document.createElement("li");
      li.textContent = `${s.description} (${s.shortCode})`;
      // mousedown fires before the input's blur, so the click registers
      // before we hide the suggestion list on blur
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = s.description;
        codeInput.value = s.shortCode;
        list.classList.remove("open");
      });
      list.appendChild(li);
    });

    list.classList.add("open");
  }

  input.addEventListener("input", () => {
    codeInput.value = "";
    renderSuggestions(input.value);
  });

  input.addEventListener("focus", () => {
    if (input.value) renderSuggestions(input.value);
  });

  input.addEventListener("blur", () => {
    setTimeout(() => list.classList.remove("open"), 100);
  });

  return { input, codeInput };
}

const fromField = setupAutocomplete("from-input", "from-code", "from-suggestions");
const toField = setupAutocomplete("to-input", "to-code", "to-suggestions");

document.getElementById("swap-btn").addEventListener("click", () => {
  const fromVal = fromField.input.value;
  const fromCode = fromField.codeInput.value;
  fromField.input.value = toField.input.value;
  fromField.codeInput.value = toField.codeInput.value;
  toField.input.value = fromVal;
  toField.codeInput.value = fromCode;
});

const routeForm = document.getElementById("route-form");
const routeError = document.getElementById("route-error");
const routeSubtitle = document.getElementById("route-subtitle");

routeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  routeError.classList.add("hidden");

  const fromCode = fromField.codeInput.value;
  const toCode = toField.codeInput.value;

  if (!fromCode || !toCode) {
    routeError.textContent = "Pick a station from the suggestions for both From and To.";
    routeError.classList.remove("hidden");
    return;
  }
  if (fromCode === toCode) {
    routeError.textContent = "From and To can't be the same station.";
    routeError.classList.remove("hidden");
    return;
  }

  socket.emit("set_route", {
    from: fromCode,
    to: toCode,
    fromDescription: fromField.input.value,
    toDescription: toField.input.value,
  });
});

socket.on("route_updated", (route) => {
  const fromDesc = route.from_description || route.from;
  const toDesc = route.to_description || route.to;
  routeSubtitle.textContent = `${fromDesc} → ${toDesc}`;

  // Keep the form reflecting whatever route is actually live, including on
  // first connect and when another client changes it.
  if (route.from_description) fromField.input.value = route.from_description;
  if (route.from) fromField.codeInput.value = route.from;
  if (route.to_description) toField.input.value = route.to_description;
  if (route.to) toField.codeInput.value = route.to;
});

socket.on("route_error", (err) => {
  routeError.textContent = (err && err.message) || "Couldn't update the route.";
  routeError.classList.remove("hidden");
});

loadStops();

// Expose the render function for pip.js to reuse
window.renderTrainsInto = renderTrains;
