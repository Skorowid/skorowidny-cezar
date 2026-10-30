"""Decimal calculations driven by explicit, versioned sample rules.

``decimal`` represents decimal inputs exactly and offers rounding modes, but
arithmetic runs in a context of ``PRECISION`` significant digits: a result
that does not fit (``2 / 3``, a 60-digit operand) is rounded there. The result
therefore says ``unrounded`` (before the rule's rounding), never "exact", and
``inexact`` plus a warning report that intermediate rounding. ``decimal`` does
not choose a business rounding rule. Every rule therefore names its own
``quantum`` and ``rounding`` -- there is no default. The rules shipped in
``fixtures/sample_rules.json`` are SAMPLES, not approved business rules.

Inputs must be ``str``, ``int`` or ``Decimal``; ``float`` and ``bool`` are
rejected because a binary float already lost the decimal value it meant.

@author Skorowid
"""

import decimal
import json
from decimal import Decimal

from .errors import InvalidInputError

ROUNDING_MODES = {
    name: getattr(decimal, name)
    for name in (
        "ROUND_CEILING",
        "ROUND_DOWN",
        "ROUND_FLOOR",
        "ROUND_HALF_DOWN",
        "ROUND_HALF_EVEN",
        "ROUND_HALF_UP",
        "ROUND_UP",
        "ROUND_05UP",
    )
}
OPERATIONS = ("sum", "percent_of")
PRECISION = 50  # sample choice, not an approved business precision
_RULE_KEYS = {"rule_id", "version", "operation", "quantum", "rounding", "description"}


def _to_decimal(name, value):
    if isinstance(value, bool) or isinstance(value, float):
        raise InvalidInputError(f"{name}: {type(value).__name__} is not accepted; pass str, int or Decimal")
    if isinstance(value, Decimal):
        number = value
    elif isinstance(value, int):
        number = Decimal(value)
    elif isinstance(value, str):
        try:
            number = Decimal(value.strip())
        except decimal.InvalidOperation:
            raise InvalidInputError(f"{name}: {value!r} is not a decimal number") from None
    else:
        raise InvalidInputError(f"{name}: unsupported type {type(value).__name__}")
    if not number.is_finite():
        raise InvalidInputError(f"{name}: {value!r} is not finite")
    return number


def validate_rule(rule):
    """Check one rule dict; return it unchanged or raise ``InvalidInputError``."""
    if not isinstance(rule, dict):
        raise InvalidInputError("rule must be an object")
    missing = _RULE_KEYS - {"description"} - rule.keys()
    unknown = rule.keys() - _RULE_KEYS
    if missing or unknown:
        raise InvalidInputError(f"rule keys: missing={sorted(missing)} unknown={sorted(unknown)}")
    if rule["operation"] not in OPERATIONS:
        raise InvalidInputError(f"rule {rule['rule_id']}: unknown operation {rule['operation']!r}")
    if rule["rounding"] not in ROUNDING_MODES:
        raise InvalidInputError(f"rule {rule['rule_id']}: unknown rounding {rule['rounding']!r}")
    if not isinstance(rule["quantum"], str):
        raise InvalidInputError(f"rule {rule['rule_id']}: quantum must be a string like '0.01'")
    quantum = _to_decimal("quantum", rule["quantum"])
    if quantum <= 0 or quantum.normalize().as_tuple().digits != (1,):
        raise InvalidInputError(f"rule {rule['rule_id']}: quantum must be a power of ten like '0.01'")
    if isinstance(rule["version"], bool) or not isinstance(rule["version"], int) or rule["version"] < 1:
        raise InvalidInputError(f"rule {rule['rule_id']}: version must be a positive int")
    return rule


def load_rules(path):
    """Load ``{"rules": [...]}`` from JSON into ``{rule_id: rule}``."""
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict) or not isinstance(data.get("rules"), list):
        raise InvalidInputError("rules file must be an object with a 'rules' list")
    rules = {}
    for rule in data["rules"]:
        validate_rule(rule)
        if rule["rule_id"] in rules:
            raise InvalidInputError(f"duplicate rule {rule['rule_id']}")
        rules[rule["rule_id"]] = rule
    return rules


def calculate(rules, rule_id, inputs):
    """Apply ``rules[rule_id]`` to ``inputs`` and return a JSON-safe result.

    * ``sum``: ``inputs = {"values": [...]}`` (at least one value).
    * ``percent_of``: ``inputs = {"part": x, "whole": y}``; ``whole`` != 0.

    The ``unrounded`` value (computed at ``PRECISION`` digits) is returned
    alongside the rounded one. ``inexact`` is true, with a warning, when that
    intermediate computation already lost digits; a second warning is added
    when the rule's rounding changed the value. A value the context cannot
    represent (overflow, more than ``PRECISION`` digits after quantizing)
    raises ``InvalidInputError``.
    """
    if not isinstance(rules, dict) or rule_id not in rules:
        raise InvalidInputError(f"unknown rule {rule_id!r}")
    rule = validate_rule(rules[rule_id])
    if not isinstance(inputs, dict):
        raise InvalidInputError("inputs must be an object")

    ctx = decimal.Context(prec=PRECISION, traps=[decimal.InvalidOperation, decimal.DivisionByZero, decimal.Overflow])
    try:
        return _compute(rule, inputs, ctx)
    except decimal.DecimalException as exc:
        raise InvalidInputError(f"rule {rule['rule_id']}: value not representable ({type(exc).__name__})") from None


def _compute(rule, inputs, ctx):
    if rule["operation"] == "sum":
        if set(inputs) != {"values"} or not isinstance(inputs["values"], list) or not inputs["values"]:
            raise InvalidInputError("sum expects {'values': [non-empty list]}")
        numbers = [_to_decimal(f"values[{i}]", v) for i, v in enumerate(inputs["values"])]
        unrounded = Decimal(0)
        for number in numbers:
            unrounded = ctx.add(unrounded, number)
        normalized_inputs = {"values": [str(n) for n in numbers]}
    else:
        if set(inputs) != {"part", "whole"}:
            raise InvalidInputError("percent_of expects {'part': x, 'whole': y}")
        part = _to_decimal("part", inputs["part"])
        whole = _to_decimal("whole", inputs["whole"])
        if whole == 0:
            raise InvalidInputError("whole must not be zero")
        unrounded = ctx.multiply(ctx.divide(part, whole), Decimal(100))
        normalized_inputs = {"part": str(part), "whole": str(whole)}

    inexact = bool(ctx.flags[decimal.Inexact])
    quantum = Decimal(rule["quantum"])
    rounded = unrounded.quantize(quantum, rounding=ROUNDING_MODES[rule["rounding"]], context=ctx)
    warnings = []
    if inexact:
        warnings.append(f"intermediate result rounded to {PRECISION} significant digits (precision loss)")
    if rounded != unrounded:
        warnings.append(f"rounded {unrounded} -> {rounded} using {rule['rounding']} to {rule['quantum']}")
    return {
        "rule_id": rule["rule_id"],
        "rule_version": rule["version"],
        "operation": rule["operation"],
        "inputs": normalized_inputs,
        "unrounded": str(unrounded),
        "inexact": inexact,
        "precision": PRECISION,
        "result": str(rounded),
        "quantum": rule["quantum"],
        "rounding": rule["rounding"],
        "warnings": warnings,
    }
