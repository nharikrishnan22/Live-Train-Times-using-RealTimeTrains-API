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

from flask import Flask, render_template
from flask_socketio import SocketIO

print("[2/5] Flask + Flask-SocketIO imported OK", flush=True)

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "train-tracker-dev-secret")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

print("[3/5] Flask app + SocketIO object created OK", flush=True)

RTT_BASE_URL = os.getenv("RTT_BASE_URL", "https://data.rtt.io").rstrip("/")
RTT_NAMESPACE = os.getenv("RTT_NAMESPACE", "gb-nr")
RTT_LOCATION_CODE = os.getenv("RTT_LOCATION_CODE", "gb-nr:RDG")
# Credential used to obtain a short-lived access token from
# /api/get_access_token. This is NOT the token sent to the location
# endpoint directly - see fetch_access_token() below.
RTT_TOKEN = os.getenv("RTT_TOKEN")
RTT_ACCESS_TOKEN_URL = os.getenv(
    "RTT_ACCESS_TOKEN_URL", f"{RTT_BASE_URL}/api/get_access_token"
)
RTT_TIME_WINDOW = int(os.getenv("RTT_TIME_WINDOW", "60"))
RTT_FILTER_DESTINATION = os.getenv("RTT_FILTER_DESTINATION", "gb-nr:PAD")
RTT_TIME_FROM = os.getenv("RTT_TIME_FROM")
RTT_DETAILED = os.getenv("RTT_DETAILED", "true").lower() == "true"

state_lock = threading.RLock()
trains = []

# Cached access token for the location endpoint. Populated lazily by
# get_access_token() and refreshed whenever the location endpoint reports
# it's invalid/expired.
access_token_lock = threading.RLock()
_access_token = None


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

    return {
        "id": train_id,
        "destination": destination,
        "platform": platform,
        "time": scheduled_dt.strftime("%H:%M"),
        "status": status,
        "expected": expected,
        "_scheduled_dt": scheduled_dt,
        "_delay_minutes": delay_minutes,
    }


def public_payload(train_list):
    """Strip internal-only fields before sending to clients."""
    return [
        {k: v for k, v in t.items() if not k.startswith("_")}
        for t in train_list
    ]


def build_rtt_params(now=None):
    """Build RTT query params using the configured window unless explicit bounds are provided."""
    if now is None:
        now = datetime.now()

    params = {
        "code": RTT_LOCATION_CODE,
        "filterTo": RTT_FILTER_DESTINATION,
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


def seed_trains():
    global trains
    with state_lock:
        if not RTT_TOKEN:
            print("[4/5] RTT_TOKEN is not set. Waiting for live data...", flush=True)
            trains = []
            return

        try:
            services = fetch_rtt_services()
            trains = [
                normalize_service_to_train(service, idx + 1)
                for idx, service in enumerate(services[:10])
            ]
            trains.sort(key=lambda t: t["_scheduled_dt"])
        except Exception as exc:
            print(f"[4/5] RTT API unavailable: {exc}", flush=True)
            trains = []


def tick():
    """Background loop: refreshes the board from RTT live data."""
    while True:
        try:
            if not RTT_TOKEN:
                print("[tick] RTT_TOKEN is not set. Waiting for live data...", flush=True)
                socketio.emit("train_update", {"trains": []})
                socketio.sleep(30)
                continue

            services = fetch_rtt_services()
            with state_lock:
                normalized = [
                    normalize_service_to_train(service, idx + 1)
                    for idx, service in enumerate(services[:10])
                ]
                normalized.sort(key=lambda t: t["_scheduled_dt"])
                trains[:] = normalized
                payload = public_payload(trains)
            socketio.emit("train_update", {"trains": payload})
        except Exception as exc:
            print(f"[tick] RTT refresh error: {exc}", flush=True)
            socketio.emit("train_update", {"trains": []})

        socketio.sleep(30)


@app.route("/")
def index():
    return render_template("index.html")


@socketio.on("connect")
def on_connect():
    with state_lock:
        payload = public_payload(trains)
    socketio.emit("train_update", {"trains": payload})


background_started = False


def start_background_thread():
    global background_started
    if not background_started:
        background_started = True
        seed_trains()
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