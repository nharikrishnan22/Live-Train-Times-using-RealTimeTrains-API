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

// Expose the render function for pip.js to reuse
window.renderTrainsInto = renderTrains;
