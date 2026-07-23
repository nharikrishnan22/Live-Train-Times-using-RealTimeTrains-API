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
RTT_TIME_WINDOW = int(os.getenv("RTT_TIME_WINDOW", "180"))
RTT_FILTER_DESTINATION = os.getenv("RTT_FILTER_DESTINATION", "PAD")
RTT_TIME_FROM = os.getenv("RTT_TIME_FROM")
RTT_DETAILED = os.getenv("RTT_DETAILED", "true").lower() == "true"
RTT_STOPS_URL = os.getenv("RTT_STOPS_URL", f"{RTT_BASE_URL}/data/stops")

state_lock = threading.RLock()
trains = []

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
    platform = (
        platform_metadata.get("actual")
        or platform_metadata.get("forecast")
        or platform_metadata.get("planned")
        or "—"
    )
    platform = str(platform)

    schedule_metadata = service.get("scheduleMetadata", {}) or {}
    mode = schedule_metadata.get("modeType")

    return {
        "id": train_id,
        "destination": destination,
        "platform": platform,
        "time": scheduled_dt.strftime("%H:%M"),
        "status": status,
        "expected": expected,
        "mode": mode,
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
    payload = _rtt_request(url, token)

    if isinstance(payload, dict) and payload.get("error") == "Invalid or expired token":
        token = get_access_token(force_refresh=True)
        payload = _rtt_request(url, token)

    return payload.get("services", [])


def fetch_stops_from_api():
    """Fetch the full station list from /data/stops, refreshing the access token once if it's stale."""
    token = get_access_token()
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
    """Fetch the latest trains for the current route and push them to every client."""
    try:
        normalized = fetch_and_normalize_trains()
        with state_lock:
            trains[:] = normalized
            payload = public_payload(trains)
        socketio.emit("train_update", {"trains": payload})
    except Exception as exc:
        print(f"[route] RTT refresh error: {exc}", flush=True)
        socketio.emit("train_update", {"trains": []})


def seed_trains():
    global trains
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


def tick():
    """Background loop: refreshes the board from RTT live data."""
    while True:
        if not RTT_TOKEN:
            print("[tick] RTT_TOKEN is not set. Waiting for live data...", flush=True)
            socketio.emit("train_update", {"trains": []})
        else:
            refresh_and_broadcast()

        socketio.sleep(30)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/stops")
def api_stops():
    return jsonify({"stops": get_stops()})


@socketio.on("connect")
def on_connect():
    with state_lock:
        payload = public_payload(trains)
    socketio.emit("train_update", {"trains": payload})
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
