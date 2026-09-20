"""Login and deployment gating (auth.py) plus the CORS default in the
Chainlit config. These are security controls, so the tests are mostly about
the ways they could silently fail open."""

import tomllib
from pathlib import Path

import pytest

from glassbox_md import auth
from glassbox_md.auth import (
    AuthConfigError,
    AuthSettings,
    check_credentials,
    enforce_deployment_safety,
    hash_password,
    is_loopback_host,
    load_auth_settings,
    verify_password,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
PASSWORD = "correct horse battery staple"
# 100_000 is the floor verify_password will trust; use it to keep tests fast.
FAST = 100_000


@pytest.fixture(scope="module")
def stored_hash():
    return hash_password(PASSWORD, iterations=FAST)


def _env(stored, **extra):
    env = {auth.USERNAME_ENV: "clinician", auth.PASSWORD_HASH_ENV: stored}
    env.update(extra)
    return env


# --- hashing -------------------------------------------------------------------

def test_hash_round_trips_and_uses_the_documented_format(stored_hash):
    scheme, iterations, salt, digest = stored_hash.split("$")
    assert scheme == "pbkdf2_sha256" and int(iterations) == FAST
    assert len(bytes.fromhex(salt)) == 16 and len(bytes.fromhex(digest)) == 32
    assert verify_password(PASSWORD, stored_hash)


def test_wrong_password_and_near_misses_fail(stored_hash):
    assert not verify_password("wrong", stored_hash)
    assert not verify_password(PASSWORD + " ", stored_hash)
    assert not verify_password(PASSWORD.upper(), stored_hash)
    assert not verify_password("", stored_hash)


def test_the_same_password_hashes_differently_each_time_because_of_the_salt():
    assert hash_password(PASSWORD, iterations=FAST) != hash_password(PASSWORD, iterations=FAST)


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "not a hash",
        "pbkdf2_sha256$100000$abcd",  # too few fields
        "md5$100000$abcd$abcd",  # unknown scheme
        "pbkdf2_sha256$notanint$abcd$abcd",
        "pbkdf2_sha256$100000$zz$abcd",  # salt not hex
        "pbkdf2_sha256$100000$abcd$",  # empty digest
        "pbkdf2_sha256$100000$$abcd",  # empty salt
    ],
)
def test_a_malformed_stored_hash_is_a_failed_check_not_a_crash_or_a_pass(bad):
    assert verify_password(PASSWORD, bad) is False
    assert verify_password("", bad) is False


def test_a_stored_hash_weaker_than_the_floor_is_refused():
    weak = hash_password(PASSWORD, iterations=1_000)
    assert verify_password(PASSWORD, weak) is False


# --- settings ------------------------------------------------------------------

def test_no_credentials_means_login_disabled():
    settings = load_auth_settings({})
    assert settings == AuthSettings() and settings.enabled is False


def test_both_credentials_enable_login(stored_hash):
    settings = load_auth_settings(_env(f"  {stored_hash}  "))
    assert settings.enabled and settings.username == "clinician" and settings.password_hash == stored_hash


@pytest.mark.parametrize("only", ["username", "hash"])
def test_setting_only_one_credential_is_an_error_not_silently_open(stored_hash, only):
    env = {auth.USERNAME_ENV: "clinician"} if only == "username" else {auth.PASSWORD_HASH_ENV: stored_hash}
    with pytest.raises(AuthConfigError, match="both"):
        load_auth_settings(env)


def test_a_garbage_hash_fails_at_startup_not_at_first_login():
    with pytest.raises(AuthConfigError, match="not a valid pbkdf2_sha256 hash"):
        load_auth_settings(_env("plaintext-password-by-mistake"))


def test_a_plaintext_password_in_the_hash_variable_is_rejected():
    with pytest.raises(AuthConfigError):
        load_auth_settings(_env(PASSWORD))


# --- checking a login ----------------------------------------------------------

def test_check_credentials_needs_both_username_and_password(stored_hash):
    settings = AuthSettings("clinician", stored_hash)
    assert check_credentials("clinician", PASSWORD, settings)
    assert not check_credentials("clinician", "wrong", settings)
    assert not check_credentials("someone-else", PASSWORD, settings)
    assert not check_credentials("Clinician", PASSWORD, settings)  # usernames are case-sensitive
    assert not check_credentials("", "", settings)
    assert not check_credentials(None, None, settings)


def test_check_credentials_is_always_false_when_login_is_disabled():
    assert check_credentials("clinician", PASSWORD, AuthSettings()) is False
    assert check_credentials("", "", AuthSettings()) is False


def test_the_password_is_hashed_even_for_an_unknown_username(monkeypatch, stored_hash):
    """So response time doesn't reveal whether a username exists."""
    calls = []
    real = auth.verify_password
    monkeypatch.setattr(auth, "verify_password", lambda p, s: calls.append(1) or real(p, s))

    assert not check_credentials("nobody", PASSWORD, AuthSettings("clinician", stored_hash))
    assert calls == [1]


# --- the deployment gate -------------------------------------------------------

@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]", "127.0.0.2"])
def test_loopback_hosts(host):
    assert is_loopback_host(host)


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.1.20", "10.0.0.5", "example.com", "", "not a host"])
def test_anything_reachable_off_machine_is_not_loopback(host):
    assert not is_loopback_host(host)


def test_default_local_run_without_login_is_allowed():
    assert enforce_deployment_safety({}).enabled is False
    assert enforce_deployment_safety({auth.HOST_ENV: "127.0.0.1"}).enabled is False


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.20", "myserver.example.com"])
def test_binding_a_reachable_host_without_login_refuses_to_start(host):
    with pytest.raises(AuthConfigError, match="Refusing to serve"):
        enforce_deployment_safety({auth.HOST_ENV: host})


def test_the_refusal_names_the_host_and_the_fix():
    with pytest.raises(AuthConfigError) as excinfo:
        enforce_deployment_safety({auth.HOST_ENV: "0.0.0.0"})
    message = str(excinfo.value)
    assert "'0.0.0.0'" in message and "python -m glassbox_md.auth hash" in message and "127.0.0.1" in message


def test_login_without_a_jwt_secret_refuses_to_start(stored_hash):
    with pytest.raises(AuthConfigError, match="CHAINLIT_AUTH_SECRET"):
        enforce_deployment_safety(_env(stored_hash, **{auth.HOST_ENV: "0.0.0.0"}))
    with pytest.raises(AuthConfigError, match="CHAINLIT_AUTH_SECRET"):
        enforce_deployment_safety(_env(stored_hash, **{auth.JWT_SECRET_ENV: "   "}))


def test_login_with_a_jwt_secret_may_bind_a_reachable_host(stored_hash):
    env = _env(stored_hash, **{auth.HOST_ENV: "0.0.0.0", auth.JWT_SECRET_ENV: "s3cret"})
    assert enforce_deployment_safety(env).enabled is True


def test_a_half_configured_login_refuses_to_start_even_on_loopback(stored_hash):
    with pytest.raises(AuthConfigError):
        enforce_deployment_safety({auth.USERNAME_ENV: "clinician"})


# --- the hash CLI ---------------------------------------------------------------

def test_cli_prints_a_single_quoted_env_line_that_verifies(monkeypatch, capsys):
    monkeypatch.setattr("getpass.getpass", lambda prompt="": PASSWORD)

    assert auth._cli_hash() == 0

    line = capsys.readouterr().out.strip()
    assert line.startswith(f"{auth.PASSWORD_HASH_ENV}='pbkdf2_sha256$600000$") and line.endswith("'")
    assert verify_password(PASSWORD, line.split("=", 1)[1].strip("'"))


def test_cli_rejects_a_short_password_and_a_mismatch(monkeypatch, capsys):
    monkeypatch.setattr("getpass.getpass", lambda prompt="": "short")
    assert auth._cli_hash() == 2 and "at least 12" in capsys.readouterr().err

    answers = iter([PASSWORD, PASSWORD + "x"])
    monkeypatch.setattr("getpass.getpass", lambda prompt="": next(answers))
    assert auth._cli_hash() == 2 and "do not match" in capsys.readouterr().err


# --- CORS default ----------------------------------------------------------------

def test_the_chainlit_config_does_not_allow_every_origin():
    """It used to be ["*"], which let any web page in the same browser talk
    to a locally running instance and read saved cases."""
    config = tomllib.loads((REPO_ROOT / ".chainlit" / "config.toml").read_text(encoding="utf-8"))
    origins = config["project"]["allow_origins"]

    assert "*" not in origins
    assert origins and all(o.startswith(("http://localhost", "http://127.0.0.1")) for o in origins)
