"""Kannada / bilingual MO entity extraction (lexicon + regex; no heavy model deps)."""

from __future__ import annotations

import re
from typing import Any


# Operational lexicons — Kannada + common bilingual police phrasing
ALIAS_PATTERNS = [
    r"ಕುಖ್ಯಾತ\s+ರೌಡಿ[^\s,।]*",
    r"ಸ್ಟಾಕರ್[^\s,।]*",
    r"ರೌಡಿ\s+[A-Za-z\u0C80-\u0CFF]+",
    r"alias[:\s]+([A-Za-z\u0C80-\u0CFF0-9.\- ]{2,40})",
    r"aka[:\s]+([A-Za-z0-9.\- ]{2,40})",
]

VEHICLE_PATTERNS = [
    r"\bKA[-\s]?\d{1,2}[-\s]?[A-Z]{1,3}[-\s]?\d{1,4}\b",
    r"ಕಪ್ಪು\s+ಬಣ್ಣದ\s+\w+",
    r"(?:ಪಲ್ಸರ್|ಆಕ್ಟಿವ|ಸ್ಕೂಟರ್|ಕಾರು|ಬೈಕ್|ಟಾಟಾ|ಸ್ವಿಫ್ಟ್|ಎರ್ಟಿಗಾ)",
    r"(?:black|white|red)\s+(?:pulsar|activa|scooter|car|bike)",
]

WEAPON_PATTERNS = [
    r"ಲಾಂಗ್",
    r"ಮಾರಕಾಸ್ತ್ರ",
    r"ಕಬ್ಬಿಣದ\s*ರಾಡ್",
    r"ಚಾಕು",
    r"ಕತ್ತಿ",
    r"ರಿವಾಲ್ವರ್",
    r"(?:knife|iron\s*rod|pistol|gun|rod|blade)",
]

MO_METHOD_PATTERNS = [
    r"ಮನೆಯ\s+ಬೀಗ\s+ಒಡೆದು",
    r"ಸರಗಳ್ಳತನ",
    r"ಒಂಟಿ\s+ಮಹಿಳೆಯರನ್ನು\s+ಗುರಿಮಾಡಿ",
    r"ಸರ\s*ಕದಿಯುವ",
    r"chain[\s-]?snatch(?:ing)?",
    r"house\s*break(?:ing)?",
    r"snatching",
    r"lock\s*break",
    r"two[\s-]?wheeler\s+theft",
]

MO_TAG_NORMALIZE = {
    "ಸರಗಳ್ಳತನ": "chain_snatching",
    "chain snatching": "chain_snatching",
    "chain-snatching": "chain_snatching",
    "ಮನೆಯ ಬೀಗ ಒಡೆದು": "house_break",
    "house breaking": "house_break",
    "ಒಂಟಿ ಮಹಿಳೆಯರನ್ನು ಗುರಿಮಾಡಿ": "target_lone_women",
    "ಕಬ್ಬಿಣದ ರಾಡ್": "iron_rod",
    "ಲಾಂಗ್": "long_knife",
    "ಮಾರಕಾಸ್ತ್ರ": "deadly_weapon",
}


def _find_all(patterns: list[str], text: str) -> list[str]:
    out: list[str] = []
    for pat in patterns:
        for m in re.finditer(pat, text, flags=re.IGNORECASE):
            val = m.group(1).strip() if m.lastindex else m.group(0).strip()
            if val and val not in out:
                out.append(val)
    return out


def extract_mo_entities(narrative: str, mo_fields: dict[str, str] | None = None) -> dict[str, Any]:
    """Parse Kannada/English narrative into structured MO metadata."""
    text = (narrative or "").strip()
    fields = mo_fields or {}
    # Blend structured Catalyst MO columns when narrative is thin
    blended = " ".join(
        [
            text,
            fields.get("mo_entry", ""),
            fields.get("mo_target", ""),
            fields.get("mo_tools", ""),
            fields.get("mo_timing", ""),
        ]
    ).strip()

    aliases = _find_all(ALIAS_PATTERNS, blended)
    vehicles = _find_all(VEHICLE_PATTERNS, blended)
    weapons = _find_all(WEAPON_PATTERNS, blended)
    methods = _find_all(MO_METHOD_PATTERNS, blended)

    # Fall back to Catalyst structured MO if Kannada extract empty
    if not methods and fields.get("mo_entry"):
        methods.append(fields["mo_entry"])
    if not weapons and fields.get("mo_tools"):
        weapons.append(fields["mo_tools"])
    if not aliases and fields.get("mo_target"):
        # target type is not alias but useful tag
        pass

    tags: list[str] = []
    for item in methods + weapons + vehicles:
        key = MO_TAG_NORMALIZE.get(item.lower(), MO_TAG_NORMALIZE.get(item, item.lower().replace(" ", "_")))
        if key not in tags:
            tags.append(key)
    for k in ("mo_entry", "mo_target", "mo_tools", "mo_timing"):
        v = (fields.get(k) or "").strip()
        if v:
            t = v.lower().replace(" ", "_")
            if t not in tags:
                tags.append(t)

    return {
        "suspect_aliases": aliases,
        "vehicles": vehicles,
        "weapons": weapons,
        "mo_methods": methods,
        "mo_tags": tags,
        "source_narrative_chars": len(text),
        "used_catalyst_mo_fields": bool(fields),
    }
