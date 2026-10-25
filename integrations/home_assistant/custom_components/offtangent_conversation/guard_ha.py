"""HA side of the local-path target guard: places (areas/floors/aliases), a target preview with
HA's own matcher, and the weather state. Every function fails closed (None/empty -> guard blocks)."""
from __future__ import annotations

import re

from homeassistant.components import conversation
from homeassistant.helpers import intent

from .guard import Target, World

# Only where HA's own handler restricts the matched domains; everything else counts in full
# (over-counting only asks once more, under-counting could let a wide batch through).
TOOL_DOMAINS = {"HassLightSet": {"light"}}


def _exposed(hass, entity_id) -> bool:
    from homeassistant.components.homeassistant import exposed_entities
    return exposed_entities.async_should_expose(hass, conversation.DOMAIN, entity_id) is True


def _area_of(hass, entity_id):
    from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er
    entry = er.async_get(hass).async_get(entity_id)
    if entry is None:
        return None
    area_id = entry.area_id
    if area_id is None and entry.device_id and (device := dr.async_get(hass).async_get(entry.device_id)):
        area_id = device.area_id
    return ar.async_get(hass).async_get_area(area_id) if area_id else None


def build_world(hass) -> World | None:
    try:
        from homeassistant.helpers import area_registry as ar, floor_registry as fr
        floors = {f.floor_id: f for f in fr.async_get(hass).async_list_floors()}
        world = World()
        for floor in floors.values():
            world.floors.add(floor.name)
            for alias in floor.aliases or ():
                world.floor_aliases[alias] = floor.name
        for area in ar.async_get(hass).async_list_areas():
            world.areas[area.name] = floors[area.floor_id].name if area.floor_id in floors else None
            for alias in area.aliases or ():
                world.area_aliases[alias] = area.name
        for state in hass.states.async_all():
            if _exposed(hass, state.entity_id):
                name = state.attributes.get("friendly_name") or state.entity_id
                world.words.update(w for w in re.findall(r"[\wäöüß]+", str(name).casefold()) if len(w) >= 3)
        return world
    except Exception:  # noqa: BLE001 - registry API missing/changed: guard blocks every action
        return None


def make_resolver(hass):
    """resolve(tool, args) -> [Target] HA would hit (exposed only), [] for no match, raises on error."""
    from homeassistant.helpers import floor_registry as fr
    from homeassistant.helpers import entity_registry as er
    floor_names = {f.floor_id: f.name for f in fr.async_get(hass).async_list_floors()}
    ent_reg = er.async_get(hass)

    def resolve(name, args):
        base = name.split("__")[-1]
        domains = args.get("domain")
        domains = [domains] if isinstance(domains, str) else list(domains or [])
        classes = args.get("device_class")
        classes = [classes] if isinstance(classes, str) else list(classes or [])
        constraints = intent.MatchTargetsConstraints(
            name=args.get("name") or None, area_name=args.get("area") or None,
            floor_name=args.get("floor") or None, domains=domains or None,
            device_classes=classes or None, assistant=conversation.DOMAIN, allow_duplicate_names=True)
        result = intent.async_match_targets(hass, constraints)
        if not result.is_match:
            return []
        allowed = TOOL_DOMAINS.get(base)
        out = []
        for state in result.states:
            domain = state.domain
            if allowed and domain not in allowed:
                continue
            area = _area_of(hass, state.entity_id)
            entry = ent_reg.async_get(state.entity_id)
            aliases = tuple(sorted(a for a in (entry.aliases if entry else ()) if isinstance(a, str)))
            out.append(Target(state.entity_id, domain, area.name if area else None,
                              floor_names.get(area.floor_id) if area else None,
                              str(state.attributes.get("friendly_name") or state.entity_id), aliases))
        return out

    return resolve


def make_weather(hass):
    def weather():
        return [(s.attributes.get("friendly_name") or s.entity_id, s.state)
                for s in hass.states.async_all("weather") if _exposed(hass, s.entity_id)]
    return weather
