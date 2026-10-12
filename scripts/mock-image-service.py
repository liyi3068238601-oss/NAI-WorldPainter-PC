"""Loopback-only image fixture for UI validation; never proxies requests."""

import argparse
import base64
import binascii
import io
import json
import os
import re
import threading
import warnings
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import (
    Image,
    ImageChops,
    ImageDraw,
    ImageEnhance,
    ImageFilter,
    ImageFont,
    ImageOps,
)


MAX_REQUEST_BYTES = 64 * 1024 * 1024
MAX_SOURCE_BYTES = 32 * 1024 * 1024
MAX_SOURCE_PIXELS = 32_000_000
MAX_SOURCE_DIMENSION = 32_768
MAX_OUTPUT_PIXELS = 4096 * 4096
MAX_OUTPUT_DIMENSION = 4096
MAX_OUTPUT_IMAGE_BYTES = 47 * 1024 * 1024
JSON_ROUTES = {
    '/v1/images/generations',
    '/v1/images/edits',
}
DIRECTOR_TOOLS = {
    'director-declutter': 'declutter',
    'director-bg-remover': 'bg-remover',
    'director-lineart': 'lineart',
    'director-sketch': 'sketch',
    'director-colorize': 'colorize',
    'director-emotion': 'emotion',
}
REPORT_PATH = Path(__file__).resolve().parents[1] / '.tmp' / 'processing-mock-report.json'
_RESAMPLE = getattr(Image, 'Resampling', Image).LANCZOS


class MockRequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _validate_dimensions(width, height, *, output):
    if type(width) is not int or type(height) is not int or width < 1 or height < 1:
        raise MockRequestError(400, 'Invalid image dimensions.')
    max_dimension = MAX_OUTPUT_DIMENSION if output else MAX_SOURCE_DIMENSION
    max_pixels = MAX_OUTPUT_PIXELS if output else MAX_SOURCE_PIXELS
    if width > max_dimension or height > max_dimension or width * height > max_pixels:
        raise MockRequestError(413, 'Image dimensions exceed the mock limit.')
    return width, height


def _fixture_image():
    image = Image.new('RGB', (832, 1216), '#101827')
    draw = ImageDraw.Draw(image)
    for y in range(1216):
        draw.line(
            (0, y, 831, y),
            fill=(
                16 + int(y / 1216 * 20),
                24 + int(y / 1216 * 26),
                39 + int(y / 1216 * 30),
            ),
        )
    draw.ellipse((540, 150, 680, 290), fill='#F5D57A')
    draw.polygon(
        [(0, 750), (150, 430), (355, 775), (555, 510), (832, 860), (832, 1216), (0, 1216)],
        fill='#43586A',
    )
    draw.polygon(
        [(0, 920), (260, 650), (540, 980), (720, 740), (832, 910), (832, 1216), (0, 1216)],
        fill='#243747',
    )
    draw.rectangle((0, 1030, 832, 1216), fill='#162A39')
    draw.text((34, 40), 'WORLDPAINTER / LOCAL MOCK', fill='#F5D57A')
    draw.text((34, 62), 'Image pipeline fixture - no external API', fill='#B2BCC8')
    return image


def _encode_png(image):
    output = io.BytesIO()
    image.save(output, format='PNG', optimize=True)
    data = output.getvalue()
    if len(data) > MAX_OUTPUT_IMAGE_BYTES:
        raise MockRequestError(413, 'Mock output exceeds the image-size limit.')
    return data


def _decode_image_field(value):
    if not isinstance(value, str) or not value:
        raise MockRequestError(400, 'A base64 image is required.')
    encoded = value
    if value.startswith('data:'):
        header, separator, encoded = value.partition(',')
        if not separator or not header.startswith('data:image/'):
            raise MockRequestError(400, 'Invalid image data URI.')
    if len(encoded) > ((MAX_SOURCE_BYTES + 2) // 3) * 4:
        raise MockRequestError(413, 'Source image exceeds the mock limit.')
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise MockRequestError(400, 'Invalid base64 image.') from None
    if not image_bytes or len(image_bytes) > MAX_SOURCE_BYTES:
        raise MockRequestError(413, 'Source image exceeds the mock limit.')

    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(image_bytes)) as decoded:
                if decoded.format not in {'PNG', 'JPEG', 'WEBP'}:
                    raise MockRequestError(400, 'Unsupported source image format.')
                width, height = _validate_dimensions(*decoded.size, output=False)
                decoded.load()
                return decoded.convert('RGB'), (width, height)
    except MockRequestError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise MockRequestError(413, 'Source image exceeds the mock limit.') from None
    except Exception:
        raise MockRequestError(400, 'Invalid source image.') from None


def _requested_dimensions(payload, source_size):
    if 'width' in payload or 'height' in payload:
        width = payload.get('width')
        height = payload.get('height')
        return _validate_dimensions(width, height, output=True)

    size = payload.get('size')
    if size is not None:
        if not isinstance(size, str):
            raise MockRequestError(400, 'Invalid image size.')
        match = re.fullmatch(r'(\d{1,5})x(\d{1,5})', size)
        if match is None:
            raise MockRequestError(400, 'Invalid image size.')
        return _validate_dimensions(int(match.group(1)), int(match.group(2)), output=True)

    if source_size is not None:
        return _validate_dimensions(*source_size, output=True)
    return 832, 1216


def _request_operation(payload):
    for key in ('extra', 'novelai_operation'):
        value = payload.get(key)
        if isinstance(value, str) and value in DIRECTOR_TOOLS:
            return value, 'director-' + DIRECTOR_TOOLS[value]
        if value == 'encode-vibe':
            return None, 'encode-vibe'
        if value == 'precise-reference':
            return None, 'precise-reference'

    if isinstance(payload.get('image'), str):
        return None, 'inpaint' if isinstance(payload.get('mask'), str) else 'img2img'
    return None, 'generate'


def _stamp_local_mock(image, operation):
    alpha = image.getchannel('A') if image.mode == 'RGBA' else None
    result = image.convert('RGB')
    draw = ImageDraw.Draw(result)
    font_size = max(12, min(32, min(result.size) // 24))
    try:
        font = ImageFont.load_default(size=font_size)
    except TypeError:  # Pillow before 10.1 has a fixed bitmap default font.
        font = ImageFont.load_default()
    label = 'LOCAL MOCK'
    detail = operation.upper()
    if result.width < 112:
        label = 'LOCAL\nMOCK'
    label_box = draw.multiline_textbbox((0, 0), label, font=font, spacing=1)
    detail_box = draw.textbbox((0, 0), detail, font=font)
    detail_width = detail_box[2] - detail_box[0]
    if detail_width + 8 > result.width:
        detail = ''
        detail_width = 0
    text_width = max(label_box[2] - label_box[0], detail_width)
    text_height = (label_box[3] - label_box[1]) + (detail_box[3] - detail_box[1]) + 3
    if not detail:
        text_height = label_box[3] - label_box[1]
    pad = 4
    box_width = min(result.width, text_width + pad * 2)
    box_height = min(result.height, text_height + pad * 2)
    draw.rectangle((0, 0, box_width - 1, box_height - 1), fill='#101827')
    draw.multiline_text((pad, pad), label, font=font, fill='#F5D57A', spacing=1)
    detail_y = pad + label_box[3] - label_box[1] + 2
    if detail and detail_y < box_height:
        draw.text((pad, detail_y), detail, font=font, fill='#B2BCC8')
    if alpha is not None:
        label_alpha = Image.new('L', result.size, 0)
        ImageDraw.Draw(label_alpha).rectangle(
            (0, 0, box_width - 1, box_height - 1), fill=255
        )
        result.putalpha(ImageChops.lighter(alpha, label_alpha))
    return result


def _director_result(image, tool):
    if tool == 'lineart':
        edges = ImageOps.autocontrast(ImageOps.grayscale(image).filter(ImageFilter.FIND_EDGES))
        result = ImageOps.invert(edges).point(lambda value: 255 if value >= 176 else 0)
    elif tool == 'sketch':
        gray = ImageOps.grayscale(image)
        inverted_blur = ImageOps.invert(gray).filter(
            ImageFilter.GaussianBlur(max(2, min(image.size) / 80))
        )
        result = ImageChops.screen(gray, ImageOps.invert(inverted_blur))
        result = ImageEnhance.Contrast(result).enhance(1.25)
    elif tool == 'declutter':
        result = ImageEnhance.Contrast(image.filter(ImageFilter.MedianFilter(3))).enhance(1.12)
    elif tool == 'bg-remover':
        background = Image.new('RGB', image.size, image.getpixel((0, 0)))
        difference = ImageChops.difference(image, background).convert('L')
        alpha = difference.point(lambda value: 0 if value < 32 else 255)
        result = image.convert('RGBA')
        result.putalpha(alpha)
        return _stamp_local_mock(result, tool)
    elif tool == 'colorize':
        gray = ImageOps.grayscale(image)
        result = ImageOps.colorize(gray, black='#26384F', white='#F5D57A')
    else:  # emotion
        result = ImageEnhance.Color(ImageEnhance.Contrast(image).enhance(1.18)).enhance(1.65)
    return _stamp_local_mock(result, tool)


def build_output(payload):
    """Return PNG bytes and safe dimensions/operation metadata for a JSON body."""
    if not isinstance(payload, dict):
        raise MockRequestError(400, 'Expected a JSON object.')

    director_wire, operation = _request_operation(payload)
    source = None
    source_size = None
    if isinstance(payload.get('image'), str):
        source, source_size = _decode_image_field(payload['image'])

    if director_wire is not None:
        if source is None:
            raise MockRequestError(400, 'Director requires a source image.')
        tool = DIRECTOR_TOOLS[director_wire]
        result = _director_result(source, tool)
    else:
        width, height = _requested_dimensions(payload, source_size)
        if source is None:
            result = _fixture_image().resize((width, height), _RESAMPLE)
        else:
            result = source.resize((width, height), _RESAMPLE)
            result = ImageEnhance.Color(result).enhance(1.16)
            result = ImageEnhance.Contrast(result).enhance(1.04)
            result = ImageEnhance.Sharpness(result).enhance(1.08)

    output_size = result.size
    _validate_dimensions(*output_size, output=director_wire is None)
    return _encode_png(result), source_size, output_size, operation


class ProcessingReport:
    """Persist only allowlisted request metadata, never body/header contents."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.counts = Counter()

    def reset(self):
        with self.lock:
            self.counts.clear()
            self._write_locked()

    def record(self, path, source_size, output_size, operation):
        source_width, source_height = source_size or (None, None)
        width, height = output_size
        key = ('POST', path, source_width, source_height, width, height, operation)
        with self.lock:
            self.counts[key] += 1
            self._write_locked()

    def _write_locked(self):
        rows = [
            {
                'method': method,
                'path': path,
                'input_width': input_width,
                'input_height': input_height,
                'output_width': output_width,
                'output_height': output_height,
                'operation': operation,
                'count': count,
            }
            for (method, path, input_width, input_height, output_width, output_height, operation), count
            in sorted(self.counts.items(), key=lambda item: str(item[0]))
        ]
        temporary = self.path.with_name(self.path.name + '.tmp')
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps(rows, indent=2), encoding='utf-8')
            os.replace(temporary, self.path)
        except OSError:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


REPORT = ProcessingReport(REPORT_PATH)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log prompts, headers, tokens, paths, or image payloads.

    def cors(self):
        self.send_header('Access-Control-Allow-Origin', 'http://127.0.0.1:5080')
        self.send_header('Access-Control-Allow-Headers', 'authorization,content-type')
        self.send_header('Access-Control-Allow-Methods', 'POST,OPTIONS')

    def _send_json(self, status, payload):
        response = json.dumps(payload, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _read_body(self):
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except (TypeError, ValueError):
            raise MockRequestError(400, 'Invalid content length.') from None
        if size < 0:
            raise MockRequestError(400, 'Invalid content length.')
        if size > MAX_REQUEST_BYTES:
            raise MockRequestError(413, 'Request exceeds the mock limit.')
        body = self.rfile.read(size)
        if len(body) != size:
            raise MockRequestError(400, 'Incomplete request body.')
        return body

    def do_POST(self):
        route = self.path.split('?', 1)[0]
        if route not in JSON_ROUTES:
            self._send_json(404, {'error': {'message': 'Unknown mock route.'}})
            return

        try:
            body = self._read_body()
            content_type = self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
            if content_type != 'application/json':
                # Keep the existing multipart-compatible edits route behavior.
                payload = {}
                operation = 'edits' if route.endswith('/edits') else 'generate'
                png = _encode_png(_fixture_image())
                source_size = None
                output_size = (832, 1216)
            else:
                try:
                    payload = json.loads(body)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    raise MockRequestError(400, 'Invalid JSON request.') from None
                png, source_size, output_size, operation = build_output(payload)

            response = json.dumps(
                {'data': [{'b64_json': base64.b64encode(png).decode('ascii')}]},
                separators=(',', ':'),
            ).encode('utf-8')
            if len(response) > MAX_REQUEST_BYTES:
                raise MockRequestError(413, 'Mock response exceeds the image-size limit.')
            REPORT.record(route, source_size, output_size, operation)
            self.send_response(200)
            self.cors()
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response)))
            self.end_headers()
            self.wfile.write(response)
        except MockRequestError as error:
            self._send_json(error.status, {'error': {'message': str(error)}})
        except Exception:
            # Do not expose implementation details or request data to the client/log.
            self._send_json(500, {'error': {'message': 'Mock image processing failed.'}})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5090)
    args = parser.parse_args()
    REPORT.reset()
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
