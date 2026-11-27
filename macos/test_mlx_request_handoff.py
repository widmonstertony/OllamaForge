import importlib.util
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location('mlx_service', Path(__file__).with_name('mlx-kv4-service.py'))
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class RequestHandoffTest(unittest.TestCase):
    def test_disconnected_inference_releases_a_waiting_request(self):
        started, cancelled = threading.Event(), threading.Event()

        class Worker(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if body['messages'][0]['content'] == 'first':
                    started.set()
                    cancelled.wait(8)
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        def serve(handler):
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            return server.server_port

        upstream, port = serve(Worker), serve(service.Handler)
        process = Mock()
        process.poll.return_value = None
        process.terminate.side_effect = cancelled.set

        def send(text):
            conn = HTTPConnection('127.0.0.1', port, timeout=8)
            conn.request('POST', '/v1/chat/completions', json.dumps({
                'model': service.MODEL, 'messages': [{'role': 'user', 'content': text}],
            }))
            return conn

        with patch.object(service, 'worker_port', return_value=upstream), patch.object(service, 'worker', process):
            first = send('first')
            self.addCleanup(first.close)
            self.assertTrue(started.wait(3))
            second = send('second')
            self.addCleanup(second.close)
            with ThreadPoolExecutor(max_workers=1) as pool:
                waiting = pool.submit(second.getresponse)
                self.assertFalse(cancelled.wait(0.4))
                self.assertFalse(waiting.done())
                first.close()
                self.assertTrue(cancelled.wait(3))
                self.assertEqual(waiting.result(timeout=4).status, 200)


if __name__ == '__main__':
    unittest.main()
