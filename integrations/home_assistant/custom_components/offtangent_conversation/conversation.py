"""HA 2026.9 ChatLog agent; executes only selected Assist tools, never services directly."""
import asyncio
import json

from probatio import to_openapi
import voluptuous as vol
from homeassistant.components import conversation
from homeassistant.core import HomeAssistantError
from homeassistant.helpers import intent, llm

from .client import AdapterError, TOOL_NAME, decode_json, run_turn
from .const import DEFAULT_PROMPT, DOMAIN


def _error_result(user_input, conversation_id, text):
    response = intent.IntentResponse(language=user_input.language)
    response.async_set_error(intent.IntentResponseErrorCode.FAILED_TO_HANDLE, text)
    return conversation.ConversationResult(response=response, conversation_id=conversation_id)


async def async_setup_entry(hass, entry, async_add_entities):
    async_add_entities([OfftangentConversationEntity(entry)])


class OfftangentConversationEntity(conversation.ConversationEntity, conversation.AbstractConversationAgent):
    _attr_has_entity_name = True
    _attr_name = "Offtangent Conversation"
    _attr_supports_streaming = False

    def __init__(self, entry):
        self.entry = entry
        self._settings = {**entry.data, **entry.options}
        self._client = entry.runtime_data
        self._lock = asyncio.Lock()
        self._attr_unique_id = entry.entry_id
        if self._settings.get("control"):
            self._attr_supported_features = conversation.ConversationEntityFeature.CONTROL

    @property
    def supported_languages(self):
        return ["de", "de-DE"]

    async def async_added_to_hass(self):
        await super().async_added_to_hass()
        conversation.async_set_agent(self.hass, self.entry, self)

    async def async_will_remove_from_hass(self):
        conversation.async_unset_agent(self.hass, self.entry)
        await super().async_will_remove_from_hass()

    async def _async_handle_message(self, user_input, chat_log):
        if self._lock.locked():
            return _error_result(user_input, chat_log.conversation_id,
                                 "Dieser Assistent bearbeitet noch eine Anfrage.")
        async with self._lock:
            try:
                async with asyncio.timeout(110):
                    return await self._async_run(user_input, chat_log)
            except TimeoutError:
                return _error_result(user_input, chat_log.conversation_id,
                                     "Zeitlimit erreicht. Ein Aktionserfolg ist nicht bestätigt.")

    async def _async_run(self, user_input, chat_log):
        try:
            # A reused chat ID must not import another agent/pipeline extra prompt.
            chat_log.extra_system_prompt = None
            await chat_log.async_provide_llm_data(
                user_input.as_llm_context(DOMAIN),
                llm.LLM_API_ASSIST if self._settings.get("control") else None,
                DEFAULT_PROMPT, None,  # Do not import other pipeline/agent prompts.
            )
            api = chat_log.llm_api
            allowed = set(json.loads(self._settings["allowed_tools"]))
            selected = {
                tool.name: tool for tool in (api.tools if api else [])
                if tool.name in allowed and TOOL_NAME.fullmatch(tool.name)
            }
            tools = [{"type": "function", "function": {
                "name": tool.name, "description": tool.description or "Home Assistant Assist tool",
                "parameters": to_openapi(tool.parameters, custom_serializer=api.custom_serializer),
            }} for tool in selected.values()]
            prompt = chat_log.content[0].content

            def validate_args(name, args):
                # Validate entire batch before execution; reject unknown tools and invalid slots.
                if name not in selected:
                    raise AdapterError("unsupported_tool")
                return selected[name].parameters(args)

            async def dispatch(call_id, name, args):
                if api is None or name not in selected:
                    raise AdapterError("unsupported_tool")
                return await api.async_call_tool(llm.ToolInput(
                    id=call_id, tool_name=name, tool_args=args,
                ))

            outcome = await run_turn(self._client, prompt, user_input.text, tools, validate_args, dispatch)
            # Tool calls are already executed here. External=True prevents ChatLog re-execution.
            tool_names = {}
            for message in outcome.messages[2:]:
                if message["role"] == "assistant":
                    calls = []
                    for call in message.get("tool_calls", []):
                        func = call["function"]
                        tool_names[call["id"]] = func["name"]
                        calls.append(llm.ToolInput(id=call["id"], tool_name=func["name"],
                                                   tool_args=decode_json(func["arguments"]), external=True))
                    chat_log.async_add_assistant_content_without_tools(conversation.AssistantContent(
                        agent_id=self.entity_id, content=None if calls else message.get("content"), tool_calls=calls or None,
                    ))
                else:
                    chat_log.async_add_assistant_content_without_tools(conversation.ToolResultContent(
                        agent_id=self.entity_id, tool_call_id=message["tool_call_id"],
                        tool_name=tool_names[message["tool_call_id"]],
                        tool_result=decode_json(message["content"]),
                    ))
            return conversation.async_get_result_from_chat_log(user_input, chat_log)
        except conversation.ConverseError as err:
            return err.as_conversation_result()
        except (AdapterError, HomeAssistantError, vol.Invalid, ValueError, TypeError):
            # Do not expose upstream bodies, tokens, hostnames, thinking or tool arguments.
            return _error_result(user_input, chat_log.conversation_id,
                                 "Der Assistent ist derzeit nicht verfügbar. Ein Aktionserfolg ist nicht bestätigt.")
