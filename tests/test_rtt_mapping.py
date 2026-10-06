import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import app
from app import build_rtt_params, normalize_calling_point, normalize_service_to_train


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


class CancelledDestinationTests(unittest.TestCase):
    def setUp(self):
        app.scheduled_service_destination.cache_clear()
        self.addCleanup(app.scheduled_service_destination.cache_clear)
        self.service = {
            "temporalData": {"departure": {
                "scheduleAdvertised": "2026-10-06T19:50:00",
                "isCancelled": True,
            }},
            "destination": [{"location": {"description": "Banbury"}}],
            "scheduleMetadata": {"uniqueIdentity": "gb-nr:TEST:2026-10-06"},
        }

    def test_cancelled_card_keeps_scheduled_final_destination(self):
        points = [
            {"station": "Banbury", "status": "cancelled", "isDestination": False},
            {"station": "Bournemouth", "status": "cancelled", "isDestination": True},
        ]
        with patch.object(app, "fetch_rtt_services", return_value=[self.service]), \
             patch.object(app, "fetch_calling_points", return_value=points) as details:
            first = app.fetch_and_normalize_trains()[0]
            second = app.fetch_and_normalize_trains()[0]
        self.assertEqual(first["destination"], "Bournemouth")
        self.assertEqual(second["destination"], "Bournemouth")
        self.assertEqual(first["status"], "Cancelled")
        self.assertEqual(first["time"], "19:50")
        details.assert_called_once_with("gb-nr:TEST:2026-10-06")

    def test_active_train_keeps_listing_destination_without_detail_request(self):
        self.service["temporalData"]["departure"]["isCancelled"] = False
        with patch.object(app, "fetch_rtt_services", return_value=[self.service]), \
             patch.object(app, "fetch_calling_points") as details:
            train = app.fetch_and_normalize_trains()[0]
        self.assertEqual(train["destination"], "Banbury")
        details.assert_not_called()

    def test_detail_failure_keeps_board_available_and_retries(self):
        with patch.object(app, "fetch_rtt_services", return_value=[self.service]), \
             patch.object(app, "fetch_calling_points", side_effect=[
                 RuntimeError("Detail unavailable"),
                 [{"station": "Bournemouth", "isDestination": True}],
             ]) as details:
            first = app.fetch_and_normalize_trains()[0]
            second = app.fetch_and_normalize_trains()[0]
        self.assertEqual(first["destination"], "Banbury")
        self.assertEqual(second["destination"], "Bournemouth")
        self.assertEqual(details.call_count, 2)

    def test_empty_detail_is_retried_instead_of_cached(self):
        with patch.object(app, "fetch_rtt_services", return_value=[self.service]), \
             patch.object(app, "fetch_calling_points", side_effect=[
                 [], [{"station": "Bournemouth", "isDestination": True}],
             ]):
            first = app.fetch_and_normalize_trains()[0]
            second = app.fetch_and_normalize_trains()[0]
        self.assertEqual(first["destination"], "Banbury")
        self.assertEqual(second["destination"], "Bournemouth")


class CallingPointTests(unittest.TestCase):
    def point(self, timing, now=None, block="departure"):
        return normalize_calling_point(
            {"temporalData": {block: timing}, "location": {"description": "Reading"}},
            now or datetime(2026, 10, 6, 12, 0),
        )

    def test_passed_stop_uses_actual_even_when_early_or_on_time(self):
        for actual in ["11:28", "11:30", "11:35"]:
            with self.subTest(actual=actual):
                point = self.point({
                    "scheduleAdvertised": "2026-10-06T11:30:00",
                    "realtimeActual": f"2026-10-06T{actual}:00",
                    "realtimeForecast": "2026-10-06T11:40:00",
                })
                self.assertEqual(point["liveTime"], actual)
                self.assertEqual(point["expected"], actual)
                self.assertEqual(point["status"], "departed")
                self.assertEqual(point["time"], "11:30")

    def test_delayed_upcoming_stop_is_not_passed_when_schedule_elapses(self):
        point = self.point({
            "scheduleAdvertised": "2026-10-06T11:55:00",
            "realtimeForecast": "2026-10-06T12:10:00",
        })
        self.assertEqual(point["liveTime"], "12:10")
        self.assertEqual(point["status"], "future")

    def test_elapsed_forecast_is_not_confirmation_of_departure(self):
        point = self.point({"realtimeForecast": "2026-10-06T11:55:00"})
        self.assertEqual(point["status"], "future")

    def test_missing_live_time_does_not_substitute_schedule(self):
        point = self.point({"scheduleAdvertised": "2026-10-06T12:10:00"})
        self.assertIsNone(point["liveTime"])

    def test_actual_without_schedule_and_timezone_aware_times(self):
        point = self.point(
            {"realtimeActual": "2026-10-06T11:55:00Z"},
            now=datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc),
            block="arrival",
        )
        self.assertEqual(point["liveTime"], "11:55")
        self.assertEqual(point["status"], "departed")

    def test_cancelled_stop_does_not_show_a_live_time(self):
        point = self.point({
            "isCancelled": True,
            "realtimeForecast": "2026-10-06T12:10:00",
        })
        self.assertIsNone(point["liveTime"])
        self.assertEqual(point["status"], "cancelled")
        self.assertEqual(point["expected"], "Cancelled")

    def test_arrival_at_curtailment_stop_is_kept_despite_cancelled_departure(self):
        point = normalize_calling_point({
            "location": {"description": "Banbury"},
            "temporalData": {
                "arrival": {
                    "scheduleAdvertised": "2026-10-06T18:55:00",
                    "realtimeActual": "2026-10-06T19:01:00",
                },
                "departure": {
                    "scheduleAdvertised": "2026-10-06T18:56:00",
                    "isCancelled": True,
                },
            },
        }, datetime(2026, 10, 6, 20, 0))
        self.assertEqual(point["station"], "Banbury")
        self.assertEqual(point["status"], "arrived")
        self.assertTrue(point["isTerminated"])
        self.assertEqual(point["time"], "18:55")
        self.assertEqual(point["liveTime"], "19:01")
        self.assertEqual(point["actual"], "19:01")
        self.assertEqual(point["expected"], "19:01")

    def test_cancelled_departure_without_recorded_arrival_is_not_reached(self):
        point = normalize_calling_point({
            "location": {"description": "Banbury"},
            "temporalData": {
                "arrival": {"realtimeForecast": "2026-10-06T19:01:00"},
                "departure": {"isCancelled": True},
            },
        }, datetime(2026, 10, 6, 20, 0))
        self.assertEqual(point["status"], "cancelled")
        self.assertFalse(point["isTerminated"])
        self.assertIsNone(point["liveTime"])


if __name__ == "__main__":
    unittest.main()
