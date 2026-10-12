"""Loopback-only image fixture for end-to-end UI validation; never proxies requests."""
import argparse
import base64
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageDraw


def fixture():
    image = Image.new('RGB', (832, 1216), '#101827')
    draw = ImageDraw.Draw(image)
    for y in range(1216):
        draw.line((0, y, 831, y), fill=(16+int(y/1216*20), 24+int(y/1216*26), 39+int(y/1216*30)))
    draw.ellipse((540, 150, 680, 290), fill='#F5D57A')
    draw.polygon([(0,750),(150,430),(355,775),(555,510),(832,860),(832,1216),(0,1216)], fill='#43586A')
    draw.polygon([(0,920),(260,650),(540,980),(720,740),(832,910),(832,1216),(0,1216)], fill='#243747')
    draw.rectangle((0,1030,832,1216),fill='#162A39')
    draw.text((34,40),'WORLDPAINTER / LOCAL MOCK',fill='#F5D57A')
    draw.text((34,62),'Image pipeline fixture - no external API',fill='#B2BCC8')
    buffer=io.BytesIO();image.save(buffer,format='PNG')
    return buffer.getvalue()


PNG = fixture()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log prompts, headers, tokens or image payloads.

    def cors(self):
        self.send_header('Access-Control-Allow-Origin', 'http://127.0.0.1:5080')
        self.send_header('Access-Control-Allow-Headers', 'authorization,content-type')
        self.send_header('Access-Control-Allow-Methods', 'POST,OPTIONS')

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()

    def do_POST(self):
        size=int(self.headers.get('Content-Length','0'))
        if size<0 or size>64*1024*1024:
            self.send_error(413);return
        self.rfile.read(size)
        if self.path not in ['/v1/images/generations','/v1/images/edits']:
            self.send_error(404);return
        response=json.dumps({'data':[{'b64_json':base64.b64encode(PNG).decode('ascii')}]}).encode()
        self.send_response(200);self.cors()
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(response)))
        self.end_headers();self.wfile.write(response)


if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=5090)
    args=parser.parse_args()
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
