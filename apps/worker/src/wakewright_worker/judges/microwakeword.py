"""microWakeWord models from esphome/micro-wake-word-models, run with
pymicro-wakeword (OHF-Voice).

pymicro-wakeword runs the same TensorFlow Lite micro frontend
(pymicro-features) the models were trained with, in 10 ms steps, feeds the
model `stride` feature frames at a time as ESPHome does, and averages the
last `sliding_window_size` probabilities; the model fires when that average
is above the manifest's `probability_cutoff`. Both numbers come from the
model's own JSON manifest, downloaded with it.

The clip is followed by 0.5 s of silence, so a wake word that ends right at
the end of the clip (where devices stop recording) still fills the sliding
window. The score reported is the highest window average in the clip.

pymicro-wakeword's wheel also carries a few models of its own; they are not
used (the image build deletes them), so every model comes from one pinned,
verified source.
"""

from __future__ import annotations

import json
from pathlib import Path

from pymicro_wakeword import MicroWakeWord, MicroWakeWordFeatures

from wakewright_worker.audio import SAMPLE_RATE, Clip
from wakewright_worker.judges import JudgeResult, no_model, normalise_wake_word
from wakewright_worker.models import ModelCache, ModelFile

# esphome/micro-wake-word-models, models/v2, at this commit (2026-10-01).
COMMIT = "40ff33f57f8fc6ad71a75ef085abbf742495b225"
# Bump when the inference below changes in a way that can change a verdict.
LOGIC = 1
TRAILING_SILENCE = SAMPLE_RATE // 2

_BASE = f"https://raw.githubusercontent.com/esphome/micro-wake-word-models/{COMMIT}/models/v2"


def _file(name: str, sha256: str, size: int) -> ModelFile:
    return ModelFile("microwakeword", COMMIT[:12], name, f"{_BASE}/{name}", sha256, size)


# wake word -> (manifest, model)
WAKE_WORDS: dict[str, tuple[ModelFile, ModelFile]] = {
    "alexa": (
        _file(
            "alexa.json", "1d999798b35b1fe2606465b75ab840be51c1811d2909d5e620cefb6e96f8abd0", 377
        ),
        _file(
            "alexa.tflite",
            "9011a8155b04de858c48038529235cbc0e42e9fca05a55bf588cb80a653a723b",
            55856,
        ),
    ),
    "hey jarvis": (
        _file(
            "hey_jarvis.json",
            "b153867d818675d8abcc9dace474afe7f83551ae0d5a9b1d71a98681320185af",
            388,
        ),
        _file(
            "hey_jarvis.tflite",
            "21a7976add39ee24ec96c63d96b7aaa18e24d1d9824b963e451da8feb4b78b77",
            52272,
        ),
    ),
    "hey mycroft": (
        _file(
            "hey_mycroft.json",
            "57b2b06fe5fdbbe834a242fabc7af31e4194a550fc382b2c88636a6d62d0d57e",
            390,
        ),
        _file(
            "hey_mycroft.tflite",
            "c2a9b6ed51182db72e014781d5a4ece1929dc232a40b5b4be384f0295f0e1571",
            57248,
        ),
    ),
    "okay nabu": (
        _file(
            "okay_nabu.json",
            "6dd65604f70fe5ea9d1af73a7bf239529d1fbabc363807f45d2b22ce464ddbed",
            386,
        ),
        _file(
            "okay_nabu.tflite",
            "0689abe1912a95a3318a0d8cb2e67bad0cbcfe3e24dd6e050c75debddfb6f891",
            60264,
        ),
    ),
}


class MicroWakeWordJudge:
    name = "microwakeword"
    version = f"v2@{COMMIT[:7]}+{LOGIC}"
    wake_words: frozenset[str] = frozenset(WAKE_WORDS)

    def __init__(self, cache: ModelCache) -> None:
        self._cache = cache
        self._models: dict[str, MicroWakeWord] = {}

    def model_files(self) -> list[ModelFile]:
        return [f for pair in WAKE_WORDS.values() for f in pair]

    def prepare(self) -> None:
        models: dict[str, MicroWakeWord] = {}
        for word, (manifest, model) in WAKE_WORDS.items():
            manifest_path = self._cache.ensure(manifest)
            model_path = self._cache.ensure(model)
            config = json.loads(manifest_path.read_text(encoding="utf-8"))
            if Path(config["model"]).name != model.name:
                raise RuntimeError(f"{manifest.name} names {config['model']}, not {model.name}")
            # Both files share a source and revision, so one directory.
            assert model_path.parent == manifest_path.parent
            # from_config reads probability_cutoff and sliding_window_size from
            # the manifest and loads the TFLite library bundled in the wheel.
            models[word] = MicroWakeWord.from_config(manifest_path)
        self._models = models

    def judge(self, clip: Clip) -> JudgeResult:
        word = normalise_wake_word(clip.wake_word)
        model = self._models.get(word)
        if model is None:
            if not self._models:
                raise RuntimeError("microwakeword judge used before prepare()")
            return no_model(self.name, clip.wake_word, self.wake_words)
        model.reset()
        features = MicroWakeWordFeatures()
        best = 0.0
        fired = False
        for audio in (clip.pcm, bytes(2 * TRAILING_SILENCE)):
            for frame in features.process_streaming(audio):
                probability = model.process_streaming_prob(frame)
                if probability is None:
                    continue
                best = max(best, probability)
                fired = fired or probability > model.probability_cutoff
        return JudgeResult(
            verdict="yes" if fired else "no",
            score=round(best, 4),
            threshold=model.probability_cutoff,
        )
