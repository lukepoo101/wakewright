# Models

The worker's judges use the pretrained models below. **None of them is in
the repository or in any image.** Each is downloaded the first time the
worker needs it, from its upstream source, into the worker's cache
directory (`WAKEWRIGHT_WORKER__CACHE_DIR`; `/cache` in the image). Every
file is pinned to an immutable revision and checked against its size and
SHA-256 before it is used; a file that does not match is refused and not
kept. The pins are in `apps/worker/src/wakewright_worker/judges/`.

Downloading a model means you accept its licence. Wakewright does not
redistribute any of them.

| Judge           | Model                                                | Source (pinned revision)                                                                                          | Licence                                                                          | Download |
| --------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------- |
| `openwakeword`  | melspectrogram, embedding model                      | [dscripka/openWakeWord](https://github.com/dscripka/openWakeWord) release `v0.5.1`                                | CC BY-NC-SA 4.0 (non-commercial)                                                 | 2.4 MB   |
| `openwakeword`  | alexa, hey jarvis, hey mycroft, hey rhasspy (`v0.1`) | the same release                                                                                                  | CC BY-NC-SA 4.0 (non-commercial)                                                 | 3.2 MB   |
| `microwakeword` | alexa, hey jarvis, hey mycroft, okay nabu (v2)       | [esphome/micro-wake-word-models](https://github.com/esphome/micro-wake-word-models) commit `40ff33f`, `models/v2` | Apache-2.0                                                                       | 0.2 MB   |
| `stt`           | NVIDIA Parakeet TDT 0.6B v2, ONNX, full precision    | [istupakov/parakeet-tdt-0.6b-v2-onnx](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx) `0bbb45a`       | CC-BY-4.0 ([NVIDIA's model](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2)) | 2.5 GB   |

Notes on each licence, as checked on 2026-11-18:

- **openWakeWord**: the project's code is Apache-2.0, but its README states
  that all its pretrained models are CC BY-NC-SA 4.0 because of the data
  they were trained on. That covers the melspectrogram and embedding
  models too (the embedding model reimplements Google's Apache-2.0 speech
  embedding, but the files are published under the README's terms), so
  all are treated as CC BY-NC-SA 4.0: use them only non-commercially, and
  keep them out of anything you redistribute.
- **microWakeWord**: the repository's README and NOTICE state that
  Apache-2.0 covers the trained weights and their manifests. Wake word
  names may be third parties' trademarks; the models imply no affiliation.
- **Parakeet TDT 0.6B v2**: NVIDIA publishes the model under CC-BY-4.0
  (attribution); the ONNX export keeps that licence.

Libraries the worker runs them with are ordinary dependencies, all under
permissive licences checked by `apps/worker/scripts/check_licences.py`:
onnxruntime (MIT), onnx-asr (MIT), pymicro-wakeword and pymicro-features
(Apache-2.0, OHF-Voice). pymicro-wakeword's wheel carries a few
microWakeWord models of its own (Apache-2.0); the worker does not use them
and the image build deletes them.

## Caching and offline use

`wakewright-worker download-models` downloads everything the enabled judges
need and exits; `--verify` hashes the cached files again and replaces any
that changed. After that the worker starts without network access to the
model hosts. Without a warmed cache and without network, a judge that
cannot download its model is not offered to the parent and is retried with
backoff; the error names the file and the URL.

Changing a pin changes the judge's `version`, so the parent asks for every
clip to be judged again with the new model.
