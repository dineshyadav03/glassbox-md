"""Login and deployment gating for the Chainlit app.

Deliberately small. The app is a local, single-operator demo; this exists so
that the day it is put on a network the safe path is the default one:

- Credentials come from the environment as a salted PBKDF2 hash, never a
  plaintext password (`python -m glassbox_md.auth hash` prints the line to
  put in `.env`).
- `enforce_deployment_safety()` refuses to start when the server is bound to
  a non-loopback host without login configured, and when login is configured
  without the JWT secret Chainlit needs to sign sessions.
- Comparison is constant-time, and the password hash is always computed even
  for an unknown username, so a login attempt does not reveal which
  usernames exist by timing.

What this is not: there is one shared credential (no per-user accounts, no
per-user isolation of saved cases in case_store.py), no lockout or rate
limiting beyond PBKDF2's own cost, and no TLS -- terminate TLS and rate-limit
in a reverse proxy in front of it. See README "Deployment checklist".
"""

from __future__ import annotations

import getpass
import hashlib
import hmac
import ipaddress
import os
import secrets
import sys
from dataclasses import dataclass
from typing import Mapping

USERNAME_ENV = "GLASSBOX_AUTH_USERNAME"
PASSWORD_HASH_ENV = "GLASSBOX_AUTH_PASSWORD_HASH"
JWT_SECRET_ENV = "CHAINLIT_AUTH_SECRET"
HOST_ENV = "CHAINLIT_HOST"  # set by `chainlit run --host ...`
DEFAULT_HOST = "127.0.0.1"

HASH_SCHEME = "pbkdf2_sha256"
DEFAULT_ITERATIONS = 600_000  # OWASP's 2023 guidance for PBKDF2-HMAC-SHA256
_MIN_ITERATIONS = 100_000  # refuse to trust a stored hash weaker than this
MIN_PASSWORD_LENGTH = 12


class AuthConfigError(RuntimeError):
    """Login is misconfigured, or the server was about to be exposed
    without it. Raised at startup so it fails loudly instead of serving."""


def hash_password(password: str, *, iterations: int = DEFAULT_ITERATIONS, salt: bytes | None = None) -> str:
    salt = salt if salt is not None else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"{HASH_SCHEME}${iterations}${salt.hex()}${digest.hex()}"


def _parse_hash(stored: str) -> tuple[int, bytes, bytes] | None:
    """(iterations, salt, expected digest) for a well-formed stored hash at
    or above the minimum strength, else None."""
    try:
        scheme, iterations_text, salt_hex, digest_hex = stored.split("$")
        iterations = int(iterations_text)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
    except (ValueError, AttributeError):
        return None
    if scheme != HASH_SCHEME or iterations < _MIN_ITERATIONS or not salt or not expected:
        return None
    return iterations, salt, expected


def verify_password(password: str, stored: str) -> bool:
    """True only for a well-formed stored hash that the password matches.
    Any malformed or too-weak stored value is a failed check, not an error."""
    parsed = _parse_hash(stored)
    if parsed is None:
        return False
    iterations, salt, expected = parsed
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=len(expected))
    return hmac.compare_digest(actual, expected)


@dataclass(frozen=True)
class AuthSettings:
    username: str | None = None
    password_hash: str | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.username and self.password_hash)


def load_auth_settings(env: Mapping[str, str] | None = None) -> AuthSettings:
    """Read login settings. Both variables or neither: setting only one is
    almost certainly a mistake, and silently treating it as "auth off" would
    be the dangerous way to interpret it."""
    env = os.environ if env is None else env
    username = (env.get(USERNAME_ENV) or "").strip()
    password_hash = (env.get(PASSWORD_HASH_ENV) or "").strip()
    if bool(username) != bool(password_hash):
        raise AuthConfigError(
            f"Set both {USERNAME_ENV} and {PASSWORD_HASH_ENV}, or neither. Only one is set, and treating "
            "that as 'login disabled' would leave the app open by accident."
        )
    if password_hash and _parse_hash(password_hash) is None:
        raise AuthConfigError(
            f"{PASSWORD_HASH_ENV} is not a valid {HASH_SCHEME} hash (or it uses fewer than {_MIN_ITERATIONS} "
            "iterations). Generate one with: python -m glassbox_md.auth hash"
        )
    return AuthSettings(username=username or None, password_hash=password_hash or None)


def check_credentials(username: str, password: str, settings: AuthSettings) -> bool:
    """Constant-time credential check. The hash is computed even when the
    username is wrong, so timing doesn't reveal whether it exists."""
    if not settings.enabled:
        return False
    password_ok = verify_password(password or "", settings.password_hash or "")
    username_ok = hmac.compare_digest((username or "").encode("utf-8"), (settings.username or "").encode("utf-8"))
    return password_ok and username_ok


def is_loopback_host(host: str) -> bool:
    host = (host or "").strip().strip("[]")
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False  # a hostname or 0.0.0.0/:: -- anything that may be reachable off-machine


def enforce_deployment_safety(env: Mapping[str, str] | None = None) -> AuthSettings:
    """Raise AuthConfigError unless it is safe to start; return the settings.

    Safe means either: login is configured (with the JWT secret Chainlit
    needs), or the server is bound to loopback only."""
    env = os.environ if env is None else env
    settings = load_auth_settings(env)
    if settings.enabled:
        if not (env.get(JWT_SECRET_ENV) or "").strip():
            raise AuthConfigError(
                f"Login is configured but {JWT_SECRET_ENV} is not set; Chainlit needs it to sign sessions. "
                "Generate one with: chainlit create-secret"
            )
        return settings
    host = env.get(HOST_ENV) or DEFAULT_HOST
    if not is_loopback_host(host):
        raise AuthConfigError(
            f"Refusing to serve on {host!r} without login. This app has no other access control, and "
            f"its saved cases are readable by anyone who can reach it. Configure {USERNAME_ENV} and "
            f"{PASSWORD_HASH_ENV} (python -m glassbox_md.auth hash), plus {JWT_SECRET_ENV}, or bind to "
            "127.0.0.1."
        )
    return settings


def _cli_hash() -> int:
    first = getpass.getpass("Password: ")
    if len(first) < MIN_PASSWORD_LENGTH:
        print(f"Use at least {MIN_PASSWORD_LENGTH} characters.", file=sys.stderr)
        return 2
    if getpass.getpass("Repeat: ") != first:
        print("Passwords do not match.", file=sys.stderr)
        return 2
    # Single-quoted: the hash contains "$", which some .env parsers and
    # shells would otherwise treat as the start of a variable reference.
    print(f"{PASSWORD_HASH_ENV}='{hash_password(first)}'")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["hash"]:
        sys.exit(_cli_hash())
    print("usage: python -m glassbox_md.auth hash", file=sys.stderr)
    sys.exit(2)
