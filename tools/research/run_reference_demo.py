"""Run the unchanged reference UI with a local, non-network demo upstream.

Run from the PC repository: .venv/Scripts/python.exe tools/research/run_reference_demo.py
The public demo login value is ui-demo-only. It is not a NovelAI credential.
"""
from __future__ import annotations

import base64
import io
import json
from pathlib import Path
import sys
import time

PC_ROOT = Path(__file__).resolve().parents[2]
REFERENCE = PC_ROOT.parent / "novelai_local_web"
DATA = PC_ROOT / ".tmp" / "reference-ui-demo" / "data"
sys.path.insert(0, str(REFERENCE / "nai_flask"))

from PIL import Image, ImageDraw, PngImagePlugin
from app import create_app
from api_utils.novelai_client import NovelAIUpstreamError
from waitress import serve


def fixture_png(width=640, height=896, index=0, prompt="UI test fixture"):
    width, height = int(width), int(height)
    canvas = Image.new("RGB", (width, height), (16 + index % 15, 21, 32))
    draw = ImageDraw.Draw(canvas)
    accent = (245, 213 - index % 30, 122 + index % 50)
    draw.rounded_rectangle((width*.08, height*.12, width*.92, height*.8), radius=30, fill=(36, 40, 54), outline=accent, width=4)
    draw.ellipse((width*.25, height*.23, width*.75, height*.23 + width*.5), fill=accent)
    draw.text((width*.12, height*.85), f"UI TEST FIXTURE {index:02d}\nNOT AI GENERATED", fill="white")
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Software", "NovelAI")
    metadata.add_text("Description", prompt)
    metadata.add_text("Comment", json.dumps({"prompt": prompt, "uc": "blur", "seed": 1000 + index, "steps": 28, "sampler": "k_euler", "scale": 5, "width": width, "height": height}))
    buffer = io.BytesIO()
    canvas.save(buffer, format="PNG", pnginfo=metadata)
    return buffer.getvalue()


class DemoUpstream:
    """Implement the reference dependency-injection contract; no network calls."""
    def account_snapshot(self, token):
        if token != "ui-demo-only":
            raise NovelAIUpstreamError("Demo only: use ui-demo-only, never a real credential.", 401, "DEMO_ONLY")
        return {"information": {"emailVerified": True}, "subscription": {"tier": 3, "trainingStepsLeft": {"fixedTrainingStepsLeft": 1000, "purchasedTrainingSteps": 0}}}

    def generate_image(self, token, payload, correlation_id):
        self.account_snapshot(token)
        time.sleep(1.5)  # Intentional demo latency, not a performance measurement.
        params = payload.get("parameters", {})
        seed = params.get("seed", 1000)
        result = fixture_png(params.get("width", 640), params.get("height", 896), int(seed or 0) % 100, payload.get("input", "UI test fixture"))
        return [{"data": base64.b64encode(result).decode(), "mime_type": "image/png", "seed": seed, "index": 0}]

    def suggest_tags(self, token, params):
        self.account_snapshot(token)
        return {"tags": [{"tag": "blue_sky", "confidence": .95}, {"tag": "cloud", "confidence": .9}]}

    def __getattr__(self, name):
        def unsupported(*args, **kwargs):
            raise NovelAIUpstreamError("Operation is outside this local UI demo.", 400, "DEMO_NOT_IMPLEMENTED")
        return unsupported


def main():
    outputs = DATA / "generated-images"
    outputs.mkdir(parents=True, exist_ok=True)
    # Seed disposable local pictures for scroll/filter/detail testing.
    for index in range(36):
        target = outputs / f"ui_fixture_{index:02d}.png"
        if not target.exists():
            target.write_bytes(fixture_png(640 if index % 3 else 896, 896 if index % 3 else 640, index))
    app = create_app({"PORT": 5071, "DATA_DIR": str(DATA), "FRONTEND_OUT_DIR": str(REFERENCE / "next_nai_web" / "out")}, novelai_client=DemoUpstream())
    print("UI DEMO ONLY at http://127.0.0.1:5071/login ; login value: ui-demo-only", flush=True)
    serve(app, host="127.0.0.1", port=5071, threads=8)


if __name__ == "__main__":
    main()
