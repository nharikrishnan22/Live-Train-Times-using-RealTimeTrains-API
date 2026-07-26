"""
Train Tracker - Flask + Flask-SocketIO backend
Simulates live train departure data and pushes updates to connected
clients in real time. Swap `generate_trains()` / `tick()` out for a
real rail API (e.g. National Rail, Amtrak, GTFS-RT) whenever you're ready.
"""

import json
import os
import threading
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from urllib.parse import urlencode

print("[1/5] Python starting, imports beginning...", flush=True)

from flask import Flask, jsonify, render_template, request
from flask_socketio import SocketIO

print("[2/5] Flask + Flask-SocketIO imported OK", flush=True)

# RTT_TOKEN is the only secret we load from a .env file (via python-dotenv).
# Everything else stays a regular env var / default, set directly in the
# shell or deployment environment rather than in .env.
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "train-tracker-dev-secret")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

print("[3/5] Flask app + SocketIO object created OK", flush=True)

RTT_BASE_URL = os.getenv("RTT_BASE_URL", "https://data.rtt.io").rstrip("/")
RTT_NAMESPACE = os.getenv("RTT_NAMESPACE", "gb-nr")
# Plain short code, e.g. "RDG" - the namespace is already part of the URL
# path (/{RTT_NAMESPACE}/location), so it must NOT be repeated here.
RTT_LOCATION_CODE = os.getenv("RTT_LOCATION_CODE", "RDG")
# Credential used to obtain a short-lived access token from
# /api/get_access_token. This is NOT the token sent to the location
# endpoint directly - see fetch_access_token() below.
# Loaded from a local .env file (via load_dotenv() above) - keep RTT_TOKEN
# out of shell history / process env and out of source control.
RTT_TOKEN = os.getenv("RTT_TOKEN")
RTT_ACCESS_TOKEN_URL = os.getenv(
    "RTT_ACCESS_TOKEN_URL", f"{RTT_BASE_URL}/api/get_access_token"
)
RTT_TIME_WINDOW = int(os.getenv("RTT_TIME_WINDOW", "360"))
RTT_FILTER_DESTINATION = os.getenv("RTT_FILTER_DESTINATION", "PAD")
RTT_TIME_FROM = os.getenv("RTT_TIME_FROM")
RTT_DETAILED = os.getenv("RTT_DETAILED", "true").lower() == "true"
RTT_STOPS_URL = os.getenv("RTT_STOPS_URL", f"{RTT_BASE_URL}/data/stops")

state_lock = threading.RLock()
trains = []

# Tracks the most recent refresh failure message (or None if the last
# refresh succeeded). Lets new connections know the board may be showing
# stale data, without ever having to clear `trains` just because a fetch
# failed.
refresh_error_lock = threading.RLock()
last_refresh_error = None

# Cached access token for the location endpoint. Populated lazily by
# get_access_token() and refreshed whenever the location endpoint reports
# it's invalid/expired.
access_token_lock = threading.RLock()
_access_token = None

# Cached station list from /data/stops, used to populate the from/to
# autocomplete and to validate routes a client asks us to switch to.
stops_lock = threading.RLock()
_stops_cache = None

# The route currently shown on the board. Starts from the RTT_LOCATION_CODE /
# RTT_FILTER_DESTINATION env defaults, and can be changed live by any
# connected client via the "set_route" socket event - the whole board is
# shared, so this updates what everyone sees.
def _initial_route_code(value):
    """Strip a leading "<namespace>:" prefix and uppercase, for seeding
    current_route from env defaults before strip_namespace_prefix exists."""
    if not value:
        return value
    prefix = f"{RTT_NAMESPACE}:"
    if value.startswith(prefix):
        value = value[len(prefix):]
    return value.upper()


route_lock = threading.RLock()
current_route = {
    "from": _initial_route_code(RTT_LOCATION_CODE),
    "to": _initial_route_code(RTT_FILTER_DESTINATION),
    "from_description": None,
    "to_description": None,
}


def expected_text(status, scheduled_dt, delay_minutes):
    """Mirrors the wording used on real UK departure boards."""
    if status == "Cancelled":
        return "Cancelled"
    if status == "Delayed":
        expected_dt = scheduled_dt + timedelta(minutes=delay_minutes)
        return f"Exp {expected_dt.strftime('%H:%M')}"
    return "On time"


def parse_datetime(value):
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def normalize_service_to_train(service, train_id):
    """Convert an RTT location service into the existing train payload shape."""
    temporal_data = service.get("temporalData", {}) or {}

    # RTT calls a service at a station via a "departure" block (and/or an
    # "arrival" block if it's not originating here). Prefer departure since
    # that's what a departure board cares about; fall back to arrival for
    # services that terminate at this location.
    departure_block = temporal_data.get("departure")
    arrival_block = temporal_data.get("arrival")
    primary_block = departure_block if isinstance(departure_block, dict) else arrival_block

    scheduled_dt = None
    forecast_dt = None
    is_cancelled = False

    if isinstance(primary_block, dict):
        is_cancelled = bool(primary_block.get("isCancelled"))

        for field in ["scheduleAdvertised", "scheduleInternal"]:
            value = primary_block.get(field)
            if not value:
                continue
            parsed_dt = parse_datetime(value)
            if parsed_dt:
                scheduled_dt = parsed_dt
                break

        forecast_value = primary_block.get("realtimeForecast")
        if forecast_value:
            forecast_dt = parse_datetime(forecast_value)

    if scheduled_dt is None:
        scheduled_dt = datetime.now()

    delay_minutes = 0
    if scheduled_dt and forecast_dt and forecast_dt > scheduled_dt:
        delay_minutes = int((forecast_dt - scheduled_dt).total_seconds() // 60)

    if is_cancelled:
        status = "Cancelled"
        expected = "Cancelled"
    elif delay_minutes > 0:
        status = "Delayed"
        expected = expected_text("Delayed", scheduled_dt, delay_minutes)
    else:
        status = "On time"
        expected = "On time"

    destination = ""
    for segment in service.get("destination", []) or []:
        location = segment.get("location", {}) or {}
        description = location.get("description")
        if description:
            destination = description
            break

    location_metadata = service.get("locationMetadata", {}) or {}
    platform_metadata = location_metadata.get("platform", {}) or {}
    platform_actual = platform_metadata.get("actual")
    platform_planned = platform_metadata.get("planned")

    # Only "actual" is a confirmed platform. If it's missing, fall back to
    # "planned" but flag it as an estimate (ignore "forecast" entirely -
    # it's not reliable enough to present as a platform number).
    platform_estimated = False
    if platform_actual:
        platform = platform_actual
    elif platform_planned:
        platform = platform_planned
        platform_estimated = True
    else:
        platform = "—"
    platform = str(platform)

    schedule_metadata = service.get("scheduleMetadata", {}) or {}
    mode = (schedule_metadata.get("modeType") or "TRAIN").upper()
    operator = schedule_metadata.get("operator", {}) or {}
    operator_code = operator.get("code")
    operator_name = operator.get("name")

    # uniqueIdentity (e.g. "gb-nr:C82320:2026-07-26") is what RTT's
    # /rtt/service lookup needs to fetch this service's full calling points
    # - see fetch_calling_points() below. It's deliberately NOT
    # underscore-prefixed so public_payload() keeps it and the client can
    # request the calling points for a given card.
    unique_identity = schedule_metadata.get("uniqueIdentity")

    return {
        "id": train_id,
        "destination": destination,
        "platform": platform,
        "platformEstimated": platform_estimated,
        "time": scheduled_dt.strftime("%H:%M"),
        "status": status,
        "expected": expected,
        "mode": mode,
        "operatorCode": operator_code,
        "operatorName": operator_name,
        "uniqueIdentity": unique_identity,
        "_scheduled_dt": scheduled_dt,
        "_delay_minutes": delay_minutes,
    }


def public_payload(train_list):
    """Strip internal-only fields before sending to clients."""
    return [
        {k: v for k, v in t.items() if not k.startswith("_")}
        for t in train_list
    ]


def strip_namespace_prefix(code):
    """Location/filter codes must be plain short codes (e.g. "RDG"), not
    namespaced ones (e.g. "gb-nr:RDG") - the namespace already lives in the
    URL path. Strip it defensively in case it's set that way in the env."""
    if not code:
        return code
    prefix = f"{RTT_NAMESPACE}:"
    if code.startswith(prefix):
        return code[len(prefix):]
    return code


def get_current_route():
    with route_lock:
        return dict(current_route)


def set_current_route(from_code, to_code, from_description=None, to_description=None):
    with route_lock:
        current_route["from"] = from_code
        current_route["to"] = to_code
        current_route["from_description"] = from_description
        current_route["to_description"] = to_description


def build_rtt_params(now=None):
    """Build RTT query params for the currently selected from/to route."""
    if now is None:
        now = datetime.now()

    route = get_current_route()
    params = {
        "code": strip_namespace_prefix(route["from"]),
        "filterTo": strip_namespace_prefix(route["to"]),
        "timeWindow": str(RTT_TIME_WINDOW),
    }

    if RTT_TIME_FROM:
        params["timeFrom"] = RTT_TIME_FROM
    if RTT_DETAILED:
        params["detailed"] = "true"
    return params


class RttTokenExpiredError(RuntimeError):
    """Raised when RTT responds with HTTP 401, meaning the bearer token is invalid/expired."""


def _rtt_request(url, bearer_token, method="GET"):
    """Issue a bearer-authenticated request against the RTT API and return the parsed JSON body."""
    request = urllib.request.Request(
        url,
        method=method,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {bearer_token}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        error_text = exc.read().decode("utf-8", "ignore")
        # RTT signals an expired/invalid token two different ways: some
        # endpoints return HTTP 200 with {"error": "Invalid or expired
        # token"} in the body (handled by callers below), others return a
        # genuine HTTP 401. That second case used to surface here as a plain
        # RuntimeError, which callers had no way to distinguish from any
        # other RTT API failure - so the token never got refreshed and every
        # subsequent request kept failing with 401 until the process
        # restarted. Raise a distinct type so callers can catch it and retry
        # with a freshly fetched token.
        if exc.code == 401:
            raise RttTokenExpiredError(f"RTT API error {exc.code}: {error_text}") from exc
        raise RuntimeError(f"RTT API error {exc.code}: {error_text}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Unable to reach RTT API: {exc.reason}") from exc


def fetch_access_token():
    """Exchange RTT_TOKEN for a short-lived access token via /api/get_access_token."""
    if not RTT_TOKEN:
        raise RuntimeError("RTT_TOKEN is not set. Configure it before using the RTT API.")

    payload = _rtt_request(RTT_ACCESS_TOKEN_URL, RTT_TOKEN, method="POST")

    token = payload.get("token") or payload.get("access_token")
    if not token:
        raise RuntimeError(f"RTT access token response did not include a token: {payload}")
    return token


def get_access_token(force_refresh=False):
    """Return a cached access token, fetching (or refetching) one if needed."""
    global _access_token
    with access_token_lock:
        if _access_token is None or force_refresh:
            _access_token = fetch_access_token()
        return _access_token


def fetch_rtt_services():
    """Fetch services from the RTT location endpoint, refreshing the access token once if it's stale."""
    params = build_rtt_params()
    url = f"{RTT_BASE_URL}/{RTT_NAMESPACE}/location?{urlencode(params)}"

    token = get_access_token()
    try:
        payload = _rtt_request(url, token)
    except RttTokenExpiredError:
        token = get_access_token(force_refresh=True)
        payload = _rtt_request(url, token)

    if isinstance(payload, dict) and payload.get("error") == "Invalid or expired token":
        token = get_access_token(force_refresh=True)
        payload = _rtt_request(url, token)

    # If RTT is still reporting an error after the retry (expired token even
    # after a refresh, or some other API error), don't silently fall through
    # to an empty services list - that reads to refresh_and_broadcast() as
    # "zero departures" and wipes a board that may already have good data on
    # it. Raise instead so the caller can keep the existing board as-is.
    if isinstance(payload, dict) and payload.get("error"):
        raise RuntimeError(f"RTT location error: {payload['error']}")

    return payload.get("services", [])


def _calling_point_status(scheduled_dt, is_cancelled, now):
    """Classifies a single calling point for display, mirroring the
    departed / current / future states used on real UK calling-point lists."""
    if is_cancelled:
        return "cancelled"
    if scheduled_dt and scheduled_dt <= now:
        return "departed"
    return "future"


def normalize_calling_point(location, now, current_short_codes=None):
    """Convert one entry from RTT's /rtt/service "locations" array into the
    shape the calling-points UI needs. Each entry nests its timing under
    "temporalData" (departure/arrival blocks using the same
    scheduleAdvertised/scheduleInternal/realtimeForecast/isCancelled fields
    as the main location-listing endpoint), and identifies the station via
    "location.shortCodes" (a list, since a station can have more than one
    code) rather than a single "crs"."""
    temporal_data = location.get("temporalData", {}) or {}
    departure_block = temporal_data.get("departure") if isinstance(temporal_data.get("departure"), dict) else None
    arrival_block = temporal_data.get("arrival") if isinstance(temporal_data.get("arrival"), dict) else None
    # Prefer departure (what a departure board cares about) but fall back to
    # arrival for the terminating stop, which typically has no departure block.
    primary_block = departure_block or arrival_block or {}

    is_cancelled = bool(primary_block.get("isCancelled"))
    scheduled_dt = None
    for field in ["scheduleAdvertised", "scheduleInternal"]:
        value = primary_block.get(field)
        if value:
            scheduled_dt = parse_datetime(value)
            if scheduled_dt:
                break

    forecast_dt = None
    forecast_value = primary_block.get("realtimeForecast")
    if forecast_value:
        forecast_dt = parse_datetime(forecast_value)

    if is_cancelled:
        expected_label = "Cancelled"
    elif forecast_dt and scheduled_dt and forecast_dt > scheduled_dt:
        expected_label = f"Exp {forecast_dt.strftime('%H:%M')}"
    else:
        expected_label = "On time"

    loc_info = location.get("location", {}) or {}
    short_codes = loc_info.get("shortCodes") or []
    is_current = bool(current_short_codes) and bool(set(short_codes) & set(current_short_codes))

    return {
        "station": loc_info.get("description") or "Unknown",
        "time": scheduled_dt.strftime("%H:%M") if scheduled_dt else "—",
        "expected": expected_label,
        "status": _calling_point_status(scheduled_dt, is_cancelled, now),
        "isCurrent": is_current,
        "_scheduled_dt": scheduled_dt,
    }


def fetch_calling_points(unique_identity, current_short_codes=None):
    """Fetch the full stop-by-stop calling points for one service from
    RTT's /rtt/service lookup, keyed by its uniqueIdentity (e.g.
    "gb-nr:C82320:2026-07-26" - namespace:identity:departureDate, taken
    straight from that service's scheduleMetadata.uniqueIdentity)."""
    url = f"{RTT_BASE_URL}/rtt/service?uniqueIdentity={unique_identity}"

    token = get_access_token()
    try:
        payload = _rtt_request(url, token)
    except RttTokenExpiredError:
        token = get_access_token(force_refresh=True)
        payload = _rtt_request(url, token)

    if isinstance(payload, dict) and payload.get("error") == "Invalid or expired token":
        token = get_access_token(force_refresh=True)
        payload = _rtt_request(url, token)

    if isinstance(payload, dict) and payload.get("error"):
        raise RuntimeError(f"RTT service error: {payload['error']}")

    service_block = payload.get("service", {}) if isinstance(payload, dict) else {}
    raw_locations = service_block.get("locations", []) if isinstance(service_block, dict) else []

    now = datetime.now()
    points = [normalize_calling_point(loc, now, current_short_codes) for loc in raw_locations]
    points.sort(key=lambda p: (p["_scheduled_dt"] is None, p["_scheduled_dt"]))

    for point in points:
        del point["_scheduled_dt"]
    if points:
        points[0]["isOrigin"] = True
        points[-1]["isDestination"] = True
    for point in points:
        point.setdefault("isOrigin", False)
        point.setdefault("isDestination", False)

    return points


def fetch_stops_from_api():
    """Fetch the full station list from /data/stops, refreshing the access token once if it's stale."""
    token = get_access_token()
    try:
        payload = _rtt_request(RTT_STOPS_URL, token)
    except RttTokenExpiredError:
        token = get_access_token(force_refresh=True)
        payload = _rtt_request(RTT_STOPS_URL, token)

    if isinstance(payload, dict) and payload.get("error") == "Invalid or expired token":
        token = get_access_token(force_refresh=True)
        payload = _rtt_request(RTT_STOPS_URL, token)

    raw_stops = payload.get("stops", []) if isinstance(payload, dict) else []

    stops = [
        {
            "description": s.get("description"),
            "shortCode": s.get("shortCode"),
            "uniqueIdentity": s.get("uniqueIdentity"),
        }
        for s in raw_stops
        if s.get("namespace") == RTT_NAMESPACE and s.get("description") and s.get("shortCode")
    ]
    stops.sort(key=lambda s: s["description"])
    return stops


def get_stops(force_refresh=False):
    """Return the cached station list, fetching it on first use (or on demand)."""
    global _stops_cache
    with stops_lock:
        if _stops_cache is None or force_refresh:
            try:
                _stops_cache = fetch_stops_from_api()
            except Exception as exc:
                print(f"[stops] Unable to fetch station list: {exc}", flush=True)
                if _stops_cache is None:
                    _stops_cache = []
        return _stops_cache


def initialize_route_descriptions():
    """Backfill from/to_description for the default route once the station list is available."""
    stops = get_stops()
    if not stops:
        return
    by_code = {s["shortCode"].upper(): s["description"] for s in stops}
    with route_lock:
        if not current_route["from_description"]:
            current_route["from_description"] = by_code.get(current_route["from"])
        if not current_route["to_description"]:
            current_route["to_description"] = by_code.get(current_route["to"])


def fetch_and_normalize_trains():
    services = fetch_rtt_services()
    normalized = [
        normalize_service_to_train(service, idx + 1)
        for idx, service in enumerate(services[:10])
    ]
    normalized.sort(key=lambda t: t["_scheduled_dt"])
    return normalized


def refresh_and_broadcast():
    """Fetch the latest trains for the current route and push them to every client.

    On failure, the existing `trains` cache is left untouched - a transient
    RTT/token error should not wipe a board that already has good data on
    it. tick() already retries this every 30s, so that doubles as a silent
    retry. Clients are told about the error via the "error" field so they
    can show a subtle notice, but they keep rendering whatever `trains`
    already contains. Only when there's no cached data at all (e.g. a fresh
    page load during an outage) does the error actually read as "no data".
    """
    global last_refresh_error
    try:
        normalized = fetch_and_normalize_trains()
        with state_lock:
            trains[:] = normalized
            payload = public_payload(trains)
        with refresh_error_lock:
            last_refresh_error = None
        socketio.emit("train_update", {"trains": payload, "error": None})
    except Exception as exc:
        print(f"[route] RTT refresh error: {exc}", flush=True)
        message = "Live departures temporarily unavailable - retrying..."
        with refresh_error_lock:
            last_refresh_error = message
        with state_lock:
            payload = public_payload(trains)
        socketio.emit("train_update", {"trains": payload, "error": message})


def seed_trains():
    global trains, last_refresh_error
    with state_lock:
        if not RTT_TOKEN:
            print("[4/5] RTT_TOKEN is not set. Waiting for live data...", flush=True)
            trains = []
            return

        try:
            trains = fetch_and_normalize_trains()
        except Exception as exc:
            print(f"[4/5] RTT API unavailable: {exc}", flush=True)
            trains = []
            with refresh_error_lock:
                last_refresh_error = "Live departures temporarily unavailable - retrying..."


def tick():
    """Background loop: refreshes the board from RTT live data."""
    while True:
        if not RTT_TOKEN:
            print("[tick] RTT_TOKEN is not set. Waiting for live data...", flush=True)
            socketio.emit("train_update", {"trains": [], "error": "RTT_TOKEN is not configured."})
        else:
            refresh_and_broadcast()

        socketio.sleep(30)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/stops")
def api_stops():
    return jsonify({"stops": get_stops()})


@app.route("/api/calling-points/<path:unique_identity>")
def api_calling_points(unique_identity):
    """Stop-by-stop calling points for one train, fetched on demand when a
    card is expanded on the board (rather than upfront for every train, to
    avoid a burst of extra RTT requests on every 30s refresh)."""
    with route_lock:
        current_short_codes = [current_route["from"]] if current_route.get("from") else None
    try:
        points = fetch_calling_points(unique_identity, current_short_codes=current_short_codes)
    except Exception as exc:
        print(f"[calling-points] {unique_identity} failed: {exc}", flush=True)
        return jsonify({"error": "Couldn't load calling points for this train."}), 502
    return jsonify({"points": points})


@socketio.on("connect")
def on_connect():
    with state_lock:
        payload = public_payload(trains)
    with refresh_error_lock:
        error = last_refresh_error
    socketio.emit("train_update", {"trains": payload, "error": error})
    socketio.emit("route_updated", get_current_route())


@socketio.on("set_route")
def on_set_route(data):
    """A client is asking to point the (shared) board at a different from/to route."""
    data = data or {}
    from_code = strip_namespace_prefix(str(data.get("from") or "").strip()).upper()
    to_code = strip_namespace_prefix(str(data.get("to") or "").strip()).upper()
    from_description = data.get("fromDescription")
    to_description = data.get("toDescription")

    if not from_code or not to_code:
        socketio.emit(
            "route_error",
            {"message": "Both a from and to station are required."},
            room=request.sid,
        )
        return

    if from_code == to_code:
        socketio.emit(
            "route_error",
            {"message": "From and to can't be the same station."},
            room=request.sid,
        )
        return

    # Validate against the known station list when we have one; if the list
    # is temporarily unavailable, fail open rather than blocking every route
    # change on it.
    stops = get_stops()
    if stops:
        valid_codes = {s["shortCode"].upper() for s in stops}
        by_code = {s["shortCode"].upper(): s["description"] for s in stops}
        if from_code not in valid_codes or to_code not in valid_codes:
            socketio.emit(
                "route_error",
                {"message": "Unrecognised station - please pick one from the suggestions."},
                room=request.sid,
            )
            return
        from_description = from_description or by_code.get(from_code)
        to_description = to_description or by_code.get(to_code)

    set_current_route(from_code, to_code, from_description, to_description)
    socketio.emit("route_updated", get_current_route())
    refresh_and_broadcast()


background_started = False


def start_background_thread():
    global background_started
    if not background_started:
        background_started = True
        seed_trains()
        initialize_route_descriptions()
        print("[4/5] Trains seeded, starting background ticker thread...", flush=True)
        # Explicit daemon=True so this thread can never block the process
        # from exiting or interfere with the reloader.
        t = threading.Thread(target=tick, daemon=True)
        t.start()


if __name__ == "__main__":
    start_background_thread()
    print("[5/5] Starting web server on http://127.0.0.1:5000 ...", flush=True)
    try:
        # use_reloader=False: the auto-reloader re-executes this whole file
        # in a subprocess, which is unnecessary here and can cause issues
        # on some Windows terminal setups.
        socketio.run(
            app,
            host="127.0.0.1",
            port=5000,
            debug=True,
            use_reloader=False,
            allow_unsafe_werkzeug=True,
        )
    except Exception:
        import traceback
        traceback.print_exc()
        input("\nServer crashed - press Enter to close this window...")
else:
    # In case this is imported under a WSGI runner
    start_background_thread()