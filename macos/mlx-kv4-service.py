"""Loopback adapter for Harness. Load the MLX worker on demand and unload when idle."""

import http.client
import json
import os
import select
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MODEL = 'huihui-qwen3.8-27b-abliterated-mlx-kv4-128k'
FALLBACK = 'huihui-qwen3.8-27b-abliterated-mlx-64k:latest'
HOST = '127.0.0.1'
PORT = 3081
WORKER_PORT = 3082
IDLE_SECONDS = 120
REQUEST = threading.Lock()
ADMISSIONS = threading.BoundedSemaphore(4)
worker = None
last_activity = time.monotonic()


def get_json(port, path):
    connection = http.client.HTTPConnection(HOST, port, timeout=2)
    try:
        connection.request('GET', path)
        response = connection.getresponse()
        return json.load(response) if response.status == 200 else None
    finally:
        connection.close()


def stop_worker():
    global worker
    if worker and worker.poll() is None:
        worker.terminate()
        try:
            worker.wait(timeout=10)
        except subprocess.TimeoutExpired:
            worker.kill()
            worker.wait()
    worker = None


def client_disconnected(peer):
    try:
        readable, _, _ = select.select([peer], [], [], 0)
        return bool(readable) and peer.recv(1, socket.MSG_PEEK) == b''
    except OSError:
        return True


def cancel_abandoned_inference(peer, process, finished):
    # Only this request owns the worker until the monitor has joined.
    while not finished.wait(0.25):
        if client_disconnected(peer):
            if process.poll() is None:
                process.terminate()
            return


def worker_port(peer):
    global worker
    if worker and worker.poll() is None:
        return WORKER_PORT
    if not (ROOT / 'huihui-qwen38/mlx/config.json').is_file():
        raise RuntimeError('Qwen weights are unavailable. Connect TonyBigDriv.')
    # Jarvis uses Ollama independently. Wait for its idle timeout without
    # stopping that model or interrupting any active automation.
    deadline = time.monotonic() + 360
    while time.monotonic() < deadline:
        if client_disconnected(peer):
            raise ConnectionAbortedError()
        try:
            ollama = get_json(11434, '/api/ps')
        except OSError:
            ollama = None
        if not (ollama and ollama.get('models')):
            break
        time.sleep(2)
    else:
        raise RuntimeError('Ollama is still busy or holding a model. Try again after the current task finishes.')
    with (ROOT / 'mlx-kv4-worker.log').open('a') as log:
        worker = subprocess.Popen([sys.executable, '-u', str(ROOT / 'mlx-kv4-worker.py'), str(WORKER_PORT)],
                                  env={**os.environ, 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'},
                                  stdout=log, stderr=subprocess.STDOUT)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline and worker.poll() is None:
        if client_disconnected(peer):
            stop_worker()
            raise ConnectionAbortedError()
        try:
            if get_json(WORKER_PORT, '/health') == {'status': 'ok'}:
                return WORKER_PORT
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(1)
    stop_worker()
    raise RuntimeError('MLX worker did not become ready; see mlx-kv4-worker.log.')


def ollama_port():
    try:
        if get_json(11434, '/api/version'):
            return 11434
    except OSError:
        pass
    subprocess.run(['/usr/bin/open', '-gj', '-a', 'Ollama'], check=True)
    for _ in range(30):
        try:
            if get_json(11434, '/api/version'):
                return 11434
        except OSError:
            pass
        time.sleep(1)
    raise RuntimeError('Ollama did not start for the 64K model.')


def unload_when_idle():
    while True:
        time.sleep(3)
        if REQUEST.acquire(blocking=False):
            try:
                if worker and time.monotonic() - last_activity >= IDLE_SECONDS:
                    stop_worker()
                    print('MLX worker unloaded after 120 seconds idle.', flush=True)
            finally:
                REQUEST.release()


class Handler(BaseHTTPRequestHandler):
    def json_response(self, status, body):
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path == '/health':
            self.json_response(200, {'service': 'ollamaforge-mlx-kv4', 'worker_loaded': bool(worker and worker.poll() is None)})
        elif self.path == '/v1/models':
            self.json_response(200, {'object': 'list', 'data': [
                {'id': MODEL, 'object': 'model', 'input_modalities': ['text']},
                {'id': FALLBACK, 'object': 'model', 'input_modalities': ['text', 'image']},
            ]})
        else:
            self.json_response(404, {'error': 'Unknown local endpoint.'})

    def do_POST(self):
        global last_activity
        if self.path != '/v1/chat/completions':
            self.json_response(404, {'error': 'Use /v1/chat/completions.'})
            return
        if self.headers.get('Origin'):
            self.json_response(403, {'error': 'This local API accepts local clients, not browser origins.'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4 * 1024**2:
                raise ValueError('Invalid request size.')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict) or body.get('model') not in (MODEL, FALLBACK):
                raise ValueError('Unknown local model.')
            messages = body.get('messages')
            if not isinstance(messages, list):
                raise ValueError('Chat messages must be a list.')
            if body['model'] == MODEL and any(
                isinstance(message, dict) and isinstance(message.get('content'), list)
                and any(isinstance(part, dict) and part.get('type') in ('image_url', 'input_image')
                        for part in message['content'])
                for message in messages
            ):
                raise ValueError('The 128K backend is text-only. Select the 64K vision model to read screenshots.')
        except ValueError as error:
            self.json_response(400, {'error': str(error)})
            return
        if not ADMISSIONS.acquire(blocking=False):
            self.json_response(429, {'error': 'The local inference queue is full.'})
            return
        try:
            deadline = time.monotonic() + 600
            while not REQUEST.acquire(timeout=0.25):
                if client_disconnected(self.connection):
                    return
                if time.monotonic() >= deadline:
                    self.json_response(503, {'error': 'Timed out waiting for local inference capacity.'})
                    return
            try:
                if not client_disconnected(self.connection):
                    self.forward(body)
            finally:
                last_activity = time.monotonic()
                REQUEST.release()
        finally:
            ADMISSIONS.release()

    def forward(self, body):
        connection = None
        sent_headers = False
        finished = threading.Event()
        monitor = None
        try:
            if body['model'] == MODEL:
                port = worker_port(self.connection)
                monitor = threading.Thread(target=cancel_abandoned_inference,
                                           args=(self.connection, worker, finished), daemon=True)
                monitor.start()
                body['model'] = 'default_model'
            else:
                stop_worker()
                port = ollama_port()
                body['keep_alive'] = '90s'
                body.setdefault('reasoning_effort', 'none')
            connection = http.client.HTTPConnection(HOST, port, timeout=2400)
            connection.request('POST', self.path, json.dumps(body), {'Content-Type': 'application/json'})
            reply = connection.getresponse()
            self.send_response(reply.status)
            self.send_header('Content-Type', reply.getheader('Content-Type', 'application/json'))
            self.end_headers()
            sent_headers = True
            while chunk := reply.read1(16384):
                self.wfile.write(chunk)
                self.wfile.flush()
        except (OSError, RuntimeError, subprocess.SubprocessError, http.client.HTTPException) as error:
            if client_disconnected(self.connection):
                if connection and connection.port == WORKER_PORT:
                    stop_worker()
            elif not sent_headers:
                self.json_response(503, {'error': str(error)})
            else:
                print(f'Inference stream ended: {error}', flush=True)
        finally:
            finished.set()
            if monitor:
                monitor.join()
            if connection:
                connection.close()


if __name__ == '__main__':
    def stop_service(signum, frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop_service)
    threading.Thread(target=unload_when_idle, daemon=True).start()
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    finally:
        stop_worker()
