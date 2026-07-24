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

const BUS_ICON_SVG = `
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path fill="currentColor" fill-rule="nonzero" d="M18.86 3.505a.75.75 0 0 1 .64.742V6H21a.75.75 0 0 1 .75.75v1.5a.75.75 0 1 1-1.5 0V7.5h-.75v9.25c0 .74-.285 1.413-.75 1.909v1.592a.75.75 0 1 1-1.5 0l.001-.785c-.14.023-.283.035-.43.035H7.179c-.146 0-.289-.012-.428-.035v.785a.75.75 0 1 1-1.5 0v-1.591a2.783 2.783 0 0 1-.75-1.91V7.5h-.75v.75a.75.75 0 1 1-1.5 0v-1.5A.75.75 0 0 1 3 6h1.5V4.247a.75.75 0 0 1 .64-.742c4.55-.673 9.17-.673 13.72 0zm-.861 9.994h-12L6 16.749C6 17.447 6.534 18 7.178 18h9.644c.644 0 1.178-.554 1.178-1.25l-.001-3.251zM8.25 14.906a.844.844 0 1 1 0 1.688.844.844 0 0 1 0-1.688zm7.5 0a.844.844 0 1 1 0 1.688.844.844 0 0 1 0-1.688zM6 4.9V6.75l-.001.014v5.235h12l.001-7.1a45.31 45.31 0 0 0-12 0zm8.25 1.1a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 1 1 0-1.5h4.5z"/>
  </svg>
`;

function iconSvgFor(train) {
  return (train && train.mode === "BUS") ? BUS_ICON_SVG : TRAIN_ICON_SVG;
}

// Renders an operator logo into the given container, falling back to a
// text badge (e.g. "SW") if no logo file exists at /static/operators/<code>.svg
// for that operator. Built via DOM APIs rather than innerHTML strings since
// operatorName comes from the live feed and shouldn't be trusted as markup.
function renderOperatorBadge(container, train) {
  container.innerHTML = "";
  if (!train || !train.operatorCode) return;

  const code = train.operatorCode;
  const label = train.operatorName || code;

  const img = document.createElement("img");
  img.className = "operator-logo";
  img.src = `/static/operators/${encodeURIComponent(code)}.svg`;
  img.alt = label;
  img.title = label;
  img.onerror = () => {
    const badge = document.createElement("span");
    badge.className = "operator-badge";
    badge.textContent = code;
    badge.title = label;
    container.replaceChildren(badge);
  };
  container.appendChild(img);
}

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

// A train's server-provided "id" tracks its row/position in the feed, not
// the physical service - as earlier trains depart and drop off the board,
// later trains shift up and can end up wearing a different id. Notifications
// need to stick to the actual train, so we key off its scheduled time and
// destination instead, which stay the same for that service regardless of
// where it currently sits on the board.
function trainKey(t) {
  return `${t.time}__${t.destination}`;
}

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
        <div class="card-icon">${iconSvgFor(t)}</div>
        <div class="card-main">
          <div class="card-time"></div>
          <div class="card-dest"></div>
          <div class="card-plat"></div>
        </div>
        <div class="card-status">
          <span class="card-operator"></span>
          <span class="status-pill"></span>
        </div>
      `;
    } else {
      card = rowTemplate.content.firstElementChild.cloneNode(true);
      card.querySelector(".card-icon").innerHTML = iconSvgFor(t);
    }

    card.dataset.id = trainKey(t);
    card.querySelector(".card-time").textContent = t.time;
    card.querySelector(".card-dest").textContent = t.destination;
    card.querySelector(".card-plat").textContent = t.platform;
    renderOperatorBadge(card.querySelector(".card-operator"), t);

    const pill = card.querySelector(".status-pill");
    pill.textContent = t.expected;
    pill.className = `status-pill ${statusClass(t.status)}`;

    const notifyBtn = card.querySelector(".notify-toggle");
    if (notifyBtn) {
      const isWatched = NotifySettings.watchedIds.has(trainKey(t));
      notifyBtn.classList.toggle("active", isWatched);
      notifyBtn.setAttribute("aria-pressed", isWatched ? "true" : "false");
      notifyBtn.title = isWatched
        ? "Notifications on for this train — tap to turn off"
        : "Notify me if this train is delayed or cancelled";
    }

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

window.TrainTracker.onUpdate((trainList) => {
  checkWatchedTrains(trainList);
  renderBoard();
  if (window.__pipRender) window.__pipRender();
});

// --- Delay / cancellation desktop notifications ---
// Notifications are opt-in per train (tap the bell on a row). We never read
// a delay-in-minutes field from the server - the "expected" text only ever
// carries a clock time (e.g. "Exp 20:32"), so the delay shown to the user is
// worked out here by comparing it against the scheduled "time".
const NotifySettings = {
  watchedIds: new Set(),
};

// Remembers the last status/expected text we notified about per train id,
// so a train sitting at "Delayed" doesn't re-notify every 30s tick - only
// when something about it actually changes (goes cancelled, delay grows, etc).
const notifyMemory = new Map();

function loadNotifyPrefs() {
  try {
    const raw = localStorage.getItem("train-tracker-notify-prefs");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.watchedIds)) {
      NotifySettings.watchedIds = new Set(parsed.watchedIds.map(String));
    }
  } catch (err) {
    console.warn("Couldn't load notification preferences:", err);
  }
}

function saveNotifyPrefs() {
  try {
    localStorage.setItem(
      "train-tracker-notify-prefs",
      JSON.stringify({
        watchedIds: Array.from(NotifySettings.watchedIds)
      })
    );
  } catch (err) {
    console.warn("Couldn't save notification preferences:", err);
  }
}

loadNotifyPrefs();

// Notification watches are meant to last for the current session only -
// clear them out once the app is closed so the next visit starts fresh.
function clearNotifyPrefsOnExit() {
  try {
    localStorage.removeItem("train-tracker-notify-prefs");
  } catch (err) {
    console.warn("Couldn't clear notification preferences:", err);
  }
}

window.addEventListener("pagehide", clearNotifyPrefsOnExit);

function notificationsSupported() {
  return "Notification" in window;
}

function notifyPermissionLabel() {
  if (!notificationsSupported()) return "Not supported";
  if (Notification.permission === "granted") return "Enabled";
  if (Notification.permission === "denied") return "Blocked";
  return "Enable";
}

function refreshPermissionUI() {
  const btn = document.getElementById("notify-permission-btn");
  if (!btn) return;
  const supported = notificationsSupported();
  btn.textContent = notifyPermissionLabel();
  btn.disabled = !supported || Notification.permission !== "default";
  btn.classList.toggle("granted", supported && Notification.permission === "granted");
  btn.classList.toggle("blocked", supported && Notification.permission === "denied");
}

async function ensurePermission() {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission === "default") {
    const result = await Notification.requestPermission();
    refreshPermissionUI();
    return result;
  }
  return Notification.permission;
}

// Parses a "HH:MM" clock time into minutes since midnight.
function timeToMinutes(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec((text || "").trim());
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

// Pulls a clock time out of an "expected" string like "Exp 20:32".
function extractClockTime(text) {
  const match = /(\d{1,2}:\d{2})/.exec(text || "");
  return match ? match[1] : null;
}

// Infers how many minutes late a train is by diffing its scheduled "time"
// against the clock time embedded in "expected" - no delay field needed.
function inferDelayMinutes(train) {
  const scheduled = timeToMinutes(train.time);
  const expected = timeToMinutes(extractClockTime(train.expected));
  if (scheduled == null || expected == null) return null;
  let diff = expected - scheduled;
  if (diff < 0) diff += 24 * 60; // crossed midnight
  return diff;
}

function sendDesktopNotification(train, prevDelay = 0) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;

  let title;
  let body;

  if (train.status === "Cancelled") {
    title = `Cancelled — ${train.time} to ${train.destination}`;
    body = "This train has been cancelled.";
  } else if (train.status === "Delayed") {
    const minutes = inferDelayMinutes(train);
    title = `Delayed — ${train.time} to ${train.destination}`;

    if (minutes != null) {
    if (prevDelay > minutes && minutes > 0) {
      // Train made up time! (still running late)
      title = `Earlier Expected — ${train.time} to ${train.destination}`;
      body = `Delay reduced to ${minutes} min${minutes === 1 ? "" : "s"} (was ${prevDelay} mins)`;
    } else if (prevDelay > 0 && minutes > prevDelay) {
      // Delay increased
      title = `Delayed — ${train.time} to ${train.destination}`;
      body = `Delay increased to ${minutes} min${minutes === 1 ? "" : "s"} (was ${prevDelay} mins)`;
    } else {
      // Initial delay notification (or 0 min fallback)
      title = `Delayed — ${train.time} to ${train.destination}`;
      body = `Delayed by ${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
  } else {
    body = train.expected || "This train is running late.";
  }

    if (train.platform && train.platform !== "—") {
      body += ` · Platform ${train.platform}`;
    }
  } else {
    title = `Back on time — ${train.time} to ${train.destination}`;
    body = "This train is now running on time.";
    if (train.platform && train.platform !== "—") {
      body += ` · Platform ${train.platform}`;
    }
  }

  try {
    new Notification(title, { body, tag: `train-${trainKey(train)}` });
  } catch (err) {
    console.error("Failed to show desktop notification:", err);
  }
}

function checkWatchedTrains(trainList) {
  (trainList || []).forEach((t) => {
    const idKey = trainKey(t);
    const isBad = t.status === "Delayed" || t.status === "Cancelled";
    const prev = notifyMemory.get(idKey);
    const wasBad = prev && (prev.status === "Delayed" || prev.status === "Cancelled");

    // Calculate current and previous delay in minutes
    const currentDelay = inferDelayMinutes(t) || 0;
    const prevDelay = prev ? (prev.delayMinutes || 0) : 0;
    const delayDiff = Math.abs(currentDelay - prevDelay);

    // Determine if the time shift warrants a notification
    let significantTimeChange = false;
    if (currentDelay < 3) {
      // Under 3 minutes: notify on any shift in time
      significantTimeChange = currentDelay !== prevDelay;
    } else {
      // 3+ minutes: notify only if the delay changes by 3+ minutes
      significantTimeChange = delayDiff >= 3;
    }

    const statusChanged = !prev || prev.status !== t.status;
    const shouldNotify =
      NotifySettings.watchedIds.has(idKey) &&
      (statusChanged || significantTimeChange) &&
      (isBad || (!isBad && wasBad)); // Notify on bad state or recovery

    if (shouldNotify) {
      sendDesktopNotification(t, prevDelay);
      // Update memory only when we actually notify
      notifyMemory.set(idKey, {
        status: t.status,
        expected: t.expected,
        delayMinutes: currentDelay,
      });
    } else if (!prev) {
      // Seed initial state if not present
      notifyMemory.set(idKey, {
        status: t.status,
        expected: t.expected,
        delayMinutes: currentDelay,
      });
    }
  });
}

async function toggleWatch(id) {
  const idKey = String(id);

  if (NotifySettings.watchedIds.has(idKey)) {
    NotifySettings.watchedIds.delete(idKey);
  } else {
    NotifySettings.watchedIds.add(idKey);
    // Seed memory with the train's current status/expected instead of
    // clearing it, so the next update only notifies on an actual change
    // (more delayed, less delayed, cancelled, back on time) rather than
    // firing immediately just because we pressed the bell.
    const current = window.TrainTracker.trains.find((t) => trainKey(t) === idKey);
    if (current) {
      notifyMemory.set(idKey, { 
        status: current.status, 
        expected: current.expected,
        delayMinutes: inferDelayMinutes(current) || 0
      });
    } else {
      notifyMemory.delete(idKey);
    }
    await ensurePermission();
  }

  saveNotifyPrefs();
  renderBoard();
}

// --- Notification settings panel wiring ---
const notifySettingsBtn = document.getElementById("notify-settings-btn");
const notifyPanel = document.getElementById("notify-panel");
const notifyPermissionBtn = document.getElementById("notify-permission-btn");

if (notifyPermissionBtn) {
  notifyPermissionBtn.addEventListener("click", () => {
    ensurePermission();
  });
}

if (notifySettingsBtn && notifyPanel) {
  notifySettingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = notifyPanel.classList.contains("hidden");
    notifyPanel.classList.toggle("hidden", !willOpen);
    notifySettingsBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
  });

  document.addEventListener("click", (e) => {
    if (!notifyPanel.classList.contains("hidden") && !notifyPanel.contains(e.target) && e.target !== notifySettingsBtn) {
      notifyPanel.classList.add("hidden");
      notifySettingsBtn.setAttribute("aria-expanded", "false");
    }
  });
}

// Per-row bell taps, delegated so it keeps working as rows re-render
boardRows.addEventListener("click", (e) => {
  const btn = e.target.closest(".notify-toggle");
  if (!btn) return;
  const card = btn.closest(".card");
  if (!card) return;
  toggleWatch(card.dataset.id);
});

refreshPermissionUI();

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
  // first connect and when another client changes it - but don't stomp on
  // a field the user is actively typing a new search into, or a route
  // update mid-search (e.g. from a periodic refresh) wipes out what they
  // were about to select.
  if (document.activeElement !== fromField.input) {
    if (route.from_description) fromField.input.value = route.from_description;
    if (route.from) fromField.codeInput.value = route.from;
  }
  if (document.activeElement !== toField.input) {
    if (route.to_description) toField.input.value = route.to_description;
    if (route.to) toField.codeInput.value = route.to;
  }
});

socket.on("route_error", (err) => {
  routeError.textContent = (err && err.message) || "Couldn't update the route.";
  routeError.classList.remove("hidden");
});

loadStops();

// Expose the render function for pip.js to reuse
window.renderTrainsInto = renderTrains;
