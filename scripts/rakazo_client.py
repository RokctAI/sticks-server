#!/usr/bin/env python3
"""Minimal client for the Sticks server (Rakazo) API, for our backend scripts.

Same wire format the Sticks app uses: each procedure is `POST <base>/rpc/<group>/<name>` with body
`{"json": <input>}`, and the answer is `{"json": <output>}`. Sign-in is better-auth email sign-in;
the session token comes back in the `set-auth-token` header (or the body) and is sent as
`Authorization: Bearer <token>`. `x-rakazo-space-id` picks the space; without it the server uses
the account's current space. The `rakazo://` origin is the value upstream expects (wire value).

Configuration comes from the environment, never from files in this repo:
  STICKS_SERVER_URL      e.g. https://server.example.com
  STICKS_SERVER_TOKEN    a session token (preferred), or
  STICKS_SERVER_EMAIL / STICKS_SERVER_PASSWORD   to sign in
  STICKS_SERVER_SPACE    optional space id
Nothing here prints a token or password.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable

ORIGIN = "rakazo://"
TIMEOUT = 30

# (method, url, headers, body bytes) -> (status, response headers, body bytes). Tests replace it.
Transport = Callable[[str, str, dict[str, str], bytes], tuple[int, dict[str, str], bytes]]


def urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, e.read() or b""


class RakazoError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message


class RakazoClient:
    def __init__(self, base_url: str, token: str | None = None, space_id: str | None = None,
                 transport: Transport = urllib_transport):
        self.base = base_url.rstrip("/")
        self.token = token
        self.space_id = space_id
        self.transport = transport

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None, transport: Transport = urllib_transport) -> "RakazoClient":
        env = dict(os.environ if env is None else env)
        url = env.get("STICKS_SERVER_URL", "").strip()
        if not url:
            raise RakazoError(0, "STICKS_SERVER_URL is not set")
        client = cls(url, env.get("STICKS_SERVER_TOKEN") or None, env.get("STICKS_SERVER_SPACE") or None, transport)
        if not client.token:
            email, password = env.get("STICKS_SERVER_EMAIL", ""), env.get("STICKS_SERVER_PASSWORD", "")
            if not (email and password):
                raise RakazoError(0, "set STICKS_SERVER_TOKEN, or STICKS_SERVER_EMAIL and STICKS_SERVER_PASSWORD")
            client.sign_in(email, password)
        return client

    def _headers(self) -> dict[str, str]:
        h = {"content-type": "application/json", "origin": ORIGIN}
        if self.token:
            h["authorization"] = f"Bearer {self.token}"
        if self.space_id:
            h["x-rakazo-space-id"] = self.space_id
        return h

    def sign_in(self, email: str, password: str) -> None:
        status, headers, body = self.transport(
            "POST", f"{self.base}/api/auth/sign-in/email", self._headers(),
            json.dumps({"email": email, "password": password}).encode())
        if not 200 <= status < 300:
            raise RakazoError(status, "sign-in failed")
        token = headers.get("set-auth-token", "")
        if not token:
            try:
                token = (json.loads(body or b"{}") or {}).get("token", "")
            except ValueError:
                token = ""
        if not token:
            raise RakazoError(status, "sign-in returned no session token")
        self.token = token

    def call(self, procedure: str, payload: Any = None) -> Any:
        status, _, body = self.transport(
            "POST", f"{self.base}/rpc/{procedure}", self._headers(), json.dumps({"json": payload}).encode())
        try:
            decoded = json.loads(body) if body else None
        except ValueError:
            raise RakazoError(status, f"{procedure} returned no JSON") from None
        if not 200 <= status < 300:
            j = decoded.get("json") if isinstance(decoded, dict) else None
            msg = (j.get("message") or j.get("code")) if isinstance(j, dict) else None
            raise RakazoError(status, str(msg or f"{procedure} failed"))
        return decoded.get("json") if isinstance(decoded, dict) and "json" in decoded else decoded
