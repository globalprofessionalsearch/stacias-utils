# MLX + Qwen 3.6 Setup

## Issue

Qwen 3.6 has built-in extended thinking/reasoning capabilities. By default, it outputs lengthy reasoning before the final answer, which breaks digester's scoring system that expects a single float.

## Solution

Disable thinking mode when starting the MLX server using `--chat-template-args`:

```bash
~/Documents/code/experiments/ollama/.venv/bin/mlx_lm.server \
  --model mlx-community/Qwen3.6-35B-A3B-4bit \
  --port 8099 \
  --chat-template-args '{"enable_thinking":false}'
```

This tells Qwen to skip the reasoning phase and output the answer directly.

## Alternative: Increase max_tokens

If you can't disable thinking mode, increase `max_tokens` in `scorer.py` from 10 to 500+ so the full reasoning chain completes and the number appears at the end. However, this is slower and uses more tokens per request.

## Testing

Verify direct output without reasoning:
```bash
curl -s http://localhost:8099/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "/Users/joe/models/qwen3.6-35b",
  "messages": [
    {"role": "system", "content": "Return ONLY a number between 0.0 and 1.0."},
    {"role": "user", "content": "Score this: test"}
  ],
  "temperature": 0.0,
  "max_tokens": 10
}' | python3 -c "import json, sys; d=json.load(sys.stdin); msg=d['choices'][0]['message']; print(msg.get('content') or msg.get('reasoning'))"
```

Should output just a number like `0.5`, not reasoning text.
