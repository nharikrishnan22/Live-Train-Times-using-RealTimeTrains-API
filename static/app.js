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
  lastError: null,
  // The currently-confirmed route, keyed by station description since that's
  // what calling points are labelled with. Used to trim the calling-points
  // panel down to the user's actual journey (see renderCallingPointsList).
  currentRoute: { fromDescription: null, toDescription: null },
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
function renderTrains(trains, container, isPip = false, errorMessage = null) {
  container.innerHTML = "";

  if (!trains || trains.length === 0) {
    const empty = document.createElement("p");
    empty.className = isPip ? "pip-empty" : "loading";
    empty.textContent = errorMessage || "No upcoming departures.";
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
    if (!isPip) {
      card.dataset.uniqueIdentity = t.uniqueIdentity || "";
    }
    card.querySelector(".card-time").textContent = t.time;
    card.querySelector(".card-dest").textContent = t.destination;
    card.querySelector(".card-plat").textContent = t.platformEstimated
      ? `Est. ${t.platform}`
      : t.platform;
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

    // The board re-renders from scratch every update (new socket push, or
    // a manual route change), which would otherwise silently collapse any
    // calling-points panel the user had open. Re-fetch (cache-first) so it
    // stays open and reflects the freshest calling points.
    if (!isPip && expandedCallingPoints.has(trainKey(t))) {
      openCallingPoints(card, trainKey(t));
    }
  });
}

function renderBoard() {
  renderTrains(window.TrainTracker.trains, boardRows, false, window.TrainTracker.lastError);
}

function updateFeedErrorBanner(message) {
  const el = document.getElementById("feed-error");
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

// --- Calling points (per-train stop-by-stop detail) ---
const callingPointTemplate = document.getElementById("calling-point-template");
const callingPointGroupTemplate = document.getElementById("calling-point-group-template");

// Cache fetched calling points per service so re-opening a card (or a 30s
// board refresh while it's expanded) doesn't re-hit the API every time.
const callingPointsCache = new Map();
// Which trains (by trainKey) currently have their calling points panel
// open, so that state survives the board re-rendering on every update.
const expandedCallingPoints = new Set();

function callingPointsCacheKey(uniqueIdentity) {
  return uniqueIdentity;
}

// Appends a collapsed "+N stops" toggle row. `forceCollapse` is used for the
// leading/trailing trim groups (stops before the user's boarding station or
// after their alighting station) so they stay hidden even when there's only
// a single stop in them - unlike the internal "already departed" groups,
// which show a lone stop plainly rather than making the user tap to reveal
// just one row. Returns the DOM node that was appended (used to measure the
// progress line - see applyProgressLineColor).
//
// Expanding a group inserts its stops as direct siblings right after the
// toggle, in the *same* top-level list, rather than in a nested sub-list -
// so they land on the same connecting line as every other stop instead of
// floating off to the right in their own indented rail.
function appendCollapsedGroup(listEl, groupPoints, { forceCollapse = false, suffix = "", onToggle } = {}) {
  if (!groupPoints.length) return null;

  if (!forceCollapse && groupPoints.length === 1) {
    const li = buildCallingPointLi(groupPoints[0]);
    listEl.appendChild(li);
    return li;
  }

  const groupLi = callingPointGroupTemplate.content.firstElementChild.cloneNode(true);

  // Determine if the group contains any delayed or cancelled stops to color the dot
  const hasCancelled = groupPoints.some((p) => p.status === "cancelled");
  const hasDelayed = groupPoints.some((p) => p.status === "delayed" || callingPointOnTimeColor(p) === "var(--red)");

  if (hasCancelled) {
    groupLi.classList.add("cancelled");
  } else if (hasDelayed) {
    groupLi.classList.add("delayed");
  } else {
    groupLi.classList.add("on-time");
  }

  const toggle = groupLi.querySelector(".calling-point-group-toggle");
  const count = groupPoints.length;
  const stopWord = count === 1 ? "stop" : "stops";
  const closedText = `⋯ ${count} ${stopWord}${suffix}`;
  toggle.textContent = closedText;
  groupLi._points = groupPoints; 
  listEl.appendChild(groupLi);

  let expandedRows = [];
  toggle.addEventListener("click", () => {
    const willOpen = expandedRows.length === 0;
    if (willOpen) {
      let anchor = groupLi;
      groupPoints.forEach((gp) => {
        const li = buildCallingPointLi(gp);
        anchor.after(li);
        anchor = li;
        expandedRows.push(li);
      });
      groupLi.classList.add("is-open");
      toggle.textContent = `▲ Hide ${count} ${stopWord}${suffix}`;
    } else {
      expandedRows.forEach((li) => li.remove());
      expandedRows = [];
      groupLi.classList.remove("is-open");
      toggle.textContent = closedText;
    }
    // Recalculate progress line dynamically when expanding/collapsing
    if (onToggle) onToggle();
  });

  return groupLi;
}

// Splits the flat calling-point list into the row-by-row segments that get
// rendered: a leading group for anything before the user's boarding station,
// a trailing group for anything after their alighting station, and - within
// that visible window - the classic "already departed intermediate stops
// collapse behind +N stops" grouping.
function buildCallingPointSegments(points, startIdx, endIdx) {
  const lastIndex = points.length - 1;
  const segments = [];

  if (startIdx > 0) {
    segments.push({ kind: "edge", points: points.slice(0, startIdx) });
  }

  let i = startIdx;
  while (i <= endIdx) {
    const point = points[i];
    const isEdge = i === startIdx || i === endIdx;
    const collapsible = !isEdge && !point.isCurrent && (
      point.status === "departed" || 
      point.status === "passed" || 
      point.status === "arrived" ||
      (point.expected && point.expected.toLowerCase().includes("departed"))
    );

    if (!collapsible) {
      segments.push({ kind: "single", points: [point] });
      i += 1;
      continue;
    }

    const groupStart = i;
    while (
      i <= endIdx &&
      i !== endIdx &&
      !points[i].isCurrent &&
      points[i].status === "departed"
    ) {
      i += 1;
    }
    segments.push({ kind: "internal", points: points.slice(groupStart, i) });
  }

  if (endIdx < lastIndex) {
    segments.push({ kind: "edge", points: points.slice(endIdx + 1) });
  }

  return segments;
}

// Works out whether the train was/is on time as of the user's boarding
// station, using the same schedule-vs-expected clock time comparison used
// for the top-level delay notifications.
function callingPointOnTimeColor(point) {
  if (!point) return "var(--border)";
  if (point.status === "cancelled") return "var(--red)";
  const scheduled = timeToMinutes(point.time);
  const expected = timeToMinutes(extractClockTime(point.expected));
  if (scheduled == null || expected == null) return "var(--mint)";
  let diff = expected - scheduled;
  if (diff < 0) diff += 24 * 60;
  return diff > 0 ? "var(--red)" : "var(--mint)";
}

function buildCallingPointLi(point) {
  const li = callingPointTemplate.content.firstElementChild.cloneNode(true);
  const classes = ["calling-point", point.status];
  if (point.isOrigin) classes.push("origin");
  if (point.isDestination) classes.push("destination");
  if (point.isCurrent) classes.push("current");
  li.className = classes.join(" ");
  li.querySelector(".calling-point-time").textContent = point.time;
  li.querySelector(".calling-point-station").textContent = point.station;
  li.querySelector(".calling-point-due").textContent = point.expected;
  li._points = [point]; // Store point data directly on the DOM node
  return li;
}

function getPointMinutes(point) {
  if (!point) return null;
  const str = extractClockTime(point.expected) || extractClockTime(point.time) || point.time;
  return timeToMinutes(str);
}

function applyProgressLineColor(listEl, points, startIdx) {
  const originPoint = points[startIdx];
  const color = callingPointOnTimeColor(originPoint);

  if (!listEl || listEl.children.length === 0) return;

  // 1. Force the list to allow absolute positioning and strip original styling
  listEl.style.setProperty("position", "relative", "important");
  listEl.style.setProperty("background", "transparent", "important");
  
  const TRACK_AXIS = 20; // Places the exact center of our track 20px from the left edge

  // 2. Inject Bulletproof Override CSS
  const styleId = "tracker-custom-styles-v6";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      /* Force massive padding so text NEVER overlaps our custom line */
      .calling-point, .calling-point-group {
         padding-left: 50px !important; 
         position: relative !important;
         z-index: 5 !important;
         background: transparent !important;
      }
      /* Hide native app dots/lines aggressively */
      .calling-point::before, .calling-point::after, .calling-point-icon,
      .calling-point-group::before, .calling-point-group::after {
         display: none !important; 
      }
      
      /* Pure DOM Track Elements */
      .custom-track-bg {
         position: absolute !important; left: ${TRACK_AXIS}px !important;
         width: 2px !important; background-color: #9e9e9e !important;
         transform: translateX(-50%) !important; z-index: 1 !important;
      }
      .custom-track-fill {
         position: absolute !important; left: ${TRACK_AXIS}px !important;
         width: 6px !important; border-radius: 3px !important;
         background-color: var(--progress-color, #00a000) !important;
         transform: translateX(-50%) !important; z-index: 2 !important;
         transition: height 0.3s ease !important;
      }
      .train-progress-dot {
         position: absolute !important; left: ${TRACK_AXIS}px !important;
         width: 14px !important; height: 14px !important;
         background-color: #fff !important; border: 3px solid #222 !important;
         border-radius: 50% !important; transform: translate(-50%, -50%) !important;
         z-index: 4 !important; box-sizing: border-box !important;
         transition: top 0.3s ease !important;
      }
      .custom-future-dot {
         position: absolute !important; left: ${TRACK_AXIS}px !important;
         width: 8px !important; height: 8px !important;
         background-color: #9e9e9e !important; border-radius: 50% !important;
         transform: translate(-50%, -50%) !important; z-index: 3 !important;
      }
    `;
    document.head.appendChild(style);
  }

  // 3. Wait for layout to finish to calculate precise Y coordinates
  requestAnimationFrame(() => {
      const getMinutes = (pt) => {
         if (!pt) return null;
         const timeStr = pt.expected || pt.actual || pt.time || "";
         const match = timeStr.match(/(\d{2}):(\d{2})/);
         if (match && !timeStr.toLowerCase().includes("delayed") && !timeStr.toLowerCase().includes("cancelled") && !timeStr.toLowerCase().includes("on time")) {
             return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
         }
         // Fallback explicitly to pt.time if "On time" is triggered
         const fb = (pt.time || "").match(/(\d{2}):(\d{2})/);
         return fb ? parseInt(fb[1], 10) * 60 + parseInt(fb[2], 10) : null;
      };

      const now = new Date();
      let currentMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

      let timePoints = points.map(pt => ({ pt, mins: getMinutes(pt) }));
      
      for (let i = 1; i < timePoints.length; i++) {
         if (timePoints[i].mins !== null && timePoints[i-1].mins !== null) {
            if (timePoints[i].mins < timePoints[i-1].mins - 60) {
               for (let j = i; j < timePoints.length; j++) {
                  if (timePoints[j].mins !== null) timePoints[j].mins += 24 * 60;
               }
            }
         }
      }

      if (timePoints.length > 0 && timePoints[0].mins !== null) {
         if (currentMinutes < timePoints[0].mins && (timePoints[0].mins - currentMinutes > 12 * 60)) {
            currentMinutes += 24 * 60;
         }
      }

      // Filter out our injected DOM elements so we only process actual station rows
      const items = Array.from(listEl.children).filter(c => 
         !c.classList.contains("custom-track-bg") && 
         !c.classList.contains("custom-track-fill") && 
         !c.classList.contains("train-progress-dot") && 
         !c.classList.contains("custom-future-dot")
      );
      
      let anchorIdx = -1;
      for (let i = 0; i < timePoints.length; i++) {
         if (timePoints[i].mins !== null && timePoints[i].mins <= currentMinutes) {
            anchorIdx = i;
         }
      }

      // Dynamically find the exact center of the text row based on its physical height
      const getVisualY = (pt) => {
         let node = items.find(c => c._points && c._points.length === 1 && c._points[0] === pt);
         if (!node) node = items.find(c => c._points && c._points.includes(pt));
         return (node && typeof node.offsetTop === 'number') ? node.offsetTop + (node.offsetHeight / 2) : null;
      };

      let dotY = 0;
      if (anchorIdx === -1) {
         const firstY = getVisualY(points[0]);
         if (firstY !== null) dotY = Math.max(0, firstY - 20);
      } else if (anchorIdx === timePoints.length - 1) {
         const lastY = getVisualY(points[anchorIdx]);
         if (lastY !== null) dotY = lastY;
      } else {
         const anchorPt = timePoints[anchorIdx];
         const nextPt = timePoints[anchorIdx + 1];
         const anchorY = getVisualY(anchorPt.pt);
         const nextY = getVisualY(nextPt.pt);

         if (anchorY !== null && nextY !== null) {
            const timeDiff = nextPt.mins - anchorPt.mins;
            if (anchorY === nextY || timeDiff <= 0) {
               dotY = anchorY;
            } else {
               const ratio = (currentMinutes - anchorPt.mins) / timeDiff;
               const clampedRatio = Math.max(0, Math.min(1, ratio));
               dotY = anchorY + clampedRatio * (nextY - anchorY);
            }
         } else if (anchorY !== null) {
            dotY = anchorY;
         }
      }

      const safeDotY = isNaN(dotY) ? 0 : dotY;
      listEl.style.setProperty("--progress-color", color);

      // --- NEW BULLETPROOF DOM RENDERING ---
      const firstChildY = items.length > 0 ? items[0].offsetTop + (items[0].offsetHeight / 2) : 0;
      const lastChildY = items.length > 0 ? items[items.length - 1].offsetTop + (items[items.length - 1].offsetHeight / 2) : 0;

      // 1. Build Thin Grey Track
      let trackBg = listEl.querySelector(".custom-track-bg");
      if (!trackBg) { trackBg = document.createElement("div"); trackBg.className = "custom-track-bg"; listEl.appendChild(trackBg); }
      trackBg.style.top = `${firstChildY}px`;
      trackBg.style.height = `${Math.max(0, lastChildY - firstChildY)}px`;

      // 2. Build Thick Colored Fill Track
      let trackFill = listEl.querySelector(".custom-track-fill");
      if (!trackFill) { trackFill = document.createElement("div"); trackFill.className = "custom-track-fill"; listEl.appendChild(trackFill); }
      trackFill.style.top = `${firstChildY}px`;
      trackFill.style.height = `${Math.max(0, safeDotY - firstChildY)}px`;

      // 3. Build Live Train Ring
      let trainDot = listEl.querySelector(".train-progress-dot");
      if (!trainDot) { trainDot = document.createElement("div"); trainDot.className = "train-progress-dot"; listEl.appendChild(trainDot); }
      trainDot.style.top = `${safeDotY}px`;

      // 4. Update Future Dots & Apply Faded Text
      // Clean up old injected future dots to prevent clutter when toggling collapsed views
      listEl.querySelectorAll(".custom-future-dot").forEach(el => el.remove());

      items.forEach(child => {
        if (child.classList.contains("calling-points-empty")) return;
        
        const childY = child.offsetTop + (child.offsetHeight / 2);
        if (childY <= safeDotY) {
          child.style.opacity = "0.5"; // Fade passed text
        } else {
          child.style.opacity = "1"; // Highlight future text
          
          // Inject a physical small grey dot precisely onto the track
          let fDot = document.createElement("div");
          fDot.className = "custom-future-dot";
          fDot.style.top = `${childY}px`;
          listEl.appendChild(fDot);
        }
      });
  });
}

function renderCallingPointsList(listEl, points) {
  listEl.innerHTML = "";
  if (!points || points.length === 0) {
    const empty = document.createElement("li");
    empty.className = "calling-points-empty";
    empty.textContent = "No calling point detail available for this service.";
    listEl.appendChild(empty);
    return;
  }

  const lastIndex = points.length - 1;
  const route = window.TrainTracker.currentRoute || {};
  const norm = (s) => (s || "").trim().toLowerCase();

  let startIdx = route.fromDescription
    ? points.findIndex((p) => norm(p.station) === norm(route.fromDescription))
    : -1;
  let endIdx = route.toDescription
    ? points.findIndex((p) => norm(p.station) === norm(route.toDescription))
    : -1;
  if (startIdx === -1) startIdx = 0;
  if (endIdx === -1) endIdx = lastIndex;
  if (startIdx > endIdx) {
    startIdx = 0;
    endIdx = lastIndex;
  }

  const segments = buildCallingPointSegments(points, startIdx, endIdx);
  const refreshProgressLine = () => applyProgressLineColor(listEl, points, startIdx);

  segments.forEach((seg) => {
    if (seg.kind === "single") {
      const node = buildCallingPointLi(seg.points[0]);
      listEl.appendChild(node);
    } else {
      appendCollapsedGroup(listEl, seg.points, {
        forceCollapse: seg.kind === "edge",
        onToggle: refreshProgressLine,
      });
    }
  });

  refreshProgressLine();
}

async function loadCallingPoints(uniqueIdentity) {
  const cacheKey = callingPointsCacheKey(uniqueIdentity);
  if (callingPointsCache.has(cacheKey)) {
    return callingPointsCache.get(cacheKey);
  }
  const res = await fetch(`/api/calling-points/${encodeURIComponent(uniqueIdentity)}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data && data.error) || "Couldn't load calling points.");
  }
  callingPointsCache.set(cacheKey, data.points || []);
  return data.points || [];
}

async function openCallingPoints(card, key) {
  const wrap = card.querySelector(".calling-points-wrap");
  const statusEl = card.querySelector(".calling-points-status");
  const listEl = card.querySelector(".calling-points");
  const toggle = card.querySelector(".calling-points-toggle");
  const { uniqueIdentity } = card.dataset;

  wrap.classList.remove("hidden");
  if (toggle) toggle.setAttribute("aria-expanded", "true");
  expandedCallingPoints.add(key);

  if (!uniqueIdentity) {
    statusEl.textContent = "Calling points aren't available for this train.";
    statusEl.classList.remove("hidden");
    listEl.innerHTML = "";
    return;
  }

  const cacheKey = callingPointsCacheKey(uniqueIdentity);
  if (callingPointsCache.has(cacheKey)) {
    statusEl.classList.add("hidden");
    renderCallingPointsList(listEl, callingPointsCache.get(cacheKey));
    return;
  }

  statusEl.textContent = "Loading calling points…";
  statusEl.classList.remove("hidden");
  listEl.innerHTML = "";

  try {
    const points = await loadCallingPoints(uniqueIdentity);
    // The card may have re-rendered (and this exact node been replaced)
    // while the fetch was in flight - re-look-up the live elements by id
    // rather than trusting the closed-over references are still attached.
    const liveCard = boardRows.querySelector(`.card[data-id="${CSS.escape(key)}"]`);
    const liveList = liveCard ? liveCard.querySelector(".calling-points") : listEl;
    const liveStatus = liveCard ? liveCard.querySelector(".calling-points-status") : statusEl;
    liveStatus.classList.add("hidden");
    renderCallingPointsList(liveList, points);
  } catch (err) {
    statusEl.textContent = err.message || "Couldn't load calling points.";
    statusEl.classList.remove("hidden");
  }
}

function closeCallingPoints(card, key) {
  const wrap = card.querySelector(".calling-points-wrap");
  const toggle = card.querySelector(".calling-points-toggle");
  wrap.classList.add("hidden");
  if (toggle) toggle.setAttribute("aria-expanded", "false");
  expandedCallingPoints.delete(key);
}

// Delegated so it keeps working as rows re-render every update
boardRows.addEventListener("click", (e) => {
  const btn = e.target.closest(".calling-points-toggle");
  if (!btn) return;
  const card = btn.closest(".card");
  if (!card) return;
  const key = card.dataset.id;
  if (expandedCallingPoints.has(key)) {
    closeCallingPoints(card, key);
  } else {
    openCallingPoints(card, key);
  }
});

// --- Socket.IO live connection ---
const socket = io();

socket.on("connect", () => {
  console.log("Connected to live train feed");
});

socket.on("train_update", (data) => {
  window.TrainTracker.lastError = data.error || null;
  updateFeedErrorBanner(window.TrainTracker.lastError);
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

// Remembers the last status/expected/platform we notified about per train
// id, so a train sitting at "Delayed" (or on the same platform) doesn't
// re-notify every 30s tick - only when something actually changes (goes
// cancelled, delay grows, platform gets confirmed or changes, etc).
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
    new Notification(title, { body, tag: `train-${trainKey(train)}`, renotify: true });
  } catch (err) {
    console.error("Failed to show desktop notification:", err);
  }
}

// Notifies when a watched train's platform becomes known, gets confirmed
// (moves from an estimated "planned" platform to a confirmed "actual" one -
// even if the number stays the same), or changes to a different number.
function sendPlatformNotification(train, prev, isConfirmationOnly) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;

  const hadPlatform = prev && prev.platform && prev.platform !== "—";
  let title;
  let body;

  if (!hadPlatform) {
    title = `Platform ${train.platform} — ${train.time} to ${train.destination}`;
    body = train.platformEstimated
      ? `Estimated platform: ${train.platform}`
      : `Platform confirmed: ${train.platform}`;
  } else if (isConfirmationOnly) {
    title = `Platform Confirmed — ${train.time} to ${train.destination}`;
    body = `Platform ${train.platform} is now confirmed.`;
  } else {
    title = `Platform Changed — ${train.time} to ${train.destination}`;
    body = `Now ${train.platformEstimated ? "estimated" : "confirmed"} platform ${train.platform} (was ${prev.platform}).`;
  }

  try {
    // renotify: true is essential here - without it, a notification sharing
    // the same tag as a still-visible earlier one (e.g. "newly known" then
    // "confirmed" for the same train) gets silently swapped in by the
    // browser with no new alert, so the confirmation appears to never fire.
    new Notification(title, { body, tag: `train-platform-${trainKey(train)}`, renotify: true });
  } catch (err) {
    console.error("Failed to show platform notification:", err);
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
    const shouldNotifyStatus =
      NotifySettings.watchedIds.has(idKey) &&
      (statusChanged || significantTimeChange) &&
      (isBad || (!isBad && wasBad)); // Notify on bad state or recovery

    // Platform: notify once a platform becomes known, once an estimated
    // ("planned") platform gets confirmed ("actual") - even if the number
    // doesn't change - and any time the platform number itself changes.
    const hasPlatform = !!t.platform && t.platform !== "—";
    const prevHasPlatform = !!prev && !!prev.platform && prev.platform !== "—";
    const platformValueChanged =
      !!prev && prevHasPlatform && hasPlatform && prev.platform !== t.platform;
    const platformNewlyKnown = !!prev && !prevHasPlatform && hasPlatform;
    const platformConfirmed =
      !!prev && prevHasPlatform && !!prev.platformEstimated && !t.platformEstimated && hasPlatform;
    const shouldNotifyPlatform =
      NotifySettings.watchedIds.has(idKey) &&
      hasPlatform &&
      (platformValueChanged || platformNewlyKnown || platformConfirmed);

    if (shouldNotifyStatus) {
      sendDesktopNotification(t, prevDelay);
    }
    if (shouldNotifyPlatform) {
      sendPlatformNotification(t, prev, platformConfirmed && !platformValueChanged);
    }

    if (shouldNotifyStatus || shouldNotifyPlatform || !prev) {
      // Update memory when we notify, or to seed initial state
      notifyMemory.set(idKey, {
        status: t.status,
        expected: t.expected,
        delayMinutes: currentDelay,
        platform: t.platform,
        platformEstimated: t.platformEstimated,
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
        delayMinutes: inferDelayMinutes(current) || 0,
        platform: current.platform,
        platformEstimated: current.platformEstimated,
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

  // Scores how well a stop matches the typed query, lower is better. Plain
  // substring matching (the old behaviour) left results in whatever order
  // allStops happened to be in - alphabetical by description - so typing
  // "ear" showed "Bearley" above "Earley" even though "EAR" is Earley's
  // exact short code. Ranking by match quality first fixes that.
  function matchScore(stop, q) {
    const name = stop.description.toLowerCase();
    const code = stop.shortCode.toLowerCase();

    if (code === q) return 0; // exact short code, e.g. "ear" -> EAR
    if (name.startsWith(q)) return 1; // name starts with query
    if (code.startsWith(q)) return 2; // code starts with query
    if (name.includes(` ${q}`)) return 3; // query starts a later word
    if (name.includes(q) || code.includes(q)) return 4; // buried anywhere else
    return -1; // no match
  }

  function renderSuggestions(query) {
    list.innerHTML = "";
    const q = query.trim().toLowerCase();
    if (!q) {
      list.classList.remove("open");
      return;
    }

    const matches = allStops
      .map((s) => ({ stop: s, score: matchScore(s, q) }))
      .filter((m) => m.score !== -1)
      .sort((a, b) => a.score - b.score || a.stop.description.localeCompare(b.stop.description))
      .slice(0, 8)
      .map((m) => m.stop);

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
  window.TrainTracker.currentRoute = { fromDescription: fromDesc, toDescription: toDesc };

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