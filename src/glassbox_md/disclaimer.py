"""The project's intended-use disclaimer, defined once and imported
everywhere it needs to appear (README, CLI output, and later the Chainlit
UI) -- per the clinical-safety review, which flagged that this single
artifact does more to responsibly scope a project like this than any
architectural change, and that it needs to be baked in from day one rather
than added once something resembling a real diagnosis is on screen.
"""

INTENDED_USE_DISCLAIMER = (
    "Educational / portfolio demonstration of a multi-agent medical-AI "
    "pipeline. Not an FDA-cleared or clinically validated medical "
    "device. Not validated for diagnostic accuracy. Must not be used with "
    "real patient data (PHI) or to inform actual clinical decisions. All "
    "outputs are illustrative only, not medical advice, and require "
    "qualified clinician review before any action. The reasoning shown is "
    "the model's own account of itself and has not been verified as a "
    "faithful explanation of how the answer was reached."
)

# A shorter variant for space-constrained UI chrome (e.g. a banner strip),
# kept in sync with the full text above -- update both together.
INTENDED_USE_BANNER = (
    "Demo only -- not a medical device, not clinically validated, "
    "not medical advice. Requires clinician review before any action."
)
