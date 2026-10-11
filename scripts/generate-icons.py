"""Generate the prototype's original geometric brush mark (Pillow required)."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
image = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((40, 40, 984, 984), radius=260, fill="#F5D57A")
draw.polygon([(460, 565), (660, 270), (746, 220), (797, 270),
              (745, 355), (520, 625)], fill="#202025")
draw.polygon([(438, 585), (503, 648), (444, 768), (268, 798),
              (328, 721), (328, 651)], fill="#202025")
for size in (192, 512):
    icon = image.resize((size, size), Image.Resampling.LANCZOS)
    icon.save(ROOT / "web" / "icons" / f"Icon-{size}.png")
    icon.save(ROOT / "web" / "icons" / f"Icon-maskable-{size}.png")
image.resize((32, 32), Image.Resampling.LANCZOS).save(ROOT / "web" / "favicon.png")
image.save(ROOT / "windows" / "runner" / "resources" / "app_icon.ico",
           sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
