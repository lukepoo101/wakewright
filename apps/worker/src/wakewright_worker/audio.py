"""Clips as the worker sees them: 16 kHz mono PCM16 WAV, about 3 s long."""

from __future__ import annotations

import io
import wave
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

SAMPLE_RATE = 16_000
MAX_SECONDS = 30


class InvalidAudio(ValueError):
    """The audio is not a 16 kHz mono PCM16 WAV the judges can read."""


@dataclass(frozen=True)
class Clip:
    """One clip to judge: its wake word (as the parent names it) and samples."""

    wake_word: str
    samples: npt.NDArray[np.int16]

    @property
    def pcm(self) -> bytes:
        return self.samples.astype("<i2").tobytes()

    @property
    def seconds(self) -> float:
        return len(self.samples) / SAMPLE_RATE

    def float32(self) -> npt.NDArray[np.float32]:
        """Samples scaled to [-1, 1), as speech-to-text models expect."""
        return self.samples.astype(np.float32) / 32768.0


def read_wav(data: bytes) -> npt.NDArray[np.int16]:
    """Decode a WAV file into int16 samples, refusing anything but 16 kHz
    mono PCM16 (the parent stores only that; resampling would hide a bug)."""
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            channels, width, rate, frames = (
                w.getnchannels(),
                w.getsampwidth(),
                w.getframerate(),
                w.getnframes(),
            )
            if (channels, width, rate) != (1, 2, SAMPLE_RATE):
                raise InvalidAudio(
                    f"expected 16 kHz mono 16-bit PCM, got {rate} Hz, {channels} channel(s), "
                    f"{8 * width}-bit"
                )
            if frames > MAX_SECONDS * SAMPLE_RATE:
                raise InvalidAudio(f"clip is longer than {MAX_SECONDS} s")
            pcm = w.readframes(frames)
    except (wave.Error, EOFError) as e:
        raise InvalidAudio(f"not a readable WAV file: {e}") from None
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.int16)
    if len(samples) == 0:
        raise InvalidAudio("the clip has no audio")
    return samples


def write_wav(samples: npt.NDArray[np.int16]) -> bytes:
    """Encode int16 samples as a 16 kHz mono WAV (for tests and the self-test)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(samples.astype("<i2").tobytes())
    return buf.getvalue()


def silence(seconds: float = 3.0) -> npt.NDArray[np.int16]:
    return np.zeros(round(seconds * SAMPLE_RATE), dtype=np.int16)


def noise(seconds: float = 3.0, level: float = 0.05, seed: int = 0) -> npt.NDArray[np.int16]:
    """White noise at `level` of full scale: reproducible, never speech."""
    rng = np.random.default_rng(seed)
    x = rng.normal(0.0, level, round(seconds * SAMPLE_RATE)).clip(-1, 1)
    return (x * 32767).astype(np.int16)


def tone(seconds: float = 3.0, hz: float = 440.0, level: float = 0.3) -> npt.NDArray[np.int16]:
    t = np.arange(round(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return (np.sin(2 * np.pi * hz * t) * level * 32767).astype(np.int16)
