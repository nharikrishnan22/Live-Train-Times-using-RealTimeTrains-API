// pip.js - Document Picture-in-Picture floating mini tracker
// Uses the Document Picture-in-Picture API (Chrome/Edge 116+).
// Falls back gracefully with a message when unsupported.

const pipBtn = document.getElementById("pip-btn");
const pipFallback = document.getElementById("pip-fallback");

let pipWindow = null;

function pipSupported() {
  return "documentPictureInPicture" in window;
}

function buildPipDocument(pipWin) {
  // Copy the page's stylesheet into the PiP window so it matches the theme
  const link = pipWin.document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("/static/style.css", window.location.href).href;
  pipWin.document.head.appendChild(link);

  pipWin.document.title = "Train Tracker — Mini";

  const body = pipWin.document.createElement("div");
  body.className = "pip-body";

  const rows = pipWin.document.createElement("div");
  rows.className = "board-rows";
  rows.id = "pip-rows";

  body.appendChild(rows);
  pipWin.document.body.appendChild(body);

  return rows;
}

function renderPip(container) {
  window.renderTrainsInto(window.TrainTracker.trains, container, true);
}

async function openPip() {
  if (!pipSupported()) {
    pipFallback.classList.remove("hidden");
    return;
  }

  try {
    pipWindow = await window.documentPictureInPicture.requestWindow({
      width: 320,
      height: 260,
    });

    const container = buildPipDocument(pipWindow);
    renderPip(container);

    // Keep the mini window in sync whenever the shared state updates or ticks
    window.__pipRender = () => {
      if (pipWindow && !pipWindow.closed) {
        renderPip(pipWindow.document.getElementById("pip-rows"));
      }
    };

    pipBtn.classList.add("active");
    pipBtn.textContent = "⧉ Mini Player (open)";

    pipWindow.addEventListener("pagehide", () => {
      pipWindow = null;
      window.__pipRender = null;
      pipBtn.classList.remove("active");
      pipBtn.textContent = "⧉ Mini Player";
    });
  } catch (err) {
    console.error("Failed to open Picture-in-Picture window:", err);
    pipFallback.textContent =
      "Couldn't open the mini player. Your browser may have blocked it — try clicking the button again.";
    pipFallback.classList.remove("hidden");
  }
}

function closePip() {
  if (pipWindow && !pipWindow.closed) {
    pipWindow.close();
  }
}

pipBtn.addEventListener("click", () => {
  if (pipWindow && !pipWindow.closed) {
    closePip();
  } else {
    openPip();
  }
});

if (!pipSupported()) {
  pipBtn.title = "Not supported in this browser — try Chrome or Edge 116+";
}
