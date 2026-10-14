"""Loopback-only assistant attachment + local SR fixture for native Windows QA.

Uses synthetic pixels and a non-LLM deterministic protocol. Never forwards
requests. Invoke --prepare before launching the app in the returned directory.
"""
import argparse
import hashlib
import http.server
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw
from importlib.util import spec_from_file_location, module_from_spec

ROOT = Path(__file__).resolve().parent.parent
PORT = 5121
TEMP = ROOT / '.tmp'
QA_DIR = TEMP / 'assistant-images-native-qa'
LOG = TEMP / 'assistant-images-native-requests.jsonl'


def confined(path):
    path = path.resolve()
    if not path.is_relative_to(TEMP.resolve()) or not TEMP.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError('QA files must stay inside PC/.tmp')
    return path


def prepare():
    fixture = json.loads(confined(TEMP / 'assistant-images-native-fixture.json').read_text(encoding='utf-8'))
    image = Image.new('RGB', (64, 64), '#223344')
    draw = ImageDraw.Draw(image)
    draw.ellipse((10, 10, 54, 54), fill='#f5d57a')
    draw.rectangle((25, 0, 38, 64), fill='#65bba3')
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    png = stream.getvalue()
    digest = hashlib.sha256(png).hexdigest()
    ref = f'sha256/{digest[:2]}/{digest}.png'
    entry = dict(fixture['gallery'][0])
    entry.update(id='import-native-fixture', title='本地超分合成源图', prompt='synthetic geometry', negative='',
                 width=64, height=64, seed=0, favorite=False, isDemo=False, assetRef=ref, model='imported',
                 parameters=None, editMetadata=None, provider='合成测试', createdAt=None)
    fixture['gallery'] = [entry]
    fixture['selectedId'] = entry['id']
    state = fixture['assistant']
    state['providers'] = [dict(id='native-loopback', name='本机模拟服务', baseUrl=f'http://127.0.0.1:{PORT}/v1',
                               model='synthetic', streaming=False, requireKey=False)]
    state['mainProviderId'] = 'native-loopback'
    state['visionProviderId'] = None
    state['wdTagger'].update(enabled=True, baseUrl=f'http://127.0.0.1:{PORT}')
    current = next(s for s in state['sessions'] if s['id'] == state['activeSessionId'])
    current.update(title='附图分析与本地超分验收', input='分析附图，然后将图库中的合成源图本地放大2倍。', attachments=[ref], turns=[])
    path = confined(TEMP / 'assistant-images-native-prepared.json')
    path.write_text(json.dumps(fixture, ensure_ascii=False), encoding='utf-8')
    spec = spec_from_file_location('fixture_helper', ROOT / 'scripts/tag-agent-qa-mock.py')
    helper = module_from_spec(spec)
    spec.loader.exec_module(helper)
    helper.prepare_fixture(str(path), str(confined(QA_DIR)))
    asset = confined(QA_DIR / 'image_assets' / ref)
    asset.parent.mkdir(parents=True, exist_ok=True)
    asset.write_bytes(png)
    print(json.dumps({'dataDir': str(QA_DIR), 'sourceSha256': digest}, ensure_ascii=False))


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, body, status=200, content_type='application/json'):
        data = body.encode() if isinstance(body, str) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        if self.client_address[0] != '127.0.0.1' or not 0 < length <= 2 * 1024 * 1024 or self.headers.get('Authorization'):
            self.reply({'error': 'invalid synthetic request'}, 400)
            return
        body = self.rfile.read(length)
        with confined(LOG).open('a', encoding='utf-8') as out:
            out.write(json.dumps({'method': 'POST', 'path': self.path, 'bytes': length}) + '\n')
        if self.path == '/gradio_api/upload':
            self.reply(['/tmp/synthetic.png'])
        elif self.path == '/gradio_api/call/predict':
            self.reply({'event_id': 'synthetic'})
        elif self.path == '/v1/chat/completions':
            request = json.loads(body)
            messages = request['messages']
            last_user = max(i for i, m in enumerate(messages) if m['role'] == 'user')
            returned = [m for m in messages[last_user+1:] if m['role'] == 'tool']
            if not returned:
                name, args = 'read_gallery', {}
            elif len(returned) == 1:
                name, args = 'upscale_image', {'image_id': 'import-native-fixture', 'preset': 'realcuganConservative2x'}
            else:
                result = json.loads(returned[-1]['content'])
                content = ('本机模拟模型：已收到本地超分结果，派生图片已保存到图库。' if result.get('ok') else
                           '本机模拟模型：工具未成功执行，请查看工具记录。')
                self.reply({'choices': [{'message': {'role': 'assistant', 'content': content}, 'finish_reason': 'stop'}]})
                return
            self.reply({'choices': [{'message': {'role': 'assistant', 'content': None, 'tool_calls': [
                {'id': f'native-{len(returned)}', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}
            ]}, 'finish_reason': 'tool_calls'}]})
        else:
            self.reply({'error': 'not found'}, 404)

    def do_GET(self):
        if self.path != '/gradio_api/call/predict/synthetic':
            self.reply({'error': 'not found'}, 404)
            return
        with confined(LOG).open('a', encoding='utf-8') as out:
            out.write(json.dumps({'method': 'GET', 'path': self.path}) + '\n')
        label = {'label': 'geometric shapes', 'confidences': [{'label': 'geometric shapes', 'confidence': .99}]}
        output = ['geometric shapes', {}, {}, label]
        self.reply('event: complete\ndata: ' + json.dumps(output) + '\n\n', content_type='text/event-stream')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepare', action='store_true')
    args = parser.parse_args()
    if args.prepare:
        prepare()
    else:
        http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
