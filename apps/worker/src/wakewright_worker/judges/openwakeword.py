"""openWakeWord pretrained models, run with onnxruntime only.

The `openwakeword` package itself is not used: its last release (0.6.0,
February 2024) needs `tflite-runtime` on Linux, which has no Python 3.13
wheels. Its inference is three small ONNX models, reproduced here exactly as
`openwakeword.Model.predict_clip` runs them (checked score for score against
openwakeword 0.6.0):

1. 1 s of silence is added before and after the clip, and the audio is fed
   in 80 ms chunks (1280 samples); a trailing partial chunk is dropped.
2. Each chunk's melspectrogram is computed over the chunk plus the 480
   samples before it (8 frames of 32 bins), scaled as `x / 10 + 2`.
3. Every chunk, the last 76 frames go through the embedding model (96
   values); the wake word model scores the last 16 embeddings.

Computing the melspectrogram of the whole clip at once looks equivalent but
is not: it shifts scores by up to 0.3 on real clips. The score is the
clip's maximum; the verdict is yes at 0.5 or above, openWakeWord's default.
"""

from __future__ import annotations

import numpy as np
import numpy.typing as npt
import onnxruntime as ort

from wakewright_worker.audio import Clip
from wakewright_worker.judges import (
    JudgeResult,
    JudgeType,
    Kind,
    Settings,
    no_model,
    normalise_wake_word,
)
from wakewright_worker.models import ModelCache, ModelFile

RELEASE = "v0.5.1"
# Bump when the inference below changes in a way that can change a score.
LOGIC = 1
THRESHOLD = 0.5
CHUNK = 1280
MEL_CONTEXT = 480
MEL_FRAMES = 76
EMBEDDINGS = 16
PAD = 16_000

_BASE = f"https://github.com/dscripka/openWakeWord/releases/download/{RELEASE}"


def _file(name: str, sha256: str, size: int) -> ModelFile:
    return ModelFile("openwakeword", RELEASE, name, f"{_BASE}/{name}", sha256, size)


MELSPECTROGRAM = _file(
    "melspectrogram.onnx",
    "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
    1087958,
)
EMBEDDING = _file(
    "embedding_model.onnx",
    "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
    1326578,
)
WAKE_WORDS: dict[str, ModelFile] = {
    "alexa": _file(
        "alexa_v0.1.onnx",
        "6ff566a01d12670e8d9e3c59da32651db1575d17272a601b7f8a39283dfbae3e",
        854246,
    ),
    "hey jarvis": _file(
        "hey_jarvis_v0.1.onnx",
        "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb",
        1271370,
    ),
    "hey mycroft": _file(
        "hey_mycroft_v0.1.onnx",
        "c2a311e8fa1338de89c31b3b46dc4dffd4af2f9a8d6ddead48893c2d301b1f18",
        857691,
    ),
    "hey rhasspy": _file(
        "hey_rhasspy_v0.1.onnx",
        "5a9b3ed3be2910e35780e097905aa9f35a9c10038df47914cf2b3ec4d670f6ea",
        204081,
    ),
}


def _session(path: str) -> ort.InferenceSession:
    # The models are tiny: one thread is faster than the pool's overhead.
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    return ort.InferenceSession(path, options, providers=["CPUExecutionProvider"])


class OpenWakeWordJudge(JudgeType):
    id = "openwakeword"
    name = "openWakeWord"
    kind: Kind = "wake_word_model"
    description = (
        "openWakeWord's pretrained models (alexa, hey jarvis, hey mycroft, hey rhasspy) on this "
        "worker. Verdict yes at a score of 0.5 or more."
    )
    version = f"{RELEASE}+{LOGIC}"
    wake_words: frozenset[str] | None = frozenset(WAKE_WORDS)

    def __init__(self, cache: ModelCache) -> None:
        self._cache = cache
        self._mel: ort.InferenceSession | None = None
        self._embedding: ort.InferenceSession | None = None
        self._models: dict[str, ort.InferenceSession] = {}

    def model_files(self) -> list[ModelFile]:
        return [MELSPECTROGRAM, EMBEDDING, *WAKE_WORDS.values()]

    def prepare(self) -> None:
        paths = self._cache.ensure_all(self.model_files())
        self._mel = _session(str(paths[0]))
        self._embedding = _session(str(paths[1]))
        self._models = {
            word: _session(str(path)) for word, path in zip(WAKE_WORDS, paths[2:], strict=True)
        }

    def judge(self, clip: Clip, settings: Settings) -> JudgeResult:
        word = normalise_wake_word(clip.wake_word)
        model = self._models.get(word)
        if model is None:
            if not self._models:
                raise RuntimeError("openwakeword judge used before prepare()")
            return no_model(self.name, clip.wake_word, frozenset(WAKE_WORDS))
        score = self.score(clip.samples, model)
        return JudgeResult(
            verdict="yes" if score >= THRESHOLD else "no",
            score=round(score, 4),
            threshold=THRESHOLD,
        )

    def score(self, samples: npt.NDArray[np.int16], model: ort.InferenceSession) -> float:
        assert self._mel is not None
        assert self._embedding is not None
        mel, embedding = self._mel, self._embedding
        model_input = model.get_inputs()[0].name
        audio = np.concatenate([np.zeros(PAD, np.int16), samples, np.zeros(PAD, np.int16)]).astype(
            np.float32
        )
        frames = np.ones((MEL_FRAMES, 32), np.float32)
        features: list[npt.NDArray[np.float32]] = []
        best = 0.0
        for k in range(len(audio) // CHUNK):
            start = max(0, k * CHUNK - MEL_CONTEXT)
            chunk = audio[start : (k + 1) * CHUNK]
            spec = _run(mel, chunk[None, :]).reshape(-1, 32) / 10 + 2
            frames = np.vstack([frames, spec.astype(np.float32)])[-MEL_FRAMES:]
            features.append(_run(embedding, frames[None, :, :, None]).reshape(96))
            if len(features) >= EMBEDDINGS:
                window = np.stack(features[-EMBEDDINGS:])[None]
                best = max(best, float(_run(model, window, model_input).item()))
        return best


def _run(
    session: ort.InferenceSession, x: npt.NDArray[np.float32], name: str | None = None
) -> npt.NDArray[np.float32]:
    out = session.run(None, {name or session.get_inputs()[0].name: x.astype(np.float32)})
    return np.asarray(out[0], dtype=np.float32)
