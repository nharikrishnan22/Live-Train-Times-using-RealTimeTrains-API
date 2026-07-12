import unittest
from datetime import datetime

import app
from app import build_rtt_params, normalize_service_to_train


class RttMappingTests(unittest.TestCase):
    def test_normalize_service_to_train_handles_delay_and_cancelled(self):
        service = {
            "temporalData": {
                "departure": {
                    "scheduleAdvertised": "2026-07-12T15:37:03.861Z",
                    "realtimeAdvertisedLateness": 5,
                    "realtimeNoReport": False,
                    "isCancelled": False,
                }
            },
            "destination": [
                {
                    "location": {
                        "description": "Birmingham New Street",
                    }
                }
            ],
            "locationMetadata": {
                "platform": {"actual": "5"},
            },
            "scheduleMetadata": {
                "uniqueIdentity": "gb-nr:ABC123:2026-07-12",
            },
        }

        train = normalize_service_to_train(service, 7)

        self.assertEqual(train["id"], 7)
        self.assertEqual(train["destination"], "Birmingham New Street")
        self.assertEqual(train["platform"], "5")
        self.assertEqual(train["status"], "Delayed")
        self.assertEqual(train["expected"], "Exp 15:42")
        self.assertEqual(train["time"], "15:37")

    def test_normalize_service_to_train_handles_cancelled(self):
        service = {
            "temporalData": {
                "arrival": {
                    "scheduleAdvertised": "2026-07-12T12:05:00.000Z",
                    "isCancelled": True,
                }
            },
            "destination": [{"location": {"description": "Reading"}}],
            "locationMetadata": {"platform": {"planned": "3"}},
            "scheduleMetadata": {"uniqueIdentity": "gb-nr:XYZ999"},
        }

        train = normalize_service_to_train(service, 11)

        self.assertEqual(train["status"], "Cancelled")
        self.assertEqual(train["expected"], "Cancelled")
        self.assertEqual(train["platform"], "3")
        self.assertEqual(train["time"], "12:05")

    def test_normalize_service_to_train_checks_arrival_block_for_lateness(self):
        service = {
            "temporalData": {
                "departure": {
                    "scheduleAdvertised": "2026-07-12T14:20:00.000Z",
                    "realtimeNoReport": True,
                },
                "arrival": {
                    "scheduleAdvertised": "2026-07-12T14:20:00.000Z",
                    "realtimeAdvertisedLateness": 9,
                    "isCancelled": False,
                },
            },
            "destination": [{"location": {"description": "Leeds"}}],
            "locationMetadata": {"platform": {"actual": "8"}},
        }

        train = normalize_service_to_train(service, 12)

        self.assertEqual(train["status"], "Delayed")
        self.assertEqual(train["expected"], "Exp 14:29")
        self.assertEqual(train["platform"], "8")

    def test_prefers_departure_time_over_arrival_time(self):
        service = {
            "temporalData": {
                "arrival": {
                    "scheduleAdvertised": "2026-07-12T18:10:00.000Z",
                },
                "departure": {
                    "scheduleAdvertised": "2026-07-12T15:37:03.861Z",
                },
            },
            "destination": [{"location": {"description": "York"}}],
            "locationMetadata": {"platform": {"planned": "2"}},
        }

        train = normalize_service_to_train(service, 13)

        self.assertEqual(train["time"], "15:37")
        self.assertEqual(train["destination"], "York")

    def test_uses_departure_forecast_for_delay_minutes(self):
        service = {
            "temporalData": {
                "departure": {
                    "scheduleAdvertised": "2026-07-12T20:41:00",
                    "realtimeForecast": "2026-07-12T20:52:00",
                    "isCancelled": False,
                },
                "arrival": {
                    "scheduleAdvertised": "2026-07-12T20:35:00",
                    "realtimeForecast": "2026-07-12T20:34:00",
                    "isCancelled": False,
                },
            },
            "destination": [{"location": {"description": "London Paddington"}}],
            "locationMetadata": {"platform": {"planned": "10"}},
        }

        train = normalize_service_to_train(service, 14)

        self.assertEqual(train["status"], "Delayed")
        self.assertEqual(train["expected"], "Exp 20:52")
        self.assertEqual(train["time"], "20:41")
        self.assertEqual(train["_delay_minutes"], 11)

    def test_build_rtt_params_includes_lookback_and_future_window(self):
        now = datetime(2026, 7, 12, 20, 0, 0)

        params = build_rtt_params(now=now)

        self.assertEqual(params["timeFrom"], "2026-07-12T19:30:00")
        self.assertEqual(params["timeTo"], "2026-07-12T22:30:00")
        self.assertEqual(params["timeWindow"], "180")


if __name__ == "__main__":
    unittest.main()
