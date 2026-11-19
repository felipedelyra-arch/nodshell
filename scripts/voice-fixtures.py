"""Synthesizes tests/fixtures/voice/phrases.json with Piper: <id>.wav (clean) and <id>.pad.wav (0.4 s lead, 0.6 s tail, low noise). 16 kHz mono 16-bit."""
import json, sys, wave
from pathlib import Path
import numpy as np
from piper import PiperVoice

out, model = Path(sys.argv[1]), sys.argv[2]
voice = PiperVoice.load(model)
rng = np.random.default_rng(42)  # fixed seed: same noise every run
RATE = 16000

def resample(x, src):
    if src == RATE:
        return x
    n = int(len(x) * RATE / src)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)

def save(path, x):
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(np.clip(x, -32768, 32767).astype('<i2').tobytes())

for p in json.loads((out / 'phrases.json').read_text()):
    chunks = list(voice.synthesize(p['text']))
    src = chunks[0].sample_rate
    x = resample(np.concatenate([c.audio_float_array for c in chunks]) * 32767, src)
    save(out / f"{p['id']}.wav", x)
    pad = np.concatenate([np.zeros(int(.4 * RATE)), x, np.zeros(int(.6 * RATE))])
    save(out / f"{p['id']}.pad.wav", pad + rng.normal(0, 40, len(pad)))  # about -58 dBFS noise
    print(p['id'], round(len(x) / RATE, 1), 's')
