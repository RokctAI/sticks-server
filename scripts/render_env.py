#!/usr/bin/env python3
"""Print the image lines for the upstream compose env file from upstream.pin.

Upstream's compose files read RAKAZO_IMAGE, RAKAZO_IMAGE_TAG, RAKAZO_COMPUTER_IMAGE and
RAKAZO_COMPUTER_IMAGE_TAG. A tag followed by @sha256:<digest> pins the exact image. The hub
appends this output to the tenant's .env (the hub deploys and upgrades, nothing else touches Docker).

Usage: python scripts/render_env.py > pinned.env
"""
from pathlib import Path

from sync_upstream import read_pin

ROOT = Path(__file__).resolve().parent.parent


def render(pin: dict[str, str]) -> str:
    tag = pin["TAG"]
    app_tag = tag + (f"@{pin['APP_IMAGE_DIGEST']}" if pin.get("APP_IMAGE_DIGEST") else "")
    comp_tag = tag + (f"@{pin['COMPUTER_IMAGE_DIGEST']}" if pin.get("COMPUTER_IMAGE_DIGEST") else "")
    return "\n".join(
        [
            f"RAKAZO_IMAGE={pin['APP_IMAGE']}",
            f"RAKAZO_IMAGE_TAG={app_tag}",
            f"RAKAZO_COMPUTER_IMAGE={pin['COMPUTER_IMAGE']}",
            f"RAKAZO_COMPUTER_IMAGE_TAG={comp_tag}",
            "",
        ]
    )


if __name__ == "__main__":
    print(render(read_pin(ROOT / "upstream.pin")), end="")
