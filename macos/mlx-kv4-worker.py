"""Start the official local MLX server with the long-context test settings."""

import sys
from pathlib import Path

import mlx.core as mx
from mlx_lm import server


class BoundedResponseGenerator(server.ResponseGenerator):
    def _tokenize(self, tokenizer, request, args):
        result = super()._tokenize(tokenizer, request, args)
        if len(result[0]) + args.max_tokens > 131072:
            raise ValueError('Prompt and reserved response exceed the 131072-token context.')
        return result


server.ResponseGenerator = BoundedResponseGenerator
model = Path(__file__).resolve().parent / 'huihui-qwen38/mlx'
mx.set_cache_limit(512 * 1024**2)
sys.argv = [sys.argv[0], '--host', '127.0.0.1', '--port', sys.argv[1], '--model', str(model.resolve()),
            '--kv-bits', '4', '--kv-group-size', '64', '--quantized-kv-start', '0',
            '--prefill-step-size', '512', '--prompt-cache-size', '1',
            '--prompt-concurrency', '1', '--decode-concurrency', '1',
            '--chat-template-args', '{"enable_thinking":false}']
server.main()
