"""Deterministic target guard for the LOCAL (Ollama) path; no HA imports, fail-closed.

The guard sees every action batch of the local model BEFORE dispatch and checks the targets HA
would hit (preview via the resolver) against what the utterance asks for:

  (a) the utterance names areas/floors -> every target must lie in one of them;
  (b) "außer X" -> X (area, floor or name word) is never a target;
  (c) the utterance names a place that is no known area/floor -> clarify, never act;
  (d) more than MAX_DEVICES targets in this turn (unless all lie in the ONE area the utterance
      names), or more than one entity domain -> explicit user confirmation ("ja") first;
  (e) conditional utterances ("wenn es regnet ...") -> act only if the condition is verified
      deterministically (rain: weather entity state), otherwise nothing runs;
  (f) a target set HA cannot preview (resolver missing/error) -> nothing runs.

Violations of (a)/(b) are fed back once to the model as tool errors (nothing ran); a second
violation ends the turn with a fixed text. The relay path never uses the guard.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Callable, Iterable

MAX_DEVICES = 3  # more targets per turn -> confirmation required
CONFIRM_TTL_S = 60  # a pending confirmation expires after this many seconds

NON_ENTITY_TOOLS = {
    "HassListAddItem", "HassListCompleteItem", "HassShoppingListAddItem", "HassStartTimer",
    "HassCancelTimer", "HassCancelAllTimers", "HassIncreaseTimer", "HassDecreaseTimer",
    "HassPauseTimer", "HassUnpauseTimer", "HassTimerStatus", "HassBroadcast", "HassRespond",
    "HassNevermind", "GetDateTime", "get_items", "get_events",
}
TARGET_KEYS = ("name", "area", "floor", "domain", "device_class")
RAIN_STATES = {"rainy", "pouring", "lightning-rainy", "snowy-rainy", "hail"}

COND_RE = re.compile(r"\b(wenn|falls|sofern|sobald|solange)\b", re.I)
RAIN_RE = re.compile(r"\b(regn\w*|regen\w*|niesel\w*|schauer)\b", re.I)
EXCEPT_RE = re.compile(
    r"\b(?:au(?:ß|ss)er|ausgenommen|bis auf|ohne)\s+(?:(?:in|im|am|auf|beim)\s+)?(?:(?:der|dem|den|die|das)\s+)?"
    r"([\wäöüÄÖÜß-]+(?:\s+(?:und|oder)\s+(?:(?:in|im)\s+)?(?:(?:der|dem|den|die|das)\s+)?[\wäöüÄÖÜß-]+)*)",
    re.I)
PLACE_RE = re.compile(
    r"\b(?:im|in\s+der|in\s+dem|in\s+den|in|auf\s+der|auf\s+dem|am|beim|vom|von\s+der)\s+"
    r"(?:(?:ganzen|ganze|kleinen|großen|oberen|unteren)\s+)?([A-ZÄÖÜ][\wäöüß-]+)")
CONFIRM_YES_RE = re.compile(r"^\s*(ja|jawohl|jo|genau|bitte|ja bitte|okay|ok|mach(?: das| es)?|mach das bitte|"
                            r"ja,? mach(?: das| es)?(?: bitte)?|bestätigt|tu das|richtig)\s*[.!]?\s*$", re.I)


def norm(text) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().casefold()


def is_confirmation(text: str) -> bool:
    return bool(CONFIRM_YES_RE.match(text or ""))


@dataclass
class Target:
    entity_id: str
    domain: str
    area: str | None = None
    floor: str | None = None
    name: str = ""
    aliases: tuple[str, ...] = ()  # further names HA matches for this entity (registry aliases)


@dataclass
class World:
    """Known places: area -> floor, plus aliases (all names as shown to users)."""
    areas: dict[str, str | None] = field(default_factory=dict)  # area name -> floor name
    area_aliases: dict[str, str] = field(default_factory=dict)  # alias -> area name
    floors: set[str] = field(default_factory=set)
    floor_aliases: dict[str, str] = field(default_factory=dict)  # alias -> floor name
    words: set[str] = field(default_factory=set)  # casefolded words of exposed entity names

    def place(self, word: str):
        """('area'|'floor', canonical name) for a word of the utterance, else None."""
        w = norm(word)
        if not w:
            return None
        for kind, names, aliases in (("area", self.areas, self.area_aliases),
                                     ("floor", self.floors, self.floor_aliases)):
            for n in names:
                if norm(n) == w:
                    return kind, n
            for a, n in aliases.items():
                if norm(a) == w:
                    return kind, n
        # Compound words / inflections: "Küche" vs "Küchen", "Wohnzimmers".
        for kind, names, aliases in (("area", self.areas, self.area_aliases),
                                     ("floor", self.floors, self.floor_aliases)):
            for n in list(names) + list(aliases):
                nn = norm(n)
                if len(nn) >= 4 and (w.startswith(nn) or nn.startswith(w)) and abs(len(w) - len(nn)) <= 2:
                    return kind, (aliases.get(n, n) if n in aliases else n)
        return None


@dataclass
class Analysis:
    areas: set[str] = field(default_factory=set)
    floors: set[str] = field(default_factory=set)
    except_areas: set[str] = field(default_factory=set)
    except_floors: set[str] = field(default_factory=set)
    except_words: set[str] = field(default_factory=set)
    unknown_places: list[str] = field(default_factory=list)
    conditional: str | None = None  # None | "rain" | "other"


def analyze(text: str, world: World) -> Analysis:
    out = Analysis()
    if COND_RE.search(text or ""):
        out.conditional = "rain" if RAIN_RE.search(text) else "other"
    spans = []
    for m in EXCEPT_RE.finditer(text or ""):
        spans.append(m.span())
        for part in re.split(r"\s+(?:und|oder)\s+", m.group(1)):
            part = re.sub(r"^(?:(?:in|im)\s+)?(?:(?:der|dem|den|die|das)\s+)?", "", part.strip(), flags=re.I)
            hit = world.place(part)
            if hit and hit[0] == "area":
                out.except_areas.add(hit[1])
            elif hit:
                out.except_floors.add(hit[1])
            elif part:
                out.except_words.add(norm(part))
    for m in PLACE_RE.finditer(text or ""):
        if any(a <= m.start(1) < b for a, b in spans):
            continue
        word = m.group(1)
        hit = world.place(word)
        if hit and hit[0] == "area":
            out.areas.add(hit[1])
        elif hit:
            out.floors.add(hit[1])
        elif norm(word) not in world.words and not _is_entity_word(norm(word), world.words):
            out.unknown_places.append(word)
    return out


def _is_entity_word(word: str, words: set[str]) -> bool:
    return any(len(w) >= 4 and (w.startswith(word) or word.startswith(w)) and abs(len(w) - len(word)) <= 2
               for w in words)


@dataclass
class Decision:
    action: str  # "feedback" | "clarify" | "confirm" | "block"
    reason: str
    text: str
    targets: list[str] = field(default_factory=list)


def base(name: str) -> str:
    return name.split("__")[-1]


def entity_targeting(name: str, args: dict) -> bool:
    return base(name) not in NON_ENTITY_TOOLS and any(args.get(k) not in (None, "", []) for k in TARGET_KEYS)


def _names(targets: Iterable[Target], limit=6) -> str:
    names = list(dict.fromkeys(t.name or t.entity_id for t in targets))  # spoken once per name
    text = ", ".join(names[:limit])
    return text + (f" und {len(names) - limit} weitere" if len(names) > limit else "")


class Guard:
    """One instance per local turn; check() is called once per action batch before dispatch."""

    def __init__(self, text: str, world: World | None, resolve: Callable | None,
                 weather: Callable | None = None, max_devices: int | None = None):
        self.text = text or ""
        self.world = world
        self.resolve = resolve
        self.weather = weather
        self.max_devices = MAX_DEVICES if max_devices is None else max_devices
        self.analysis = analyze(self.text, world) if world is not None else None
        self.feedback_used = False
        self.no_match_feedback_used = False  # one correction round for a name/area that matched nothing
        self.arg_feedback_used = False  # invalid tool arguments were fed back once (client.run_turn)
        self.pending: list | None = None  # batch awaiting the user's "ja" (decision "confirm")
        self.seen: dict[str, Target] = {}  # targets already dispatched this turn
        self.events: list[dict] = []  # turn-log trail (guard_blocked etc.)

    def _record(self, decision: Decision | None, batch):
        if decision is not None:
            self.events.append({"guard_blocked": decision.action, "reason": decision.reason,
                                "targets": decision.targets[:20],
                                "calls": [[n, a] for n, a in batch][:10]})
        return decision

    def check(self, batch: list[tuple[str, dict]], mutating: Callable[[str], bool]) -> Decision | None:
        acts = [(n, a) for n, a in batch if mutating(n)]
        if not acts:
            return None
        return self._record(self._check(acts), acts)

    def _check(self, acts) -> Decision | None:
        if self.world is None or self.analysis is None:
            return Decision("block", "guard_world_unavailable",
                            "Ich konnte die Ziele nicht sicher prüfen und habe nichts geschaltet.")
        an = self.analysis
        if an.conditional:
            verdict = self._condition()
            if verdict is not True:
                return verdict
        targets: dict[str, Target] = {}
        for name, args in acts:
            if not entity_targeting(name, args):
                continue
            if an.unknown_places:
                place = an.unknown_places[0]
                return Decision("clarify", "unknown_area:" + place,
                                f"Einen Bereich „{place}“ kenne ich nicht. Welchen Raum meinst du?")
            if self.resolve is None:
                return Decision("block", "resolver_unavailable",
                                "Ich konnte die Ziele nicht sicher prüfen und habe nichts geschaltet.")
            try:
                found = self.resolve(name, args)
            except Exception:  # noqa: BLE001 - preview failed: fail closed
                found = None
            if found is None:
                return Decision("block", "resolver_error",
                                "Ich konnte die Ziele nicht sicher prüfen und habe nichts geschaltet.")
            if not found:
                if not self.no_match_feedback_used:
                    # Nothing ran. Like HA's own "no match" tool error, the model gets one chance to
                    # look up the exact name (GetLiveContext) instead of the turn ending in a question.
                    self.no_match_feedback_used = True
                    hint = self._candidates(name, args)
                    return Decision("feedback", "no_match",
                                    "GUARD: Nicht ausgeführt. Kein Gerät passt genau zu "
                                    + json.dumps({k: args.get(k) for k in TARGET_KEYS if args.get(k)}, ensure_ascii=False)
                                    + ". Nichts wurde geschaltet. " + hint
                                    + "Nutze den exakten Gerätenamen aus der Geräteliste, "
                                    "oder lass name weg und nutze area plus domain, wenn alle Geräte "
                                    "des Bereichs gemeint sind. Sonst frage nach.")
                return Decision("clarify", "no_match",
                                "Dafür habe ich kein passendes Gerät gefunden und nichts geschaltet. Welches Gerät meinst du?")
            for t in found:
                targets[t.entity_id] = t
        if not targets:
            return None
        bad = self._scope_violations(targets.values())
        if bad:
            reason, offenders = bad
            names = _names(offenders)
            if not self.feedback_used:
                self.feedback_used = True
                return Decision("feedback", reason, self._feedback_text(reason, names),
                                [t.entity_id for t in offenders])
            return Decision("clarify", reason,
                            f"Ich bin nicht sicher, welche Geräte gemeint sind ({names} gehören nicht dazu). "
                            "Ich habe nichts geschaltet. Sag mir bitte die Räume einzeln.",
                            [t.entity_id for t in offenders])
        total = {**self.seen, **targets}
        domains = {t.domain for t in total.values()}
        areas = {t.area for t in total.values()}
        # Many devices of ONE domain inside ONE named area is exactly what "Licht im Büro" asks
        # for; across areas, without area, or house/floor-wide it needs the user's "ja".
        one_named_area = len(areas) == 1 and None not in areas and areas <= self.analysis.areas
        if (len(total) > self.max_devices and not one_named_area) or len(domains) > 1:
            why = "multi_domain" if len(domains) > 1 else "multi_device"
            return Decision("confirm", why, f"Das betrifft {len(targets)} Geräte: {_names(targets.values())}. "
                            "Soll ich das machen?", list(targets))
        self.seen.update(targets)
        return None

    def _candidates(self, tool: str, args: dict) -> str:
        """Hint only (nothing is dispatched): the exact names HA knows in the same area/floor and
        domain, when that set is small. The corrected call goes through the full check again."""
        rest = {k: v for k, v in args.items() if k != "name"}
        if not args.get("name") or not (rest.get("area") or rest.get("floor")):
            return ""
        try:
            found = self.resolve(tool, rest) or []
        except Exception:  # noqa: BLE001 - hint is optional
            return ""
        items = []
        for t in found:
            names = list(dict.fromkeys([t.name or t.entity_id, *t.aliases]))
            item = names[0] + (f" (auch: {', '.join(names[1:])})" if len(names) > 1 else "")
            if item not in items:
                items.append(item)
        if not items or len(items) > 4:
            return ""
        where = rest.get("area") or rest.get("floor")
        return f"Exakte Namen in {where}: " + "; ".join(items) + ". "

    def accept(self, targets: Iterable[Target]):
        for t in targets:
            self.seen[t.entity_id] = t

    def _feedback_text(self, reason: str, names: str) -> str:
        an = self.analysis
        if reason == "exception_target":
            excl = ", ".join(sorted(an.except_areas | an.except_floors | an.except_words))
            return (f"GUARD: Nicht ausgeführt. {names} liegt in einem ausgenommenen Bereich ({excl}). "
                    "Nichts wurde geschaltet. Rufe die Aktion für jeden gewünschten Bereich einzeln mit area auf "
                    "und lasse die Ausnahme weg.")
        scope = ", ".join(sorted(an.areas | an.floors))
        return (f"GUARD: Nicht ausgeführt. {names} liegt nicht in {scope}. Nichts wurde geschaltet. "
                "Wähle nur Geräte aus dem genannten Bereich oder frage nach.")

    def _scope_violations(self, targets):
        an, w = self.analysis, self.world
        excl = []
        for t in targets:
            words = set(re.findall(r"[\wäöüß]+", norm(t.name) + " " + norm(t.entity_id.split(".", 1)[-1])))
            if (t.area in an.except_areas or t.floor in an.except_floors
                    or (t.area and w.areas.get(t.area) in an.except_floors)
                    or any(_is_entity_word(x, words) or x in words for x in an.except_words)):
                excl.append(t)
        if excl:
            return "exception_target", excl
        if an.areas or an.floors:
            out = [t for t in targets
                   if not (t.area in an.areas or t.floor in an.floors
                           or (t.area is not None and w.areas.get(t.area) in an.floors))]
            if out:
                return "out_of_scope", out
        return None

    def _condition(self):
        if self.analysis.conditional == "rain" and self.weather is not None:
            try:
                states = list(self.weather())
            except Exception:  # noqa: BLE001
                states = []
            if states:
                if any(s in RAIN_STATES for _, s in states):
                    return True
                shown = ", ".join(f"{n}: {s}" for n, s in states[:2])
                return Decision("block", "condition_not_met",
                                f"Laut Home Assistant regnet es gerade nicht ({shown}). Ich habe nichts geändert.")
        return Decision("block", "condition_unverified",
                        "Diese Bedingung kann ich nicht sicher prüfen. Ich habe nichts geändert.")
