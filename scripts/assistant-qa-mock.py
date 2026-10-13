"""Loopback-only synthetic assistant service for manual Windows QA. No forwarding."""
import argparse
import json
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def prepare(root):
    fixture = json.loads((root / '.tmp/assistant-native-fixture.json').read_text('utf-8'))
    directory = root / '.tmp/assistant-native-qa'
    directory.mkdir(parents=True, exist_ok=True)
    database = directory / 'workspace.sqlite'
    if database.exists():
        raise SystemExit('Refusing to overwrite the existing QA database.')
    draft, gallery = fixture.pop('draft'), fixture.pop('gallery')
    with sqlite3.connect(database) as db:
        db.executescript('''
          CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>0));
          CREATE TABLE draft (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
          CREATE TABLE gallery (id TEXT PRIMARY KEY NOT NULL, ordinal INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL);
          CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id=1), extra_json TEXT NOT NULL);
          PRAGMA user_version=1;
          INSERT INTO meta VALUES(1,1);
        ''')
        db.execute('INSERT INTO draft VALUES(1,?)', (json.dumps(draft),))
        db.execute('INSERT INTO workspace VALUES(1,?)', (json.dumps(fixture),))
        for i, item in enumerate(gallery):
            db.execute('INSERT INTO gallery VALUES(?,?,?)', (item['id'], i, json.dumps(item)))
    print(database)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        messages = body['messages']
        start = max(i for i, m in enumerate(messages) if m['role'] == 'user')
        current = messages[start:]
        results = [m for m in current if m['role'] == 'tool']
        schemas = {t['function']['name']: t['function'] for t in body.get('tools', [])}
        diagnostic = 'diagnostic_echo' in schemas
        name, args = None, None
        if diagnostic and not results:
            name = 'diagnostic_echo'
            args = {'value': schemas[name]['parameters']['properties']['value']['enum'][0]}
        elif not diagnostic and len(results) == 0:
            name, args = 'read_current_prompts', {}
        elif not diagnostic and len(results) == 1:
            name, args = 'write_prompt', {'target': 'positive', 'mode': 'append', 'content': 'soft moonlight'}
        if name:
            assert name in schemas
        for result in results:
            prior = [call for m in current if m['role'] == 'assistant' for call in m.get('tool_calls', [])]
            assert result['tool_call_id'] in {call['id'] for call in prior}
            assert not json.loads(result['content']).get('error')
        if 'cancel' in str(current[0]['content']).lower():
            time.sleep(10)
        call_id = f'qa-{time.time_ns()}'
        content = '本地合成服务：工具调用和结果回传验证完成。' if diagnostic else '已通过工具读取当前提示词，并在确认后追加 soft moonlight。'
        entry = {'time': time.time(), 'stream': body.get('stream'), 'tool_choice': body.get('tool_choice'),
                 'advertised_tools': list(schemas), 'tool_results': len(results), 'response_tool': name,
                 'matching_call_ids': True, 'reasoning_replayed': any('reasoning_content' in m for m in current)}
        with (self.server.qa_root / '.tmp/assistant-native-requests.jsonl').open('a', encoding='utf-8') as log:
            log.write(json.dumps(entry, ensure_ascii=False) + '\n')
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.end_headers()
        def emit(delta, finish=None):
            item = {'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            self.wfile.write(('data: ' + json.dumps(item, ensure_ascii=False) + '\n\n').encode())
            self.wfile.flush()
        try:
            emit({'role': 'assistant', 'reasoning_content': 'synthetic-protocol-field'})
            if name:
                arguments = json.dumps(args, ensure_ascii=False)
                mid = len(arguments) // 2
                emit({'tool_calls': [{'index': 0, 'id': call_id, 'type': 'function', 'function': {'name': name, 'arguments': arguments[:mid]}}]})
                emit({'tool_calls': [{'index': 0, 'function': {'arguments': arguments[mid:]}}]})
                emit({}, 'tool_calls')
            else:
                for part in [content[:12], content[12:]]:
                    emit({'content': part})
                emit({}, 'stop')
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare', action='store_true')
    options = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    if options.prepare:
        prepare(root)
    else:
        server = ThreadingHTTPServer(('127.0.0.1', 5099), Handler)
        server.qa_root = root
        print('Synthetic local assistant on 127.0.0.1:5099', flush=True)
        server.serve_forever()
