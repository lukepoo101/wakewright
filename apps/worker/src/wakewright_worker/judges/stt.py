"""Speech-to-text: NVIDIA Parakeet TDT 0.6B v2 (English), ONNX, on CPU.

The ONNX export is istupakov/parakeet-tdt-0.6b-v2-onnx, run by onnx-asr.
Full precision, not int8: on ten real 3 s activations the int8 export
missed the wake word three times where the full-precision model heard it
every time. int8 is a quarter of the download (650 MB against 2.5 GB) but
no faster on a desktop CPU. The clip is transcribed as it is; adding
silence around it made Parakeet drop or invent words.

The verdict comes from the transcript as for every speech-to-text type
(speech.py).
"""

from __future__ import annotations

import onnx_asr
from onnx_asr.adapters import TextResultsAsrAdapter

from wakewright_worker.audio import SAMPLE_RATE, Clip
from wakewright_worker.judges import Settings
from wakewright_worker.judges.speech import SpeechToTextJudge
from wakewright_worker.models import ModelCache, ModelFile

REPO = "istupakov/parakeet-tdt-0.6b-v2-onnx"
REVISION = "0bbb45a3365852604aef28b538a8f066f4ccaa85"
MODEL = "nemo-parakeet-tdt-0.6b-v2"
# Bump when the matching or decoding below changes.
LOGIC = 1


def _file(name: str, sha256: str, size: int) -> ModelFile:
    url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}"
    return ModelFile("parakeet-tdt-0.6b-v2", REVISION[:12], name, url, sha256, size)


FILES = [
    _file("config.json", "666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466", 97),
    _file("vocab.txt", "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d", 9384),
    _file(
        "encoder-model.onnx",
        "3987bcd28175d829d12888a996a84e8f62a0e374d9ffd640662c1515adc679d3",
        41770866,
    ),
    _file(
        "encoder-model.onnx.data",
        "4dab7362d4874d85965045b1e41b2d61dd2cc0fb25671a7f6b3dc47bf120cc41",
        2435420160,
    ),
    _file(
        "decoder_joint-model.onnx",
        "cbb52a07bd70ab5b67f8439d4b3cd8704b18467b4430bcacb5adabe154b8d191",
        35792059,
    ),
]


class ParakeetJudge(SpeechToTextJudge):
    # "stt" for history: verdicts before judge types were recorded under it.
    id = "stt"
    name = "Parakeet speech to text"
    description = (
        "NVIDIA Parakeet TDT 0.6B v2 (English) on this worker's CPU. Clips stay on the worker. "
        "Needs about 2.5 GB of downloads and 3 GB of memory."
    )
    version = f"parakeet-tdt-0.6b-v2@{REVISION[:7]}+{LOGIC}"

    def __init__(self, cache: ModelCache) -> None:
        self._cache = cache
        self._model: TextResultsAsrAdapter | None = None

    def model_files(self) -> list[ModelFile]:
        return list(FILES)

    def prepare(self) -> None:
        paths = self._cache.ensure_all(FILES)
        self._model = onnx_asr.load_model(MODEL, paths[0].parent)

    def transcribe(self, clip: Clip, settings: Settings) -> str:
        if self._model is None:
            raise RuntimeError("stt judge used before prepare()")
        return str(self._model.recognize(clip.float32(), sample_rate=SAMPLE_RATE))
