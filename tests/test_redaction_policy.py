"""The date / age / clinical-term policy, one rule at a time.

Pure functions, no spaCy: the integration with the real analyzer is tested in
test_privacy_protection.py. The privacy-critical direction is tested hardest:
anything that could be a calendar date, or an age of 90 or more, must NOT be
kept."""

import pytest
from presidio_analyzer import RecognizerResult

from glassbox_md.agents import redaction_policy as rp


# --- numbers -------------------------------------------------------------------

@pytest.mark.parametrize(
    "text, value",
    [
        ("52", 52),
        ("2.5", 2),
        ("fifty-two", 52),
        ("Ninety Three", 93),
        ("twelve", 12),
        ("one hundred and two", 100),
        ("a hundred", 100),
        ("bogus", None),
    ],
)
def test_parse_quantity(text, value):
    assert rp.parse_quantity(text) == value


# --- age replacement -----------------------------------------------------------

@pytest.mark.parametrize(
    "span, expected",
    [
        ("52 year old", "50-59 year old"),
        ("52-year-old", "50-59-year-old"),
        ("52 years old", "50-59 years old"),
        ("Age: 52", "Age: 50-59"),
        ("aged 89", "aged 80-89"),
        ("aged 90", "aged 90+"),
        ("aged 93", "aged 90+"),
        ("93 y/o", "90+ y/o"),
        ("101yo", "90+yo"),
        ("ninety-three year old", "90+ year old"),
        ("one hundred year old", "90+ year old"),
        ("fifty-two year old", "50-59 year old"),
        ("in his 90s", "in his 90+"),
        ("in her nineties", "in her 90+"),
        ("in his 60s", "in his 60s"),  # already a decade
        ("18 year old", "18-19 year old"),
        ("19 year old", "18-19 year old"),
        ("20 year old", "20-29 year old"),
        ("17 year old", "17 year old"),  # a minor's exact age is kept
        ("5 year old", "5 year old"),
        ("age 90+", "age 90+"),  # not "90++"
    ],
)
def test_age_replacement(span, expected):
    assert rp.age_replacement(span) == expected


def test_every_age_from_90_up_reads_90_plus_and_never_the_number():
    for n in range(90, 121):
        out = rp.age_replacement(f"{n} year old")
        assert out == "90+ year old"
        if n > 90:  # "90+" itself contains "90"
            assert str(n) not in out


def test_an_unreadable_age_is_replaced_not_passed_through():
    assert rp.age_replacement("year old") == "<AGE>"


# --- finding ages --------------------------------------------------------------

@pytest.mark.parametrize(
    "text",
    [
        "A 52 year old man",
        "A 52-year-old man",
        "a 52 yr. old man",
        "52 y/o male",
        "52yo",
        "52 y.o. female",
        "52yom",
        "aged 52",
        "Age: 52",
        "age of 52",
        "at the age of 52",
        "Age 52 years",
        "52 years of age",
        "a sixty-two-year-old woman",
        "in his 60s",
        "in her late 90s",
        "in her nineties",
    ],
)
def test_find_age_spans_recognises_each_form(text):
    assert len(rp.find_age_spans(text)) == 1


@pytest.mark.parametrize(
    "text",
    [
        "gestational age 34 weeks",
        "Gestational age: 34",  # qualifier in front, even with no unit
        "corrected age 40 weeks",
        "bone age 12 years",
        "stage 3 disease",
        "He is 5 years older than his sister.",
        "Symptoms for 3 years.",
        "age 6 months",
        "Postmenstrual age 36",
    ],
)
def test_find_age_spans_ignores_things_that_are_not_a_persons_age(text):
    assert rp.find_age_spans(text) == []


def test_find_age_spans_returns_ordered_non_overlapping_spans():
    text = "52 year old man, aged 52, and a 70-year-old relative"
    spans = rp.find_age_spans(text)
    assert spans == sorted(spans) and all(a[1] <= b[0] for a, b in zip(spans, spans[1:]))
    assert len(spans) == 3


# --- classifying date-like spans -----------------------------------------------

@pytest.mark.parametrize(
    "span",
    [
        "three months",
        "10 years",
        "2.5 years",
        "two years ago",
        "the past year",
        "over the past year",
        "several months",
        "more than three months",
        "a month",
        "a month apart",
        "separate days",
        "minutes",
        "48 hours",
        "1-2 weeks",
        "6 to 8 weeks",
        "twice daily",
        "twice a day",
        "three times daily",
        "every 6 hours",
        "every other day",
        "each night",
        "daily",
        "annual",
        "annually",
        "yesterday",
        "today",
        "last week",
        "this morning",
        "week 12",
        "post-op day 3",
        "4 month old",
        "age 34 weeks",
        "spring",
        "in the winter",
    ],
)
def test_durations_frequencies_and_relative_words_are_kept(span):
    assert rp.classify_date_span(span) == "keep"


@pytest.mark.parametrize(
    "span",
    [
        "March 14, 2021",
        "03/14/2021",
        "2021-03-14",
        "2019",
        "since 2019",
        "Monday",
        "March",
        "the 1990s",
        "summer 2019",
        "54",
        "52 year old",  # an age: the age rule handles it, and unknown forms are redacted
        "some odd thing",
        "",
        "   ",
    ],
)
def test_anything_that_could_be_a_calendar_date_is_redacted_as_a_date(span):
    assert rp.classify_date_span(span) == "date"


@pytest.mark.parametrize("span", ["3 pm", "3:30 pm", "3:30", "14:30", "noon", "midnight", "9 a.m.", "at 5 o'clock"])
def test_clock_times_are_redacted_as_a_time(span):
    assert rp.classify_date_span(span) == "time"


@pytest.mark.parametrize("span", ["95 years", "one hundred years", "for 90 years", "120 years"])
def test_a_duration_of_ninety_years_or_more_reads_as_an_age(span):
    assert rp.classify_date_span(span) == "age"


def test_a_long_but_plausible_duration_is_kept():
    assert rp.classify_date_span("for 40 years") == "keep"
    assert rp.classify_date_span("89 years") == "keep"


# --- blood pressure, clinical terms ---------------------------------------------

@pytest.mark.parametrize("span", ["168/102", " 120/80 ", "120/80 mmHg", "90/60"])
def test_blood_pressures_are_recognised(span):
    assert rp.is_blood_pressure(span)


@pytest.mark.parametrize("span", ["555/123", "234/567", "80/120", "5/3", "12/25", "01/02/2020", "(555) 234-5678", "555-1234", ""])
def test_things_that_are_not_blood_pressures_are_not(span):
    assert not rp.is_blood_pressure(span)


def _term(entity, text, span):
    start = text.index(span)
    return rp.is_clinical_term(entity, text, start, start + len(span))


@pytest.mark.parametrize(
    "entity, text, span",
    [
        ("LOCATION", "Treadmill test showed ST segment depression.", "ST"),
        ("LOCATION", "Diffuse ST elevation on the ECG.", "ST"),
        ("PERSON", "Yellow deposits on the Achilles tendons.", "Achilles"),
        ("PERSON", "Sister has Hashimoto thyroiditis.", "Hashimoto"),
        ("PERSON", "Hashimoto's disease runs in the family.", "Hashimoto"),
        ("PERSON", "Family history of Graves disease.", "Graves"),
        ("LOCATION", "Prior Lyme disease.", "Lyme"),
        ("PERSON", "Known Down syndrome.", "Down"),
    ],
)
def test_clinical_terms_are_not_names_or_places(entity, text, span):
    assert _term(entity, text, span)


@pytest.mark.parametrize(
    "entity, text, span",
    [
        ("PERSON", "Dr. Graves disease clinic", "Graves"),
        ("PERSON", "Patient: Achilles tendon pain", "Achilles"),
        ("PERSON", "Mr Hashimoto syndrome", "Hashimoto"),
        ("PERSON", "Wilson reports chest pain.", "Wilson"),
        ("PERSON", "John Smith was seen today.", "John Smith"),
        ("LOCATION", "Seen at St. Louis Hospital.", "St"),
        ("LOCATION", "Lives in Springfield.", "Springfield"),
        ("EMAIL_ADDRESS", "Graves disease", "Graves"),  # only PERSON/LOCATION are ever let through
    ],
)
def test_names_and_places_are_still_redacted(entity, text, span):
    assert not _term(entity, text, span)


# --- applying the policy to analyzer results ------------------------------------

def _r(text, span, entity="DATE_TIME", score=0.85):
    start = text.index(span)
    return RecognizerResult(entity, start, start + len(span), score)


def _types(results):
    return sorted((r.entity_type, r.start, r.end) for r in results)


def test_a_duration_result_is_dropped_so_its_text_is_kept():
    text = "cough for three months"
    assert rp.apply_policy(text, [_r(text, "three months")]) == []


def test_a_calendar_date_result_is_retyped_date():
    text = "seen on March 3"
    out = rp.apply_policy(text, [_r(text, "March 3")])
    assert [(r.entity_type, text[r.start : r.end]) for r in out] == [("DATE", "March 3")]


def test_a_clock_time_result_is_retyped_time():
    text = "seen at 3 pm"
    out = rp.apply_policy(text, [_r(text, "3 pm")])
    assert [r.entity_type for r in out] == ["TIME"]


def test_a_date_result_inside_an_age_is_replaced_by_an_age_band_result():
    text = "A 52 year old man"
    out = rp.apply_policy(text, [_r(text, "52 year old")])
    assert [(r.entity_type, text[r.start : r.end]) for r in out] == [("AGE_BAND", "52 year old")]


def test_a_childs_age_produces_no_result_at_all():
    text = "A 5 year old child"
    assert rp.apply_policy(text, [_r(text, "5 year old")]) == []


def test_an_age_the_date_recognizer_missed_is_still_banded():
    text = "Age: 93"
    out = rp.apply_policy(text, [])
    assert [(r.entity_type, text[r.start : r.end]) for r in out] == [("AGE_BAND", "Age: 93")]


def test_a_date_span_that_spills_past_an_age_is_redacted_whole_and_the_age_is_not_banded_twice():
    text = "52 year old since 2019"
    out = rp.apply_policy(text, [_r(text, "52 year old since 2019")])
    assert [(r.entity_type, text[r.start : r.end]) for r in out] == [("DATE", text)]


def test_blood_pressure_phone_false_positive_is_dropped_but_a_real_phone_is_kept():
    text = "BP 168/102, call (555) 234-5678"
    bp = _r(text, "168/102", "PHONE_NUMBER", 0.4)
    phone = _r(text, "(555) 234-5678", "PHONE_NUMBER", 0.75)
    assert rp.apply_policy(text, [bp, phone]) == [phone]


def test_a_clinical_term_result_is_dropped_but_an_unrelated_name_is_kept():
    text = "Achilles tendons; John Smith"
    term = _r(text, "Achilles", "PERSON", 0.85)
    name = _r(text, "John Smith", "PERSON", 0.85)
    assert rp.apply_policy(text, [term, name]) == [name]


def test_results_of_other_entity_types_pass_through_untouched():
    text = "mail jane@example.org"
    email = _r(text, "jane@example.org", "EMAIL_ADDRESS", 1.0)
    assert rp.apply_policy(text, [email]) == [email]
