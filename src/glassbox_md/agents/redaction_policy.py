"""What the Privacy agent keeps, generalises or removes from date-like text,
and the clinical phrases its recognizers used to mistake for PII.

Why this exists. Presidio's DATE_TIME entity (spaCy's DATE and TIME labels)
fires on ages ("52 year old"), durations ("three months"), dosing
frequencies ("twice daily") and relative words ("last week") as readily as on
calendar dates, and the anonymizer then rewrote every one of them to the same
`<DATE_TIME>` token. HIPAA Safe Harbor (45 CFR 164.514(b)(2)(i)(C)) asks for
far less: remove the elements of *dates* (except the year) that relate to an
individual, and aggregate ages over 89 into "90 or older". A history that
reads "<DATE_TIME> with <DATE_TIME> of increased thirst" has lost what a
clinician (or a model) reasons from, and a powered rerun measured it: on 32
synthetic cases the same local model scored 20-22 correct with redaction on
and 24-27 with it off, every unredacted repeat above every redacted one (see
docs/text-eval-redaction-powered-rerun.md).

The policy, applied to Presidio's results before anonymizing:

- Ages 18-89 written as "N year old", "N y/o", "aged N", "Age: N", "N years
  of age" (digits or number words) become a decade band ("52 year old" ->
  "50-59 year old"). 90 and over become "90+", which is the aggregate Safe
  Harbor permits, in every one of those forms and in "in his 90s". Ages under
  18 are kept as written: they are not an identifier, and a 2-year-old and a
  9-year-old are clinically different patients.
- Durations ("three months", "for 10 years", "two years ago"), frequencies
  ("twice daily", "every 6 hours"), trial-style indexes ("week 12") and
  anchor-free relative words ("yesterday", "last week") are kept. A duration
  of 90 years or more reads as an age and is generalised to "90+ years".
- Everything else Presidio calls a date or time is still removed, now typed:
  `<DATE>` for calendar dates, months, years, weekdays and anything it cannot
  classify, `<TIME>` for clock times. This is an allow-list: a span is kept
  only if it positively matches one of the patterns above, so an unfamiliar
  form of date is redacted, not passed through.
- A blood pressure such as "168/102" is not a phone number, and "ST segment",
  "Achilles tendon" and "Hashimoto thyroiditis" are not a place or a person.
  A name is only let through when it is immediately followed by a disease or
  anatomy word ("Graves disease", "Achilles tendon") and is not preceded by a
  title ("Dr.", "Mr.", "Patient:"), so "Dr. Graves" is still redacted.

What this does not do: catch every way to write an age (a bare "93M", or
"nonagenarian"), or a bare number after "at" ("heart attack at 54", which
stays redacted as `<DATE>` because "at 10" could as easily be a time).
Those are stated in the Privacy agent's docstring, not hidden.

Pure functions, no Presidio state, so each rule is tested on its own.
"""

from __future__ import annotations

import re

from presidio_analyzer import RecognizerResult

# --- numbers ------------------------------------------------------------------

_ONES = {
    w: i
    for i, w in enumerate(
        "zero one two three four five six seven eight nine ten eleven twelve thirteen "
        "fourteen fifteen sixteen seventeen eighteen nineteen".split()
    )
}
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}

_NUMWORD = (
    r"(?:(?:one|a)\s+hundred(?:\s+and\s+[a-z]+(?:[\s-][a-z]+)?)?"
    r"|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?"
    r"|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen"
    r"|sixteen|seventeen|eighteen|nineteen)"
)
_QTY = rf"(?:\d{{1,3}}(?:\.\d+)?|{_NUMWORD})"
# Letters may follow directly ("101yo"); a digit or letter may not precede.
_QTY_RE = re.compile(rf"(?<![A-Za-z0-9]){_QTY}(?![0-9])", re.IGNORECASE)


def parse_quantity(text: str) -> int | None:
    """Whole-number value of "52", "fifty-two" or "one hundred and two"; None if unparseable."""
    s = text.lower().strip()
    if re.fullmatch(r"\d{1,3}(?:\.\d+)?", s):
        return int(float(s))
    if "hundred" in s:
        return 100
    total = 0
    for part in re.split(r"[\s-]+", s):
        if part in _TENS:
            total += _TENS[part]
        elif part in _ONES:
            total += _ONES[part]
        else:
            return None
    return total


# --- ages ----------------------------------------------------------------------

_AGE_PATTERNS = [
    # "52 year old", "52-year-old", "fifty-two years old", "52 yr. old"
    re.compile(rf"\b(?P<n>{_QTY})[\s-]*(?:years?|yrs?)[\s.-]*old\b", re.IGNORECASE),
    # "52 y/o", "52yo", "52 y.o.", "52yom"
    re.compile(r"\b(?P<n>\d{1,3})\s*y[./]?o\.?[mf]?(?![A-Za-z])", re.IGNORECASE),
    # "aged 52", "age: 52", "at the age of 52" -- not "age 34 weeks"
    re.compile(
        rf"\b(?:the\s+)?aged?\s*(?:of\s+)?[:\-]?\s*(?P<n>{_QTY})(?:\s+(?:years?|yrs?)(?:\s+old)?)?\b"
        r"(?!\s*(?:weeks?|wks?|days?|months?|mos?|hours?|hrs?)\b)",
        re.IGNORECASE,
    ),
    # "52 years of age"
    re.compile(r"\b(?P<n>\d{1,3})\s+years?\s+of\s+age\b", re.IGNORECASE),
    # "in his 60s", "in her late 90s", "in his nineties"
    re.compile(
        r"\b(?:in|into)\s+(?:his|her|their)\s+(?:(?:early|mid|late)[\s-]+)?(?P<n>\d0s|nineties)\b", re.IGNORECASE
    ),
]
# An age is not an age when a clinical qualifier sits in front of it.
_NOT_A_PERSONS_AGE = re.compile(
    r"(?:gestational|postmenstrual|corrected|adjusted|bone|fetal|foetal|mental|developmental|lesion|wound)\s*$",
    re.IGNORECASE,
)
_DECADE_TOKEN = re.compile(r"\b(\d0s|nineties)\b", re.IGNORECASE)


def age_replacement(span: str) -> str:
    """The text an age span becomes: a decade band for 18-89, "90+" for 90 and
    over, unchanged under 18. Anything it cannot read becomes "<AGE>" rather
    than being passed through."""
    decade = _DECADE_TOKEN.search(span)
    if decade:
        token = decade.group(1).lower()
        n = 90 if token == "nineties" else int(token[:2])
        return span[: decade.start()] + "90+" + span[decade.end() :] if n >= 90 else span
    quantity = _QTY_RE.search(span)
    n = parse_quantity(quantity.group(0)) if quantity else None
    if n is None:
        return "<AGE>"
    if n >= 90:
        # "age 90+" already says it; do not turn it into "90++"
        band = "90" if span[quantity.end() :].startswith("+") else "90+"
    elif n < 18:
        return span
    else:
        tens = n // 10 * 10
        band = f"{max(tens, 18)}-{tens + 9}"
    return span[: quantity.start()] + band + span[quantity.end() :]


def find_age_spans(text: str) -> list[tuple[int, int]]:
    """Every (start, end) where `text` states a person's age, non-overlapping,
    in order. Includes ages that will be left unchanged (under 18): the caller
    needs them to stop a date recognizer redacting them."""
    found: list[tuple[int, int]] = []
    for pattern in _AGE_PATTERNS:
        for match in pattern.finditer(text):
            if _NOT_A_PERSONS_AGE.search(text[max(0, match.start() - 24) : match.start()]):
                continue
            found.append((match.start(), match.end()))
    found.sort()
    merged: list[tuple[int, int]] = []
    for start, end in found:
        if merged and start < merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


# --- date-like spans -----------------------------------------------------------

_UNIT = r"(?:minute|hour|day|week|month|year|decade)s?"
_LEAD = r"(?:(?:for|over|about|around|approximately|nearly|almost|roughly|more\s+than|less\s+than|at\s+least|within|in|the|past|last|next|previous|another|separate)\s+)*"
_APPROX = r"(?:a|an|several|few|couple(?:\s+of)?|many|some|multiple|half(?:\s+a)?)"
_DURATION = re.compile(
    rf"^{_LEAD}"
    rf"(?:(?P<qty>{_QTY}|{_APPROX})(?:\s*(?:-|to|or)\s*{_QTY})?\s+)?"
    rf"(?P<unit>{_UNIT})"
    r"(?:\s+(?:ago|later|earlier|apart|before|after|prior|postoperative(?:ly)?))?$",
    re.IGNORECASE,
)
# "4 month old" (an infant's age in months/weeks/days) -- never "N year old", which is an age.
_INFANT_AGE = re.compile(
    rf"^(?:{_QTY})[\s-]*(?:month|week|day)s?[\s-]*old$"
    # "age 34 weeks" (gestational or infant age, always well under 90 years)
    rf"|^age\s+(?:of\s+)?(?:{_QTY})\s*(?:month|week|wk|day)s?(?:\s+old)?$",
    re.IGNORECASE,
)
_FREQUENCY = re.compile(
    r"^(?:"
    r"(?:once|twice|\w+\s+times?)\s+(?:a|per|each|every)\s+(?:day|week|month|year|night|hour)"
    r"|(?:once|twice|\w+\s+times?)\s+(?:daily|weekly|monthly|yearly|nightly)"
    r"|(?:every|each)\s+(?:other\s+|\d+\s+|\w+\s+)?(?:minute|hour|day|night|week|month|year|morning|evening|afternoon)s?"
    r"|daily|weekly|monthly|yearly|annual|annually|hourly|nightly|bi-?weekly|quarterly"
    r")$",
    re.IGNORECASE,
)
_RELATIVE = re.compile(
    r"^(?:today|yesterday|tonight|tomorrow|recently|currently|now"
    r"|(?:this|last|next|previous)\s+(?:morning|afternoon|evening|night|week|month|year)"
    r"|(?:the\s+)?(?:day|night)\s+(?:before|after)"
    # a season with no year attached is not a date element ("summer 2019" is, and is redacted)
    r"|(?:(?:in|during|the|every|each)\s+)*(?:spring|summer|fall|autumn|winter)(?:time)?)$",
    re.IGNORECASE,
)
_INDEX = re.compile(r"^(?:(?:post-?op(?:erative)?\s+)?(?:day|week|month|cycle|visit)\s+\d{1,3})$", re.IGNORECASE)
_CLOCK_TIME = re.compile(r"\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\d{1,2}:\d{2}|noon|midnight|o'clock)", re.IGNORECASE)


def classify_date_span(span: str) -> str:
    """What to do with a span Presidio called a date or time: "keep" (a
    duration, frequency or relative word), "age" (a duration of 90+ years,
    which reads as an age), "time" or "date". Unrecognised means "date"."""
    s = re.sub(r"\s+", " ", span.strip().lower()).strip(" .,;:")
    if not s:
        return "date"
    if _CLOCK_TIME.search(s):
        return "time"
    if _FREQUENCY.fullmatch(s) or _RELATIVE.fullmatch(s) or _INDEX.fullmatch(s) or _INFANT_AGE.fullmatch(s):
        return "keep"
    match = _DURATION.fullmatch(s)
    if match:
        if match.group("unit") and match.group("unit").lower().startswith("year") and match.group("qty"):
            n = parse_quantity(match.group("qty"))
            if n is not None and n >= 90:
                return "age"
        return "keep"
    return "date"


# --- things a recognizer mistakes for PII --------------------------------------

_BLOOD_PRESSURE = re.compile(r"^\s*(\d{2,3})\s*/\s*(\d{2,3})\s*(?:mm\s*hg)?\s*$", re.IGNORECASE)


def is_blood_pressure(span: str) -> bool:
    """A systolic/diastolic pair in a physiological range: not a phone number."""
    match = _BLOOD_PRESSURE.match(span)
    if not match:
        return False
    systolic, diastolic = int(match.group(1)), int(match.group(2))
    return 60 <= systolic <= 300 and 30 <= diastolic <= 200 and diastolic < systolic


_DISEASE_WORD = re.compile(
    r"^(?:['’]s)?\s+(?:disease|syndrome|thyroiditis|phenomenon|palsy|lymphoma|esophagus|oesophagus|sign|triad"
    r"|tetralogy|reflex|criteria|paralysis|neuropathy|encephalopathy|tendon|tendons|tendinitis|tendinopathy"
    r"|xanthoma|xanthomas|xanthomata|anemia|anaemia|cyst|ulcer)\b",
    re.IGNORECASE,
)
_ST_CONTEXT = re.compile(r"^[\s-]*(?:segment|elevation|depression|changes?|wave|interval|deviation)\b", re.IGNORECASE)
_TITLE_BEFORE = re.compile(
    r"(?:\b(?:dr|mr|mrs|ms|mx|prof|professor|doctor|nurse|patient|pt|name|physician|surgeon)\.?[:\s]+)$", re.IGNORECASE
)


def is_clinical_term(entity_type: str, text: str, start: int, end: int) -> bool:
    """True when a PERSON/LOCATION span is a clinical term, not a name or place."""
    if entity_type not in ("PERSON", "LOCATION"):
        return False
    span = text[start:end].strip().lower()
    if entity_type == "LOCATION" and span == "st" and _ST_CONTEXT.match(text[end:]):
        return True
    if _TITLE_BEFORE.search(text[max(0, start - 16) : start]):
        return False
    return bool(_DISEASE_WORD.match(text[end:]))


# --- applying it to Presidio's results ----------------------------------------

_NEW_TYPE = {"date": "DATE", "time": "TIME", "age": "AGE_BAND"}


def apply_policy(text: str, results: list[RecognizerResult]) -> list[RecognizerResult]:
    """Return `results` with date-like spans retyped or dropped per the policy
    above, blood pressures and clinical terms dropped, and an AGE_BAND result
    added for every age that changes. Dropping a result means the text at that
    span is kept as written."""
    ages = find_age_spans(text)
    changing = {(s, e) for s, e in ages if age_replacement(text[s:e]) != text[s:e]}
    skipped_ages: set[tuple[int, int]] = set()
    kept: list[RecognizerResult] = []

    for result in results:
        entity = result.entity_type
        span = text[result.start : result.end]
        if entity == "DATE_TIME":
            if any(s <= result.start and result.end <= e for s, e in ages):
                continue  # inside an age span: the age rule decides (band it, or leave a child's age alone)
            partly = [(s, e) for s, e in ages if s < result.end and result.start < e]
            kind = classify_date_span(span)
            if partly:
                # A date span that spills past an age span: redact the whole of it
                # and do not band the age separately.
                skipped_ages.update(partly)
                kind = "time" if kind == "time" else "date"
            if kind == "keep":
                continue
            kept.append(RecognizerResult(_NEW_TYPE[kind], result.start, result.end, result.score))
        elif entity == "PHONE_NUMBER" and is_blood_pressure(span):
            continue
        elif is_clinical_term(entity, text, result.start, result.end):
            continue
        else:
            kept.append(result)

    for start, end in sorted(changing - skipped_ages):
        kept.append(RecognizerResult("AGE_BAND", start, end, 1.0))
    return kept
