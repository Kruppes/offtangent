"""Pinned HA handlers + real IntentResponse.as_dict, with synthetic targets only."""
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from homeassistant.components.intent import (
    GetCurrentDateIntentHandler, GetCurrentTimeIntentHandler,
    GetStateIntentHandler, GetTemperatureIntent, RespondIntentHandler,
)
from homeassistant.components.intent.timers import TimerStatusIntentHandler
from homeassistant.components.weather.intent import GetWeatherIntent
from homeassistant.core import Context, State
from homeassistant.helpers import intent

from test_client import FakeClient, client, envelope, tool_reply


class ReadOnlyIntentTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_handlers_query_roundtrips_preserve_results_without_actions(self):
        hass = SimpleNamespace(services=SimpleNamespace(async_call=AsyncMock()))
        climate = State("climate.synthetic", "heat", {"current_temperature": 21.5})
        weather = State("weather.synthetic", "sunny", {"temperature": 18.0})
        timer = SimpleNamespace(id="synthetic-timer", name="Synthetic", device_id=None,
                                language="de", start_hours=0, start_minutes=2,
                                start_seconds=0, seconds_left=90, is_active=True)
        cases = [
            (GetStateIntentHandler(), intent.INTENT_GET_STATE, climate, "query_answer"),
            (GetTemperatureIntent(), intent.INTENT_GET_TEMPERATURE, climate, "query_answer"),
            (GetWeatherIntent(), "HassGetWeather", weather, "query_answer"),
            (TimerStatusIntentHandler(), intent.INTENT_TIMER_STATUS, None, "action_done"),
            (GetCurrentTimeIntentHandler(), intent.INTENT_GET_CURRENT_TIME, None, "action_done"),
            (GetCurrentDateIntentHandler(), intent.INTENT_GET_CURRENT_DATE, None, "action_done"),
            (RespondIntentHandler(), intent.INTENT_RESPOND, None, "action_done"),
        ]
        for handler, name, target, response_type in cases:
            with self.subTest(name=name):
                self.assertEqual(handler.intent_type, name)
                obj = intent.Intent(hass, "conversation", name,
                                    {"name": {"value": "Synthetic"}} if target else {},
                                    "Synthetic query", Context(), "de")
                with patch("homeassistant.helpers.intent.async_match_targets", return_value=SimpleNamespace(is_match=True, states=[target], areas=[], floors=[])), patch("homeassistant.components.intent.timers._find_timers", return_value=[timer]):
                    result = (await handler.async_handle(obj)).as_dict()
                self.assertEqual(result["response_type"], response_type)
                self.assertEqual(result["data"]["failed"], [])
                tool_name = "homeassistant__" + name
                self.assertFalse(client.is_mutating(tool_name))
                self.assertTrue(client.confirmed_result(tool_name, result))
                tool = {"type": "function", "function": {"name": tool_name, "description": "Synthetic", "parameters": {"type": "object"}}}
                call = {"id": "synthetic-call", "type": "function", "function": {"name": tool_name, "arguments": "{}"}}
                adapter = FakeClient([envelope(tool_reply([call])), envelope({"role": "assistant", "content": "Synthetic answer"})])
                dispatch = AsyncMock(return_value=result)
                outcome = await client.run_turn(adapter, "Read only", "Synthetic query", [tool], lambda n, a: a, dispatch)
                self.assertFalse(outcome.failed)
                self.assertEqual(outcome.text, "Synthetic answer")
                self.assertEqual(len(adapter.requests), 2)
                dispatch.assert_awaited_once()
                # Includes actual date/time, timer speech slots and entity states.
                returned = json.loads(adapter.requests[1]["messages"][3]["content"])
                self.assertEqual(returned, json.loads(client.json_result(result)))
                for bad in [{**result, "error": "synthetic"}, {**result, "data": {**result["data"], "failed": [{"id": "synthetic"}]}}, {**result, "response_type": "error"}]:
                    self.assertFalse(client.confirmed_result(tool_name, bad))
        hass.services.async_call.assert_not_awaited()

    def test_phantom_unknown_and_real_mutations_remain_action_like(self):
        for name in ["HassGetTemperature", "HassClimateSetTemperature", intent.INTENT_START_TIMER, intent.INTENT_CANCEL_TIMER, intent.INTENT_CANCEL_ALL_TIMERS, intent.INTENT_INCREASE_TIMER, intent.INTENT_DECREASE_TIMER, intent.INTENT_PAUSE_TIMER, intent.INTENT_UNPAUSE_TIMER, intent.INTENT_TURN_OFF, "HassFutureTool"]:
            with self.subTest(name=name):
                self.assertTrue(client.is_mutating("homeassistant__" + name))
                query = intent.IntentResponse(language="de")
                query.response_type = intent.IntentResponseType.QUERY_ANSWER
                self.assertFalse(client.confirmed_result(name, query.as_dict()))
