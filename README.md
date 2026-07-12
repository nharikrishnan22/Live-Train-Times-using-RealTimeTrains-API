# Train Tracker

A small Flask app that shows live-updating train departures, with a
floating "mini player" powered by the **Document Picture-in-Picture**
API — the same kind of always-on-top window YouTube uses, but showing
your next train instead of a video.

## Features

- Flask + Flask-SocketIO backend pushing live updates from the RTT API
- Direct integration with the RTT location endpoint for live service data
- Trainline-inspired card layout: white rounded cards, navy/mint/pink
  colour palette, status pills for On time / Delayed / Cancelled
- Floating "mini player" powered by Document Picture-in-Picture
- Graceful fallback message if your browser doesn't support PiP

## Setup

```bash
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Set the RTT environment variables before running the app:

```bash
set RTT_BEARER_TOKEN=your-token-here
set RTT_NAMESPACE=gb-nr
set RTT_LOCATION_CODE=CLPHMJN
set RTT_API_VERSION=2025-10-25
set RTT_TIME_WINDOW=60
```

Then start the app:

```bash
python app.py
```

Then open **http://localhost:5000** in **Chrome or Edge 116+** (the
Document Picture-in-Picture API is currently Chromium-only).

## Using the mini player

1. Click **"⧉ Mini Player"** in the top bar.
2. A small floating window pops out, showing the same live train list,
   styled to match the main page.
3. It stays on top of other windows/tabs while you do other things —
   drag it anywhere on screen.
4. Close it from its own window controls, or click the button again.

If your browser doesn't support the API, you'll see a fallback message
instead, and the full board still works normally on the page.

## Project structure

```
train-tracker/
├── app.py                # Flask + Socket.IO backend, RTT API integration
├── requirements.txt
├── templates/
│   └── index.html        # Main page markup
├── static/
│   ├── style.css          # Dark theme, shared by main page + PiP window
│   ├── app.js              # Socket.IO client, board rendering, shared state
│   └── pip.js               # Document Picture-in-Picture logic
└── README.md
```

## RTT API integration

The app is wired to call the RTT location endpoint at:

```text
https://data.rtt.io/gb-nr/location
```

It sends the bearer token in the `Authorization` header and uses the
`Version` header plus query parameters such as `code` and `timeWindow`.

The backend converts each RTT service entry into the UI payload shape used
by the app:

- `destination`
- `platform`
- `time`
- `status`
- `expected`

If the bearer token is missing or the request fails, the app will not have
any live departures to display, so make sure the environment variables are
set correctly before launching the server.
