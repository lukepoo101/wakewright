# Judges

A judge answers one question about a clip: does it contain its wake word?
Wakewright asks several judges and combines their weighted votes into an
outcome for each clip. This page explains the outcome, how to set judges
up on the Judges page, and how to write a new kind of judge. The
decision behind it is [ADR 0019](adr/0019-configurable-weighted-judges.md).

## Judge types and judges

- A **judge type** is code in the worker that can judge a clip: a wake word
  model (openWakeWord, microWakeWord) or a speech-to-text backend
  (Parakeet on the worker's CPU, any OpenAI-compatible transcription API,
  ElevenLabs Scribe). Each worker advertises the types it offers, with a
  description of their settings.
- A **judge** is what you set up on the Judges page: a name, a type, that
  type's settings (for example a model and an API key), a weight, an
  optional daily limit and an on/off switch. You can have several judges
  of one type, for example two cloud models.

The three judges every earlier release ran are set up for you: Speech to
text (Parakeet, weight 1.0), openWakeWord (0.3) and microWakeWord (0.3).

## How the outcome is decided

Each judge's latest answer on a clip counts once:

1. A judge that answers **yes** votes +1 times its weight, **no** votes −1
   times its weight. A judge that cannot tell (no model for the wake word,
   unusable audio) does not vote. A judge that is off, deleted or has
   weight 0 does not count, but its answer stays visible on the clip page.
2. The **score** is the sum of the votes divided by the weight that voted,
   from −1 (all no) to +1 (all yes).
3. The **outcome** is:

   | Outcome                 | When                                                                                            |
   | ----------------------- | ----------------------------------------------------------------------------------------------- |
   | **Waiting**             | a judge that counts and can run now has not answered (the score so far is shown as provisional) |
   | **Not enough evidence** | less weight than the **minimum** voted                                                          |
   | **Yes**                 | the score is at least the **margin**                                                            |
   | **No**                  | the score is at most minus the margin                                                           |
   | **Uncertain**           | anything in between                                                                             |

The defaults are a margin of **0.5** and a minimum of **1.0**, the weight
of one speech-to-text judge. With the default weights:

| Speech to text | openWakeWord | microWakeWord | Score                   | Outcome             |
| -------------- | ------------ | ------------- | ----------------------- | ------------------- |
| yes            | yes          | yes           | +1.00                   | Yes                 |
| yes            | no           | no            | (1 − 0.6) / 1.6 = +0.25 | Uncertain           |
| yes            | no           | can't tell    | (1 − 0.3) / 1.3 = +0.54 | Yes                 |
| can't tell     | yes          | yes           | +1.00, 0.6 voted        | Not enough evidence |
| no             | yes          | yes           | −0.25                   | Uncertain           |

The **confidence** shown beside an outcome ("Yes · 77%") is the share of the
voting weight on the outcome's side. **A judge dissents** when it counts
and voted against a yes or no outcome; the clip list can filter for those.
A clip whose outcome is against the device is a **likely false wake** (the
device woke up, the outcome is no) or a **likely missed wake word** (a near
miss the outcome says yes to).

Outcomes are computed when they are read, so changing a weight, the margin
or the minimum changes every outcome at once and judges nothing again.

"Can run now" means a connected worker (or one seen in the last day) offers
the judge's type and may run it, the judge is not paused after a failure
and is not at its daily limit. A broken or rate-limited judge therefore
never leaves clips waiting: their outcome comes from the others until it
recovers.

## Setting judges up

On the **Judges** page:

- **Add judge** lists the types your workers offer. The form comes from the
  type: settings marked † can change verdicts, so changing them later
  judges every clip again with that judge; the name, weight, daily limit,
  an API key and a timeout change nothing already judged.
- A judge whose type is marked **Sends clips to a third party** uploads each
  clip it judges to that service. It starts off; turning it on asks you to
  confirm. See [privacy](privacy.md).
- **Secret settings** (API keys) are stored encrypted with the instance key,
  as device passwords are ([configuration](configuration.md#the-secret-key)),
  never shown again and never logged. The form shows "Set" with **Replace**
  and **Remove**. A key is sent only to a worker that may run the judge's
  type, inside the job.
- The **daily limit** caps how many clips a judge runs on in any 24 hours,
  newest clips first, so a free tier is never exceeded. Failed attempts
  count too.
- **Test** runs the judge on one stored clip through a worker, even while it
  is off, and shows what it said. The verdict is kept like any other.
- **Delete** stops it running and counting; its verdicts stay on each clip,
  marked as from a deleted judge, and its secrets are removed.
- The **Workers** page limits which judge types each worker may run, so a
  cloud judge can be kept to one worker.

### When a judge fails

A judge can answer yes, no, **can't tell** (recorded, not retried) or
**fail for now** (nothing recorded). A failure pauses the judge and shows
why on its card:

| Failure                      | Shown as                      | Tried again                                         |
| ---------------------------- | ----------------------------- | --------------------------------------------------- |
| refused key (401, 403)       | Failing: invalid API key      | after 15 minutes, doubling to 6 hours               |
| quota used up                | Paused until the quota resets | when the service says, else 1 hour doubling         |
| rate limited (429)           | Rate limited                  | when the service says, else 30 s doubling to 15 min |
| network, timeout, 5xx        | Failing: … ; next try at …    | 30 s doubling to 30 minutes                         |
| wrong address or model (404) | Failing: not found …          | 2 minutes doubling to 1 hour                        |

Saving new settings or turning the judge on again tries it at once. A clip
that keeps failing on its own while others work is given up on with a
"can't tell" after five attempts.

## The cloud speech-to-text types

| Type                                                  | Settings                                                           | Notes                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI-compatible transcription (`openai-compatible`) | API base URL, API key (optional), model, language, prompt, timeout | `POST {base}/audio/transcriptions`; works with OpenAI, Groq, a LiteLLM proxy and self-hosted Whisper servers                          |
| ElevenLabs Scribe (`elevenlabs`)                      | API key, model (default `scribe_v3`), language, timeout            | `POST https://api.elevenlabs.io/v1/speech-to-text` with `xi-api-key`; audio events are not tagged, and any that come back never match |

Neither offers keyword or keyterm biasing: steering a model towards the wake
word makes it hear the wake word in clips without it, which is what a judge
must not do. The OpenAI-compatible prompt is free text, for spelling
hints; use it with care for the same reason.

All speech-to-text types decide the same way: yes when the transcript,
lowercased with punctuation removed, contains the wake word as whole words
(`judges/speech.py`).

## Write a judge type

Judge types are Python classes in the worker (`apps/worker`), registered in
`src/wakewright_worker/judges/registry.py`. The parent needs no change: it
shows the type, renders its settings form, validates the settings and
stores secrets from what the worker advertises.

The interface (`judges/__init__.py`):

```python
class JudgeType(ABC):
    id: str                 # stable, a-z 0-9 _ . -; verdicts are kept under it
    name: str               # shown on the Judges page
    kind: Kind              # "wake_word_model" or "speech_to_text"
    version: str            # change it when a verdict could change
    description: str = ""
    external: bool = False  # True if it sends audio off the worker
    settings: tuple[Setting, ...] = ()
    wake_words: frozenset[str] | None = None   # None: any wake word

    def model_files(self) -> list[ModelFile]: ...   # for download-models
    def prepare(self) -> None: ...                  # load models once
    @abstractmethod
    def judge(self, clip: Clip, settings: Settings) -> JudgeResult: ...
```

`judge` returns `JudgeResult("yes" | "no" | "abstain", score=, threshold=,
transcript=, detail=)`, or raises `TemporaryFailure(message, reason=,
retry_after=)` when it cannot answer now (`reason` is `auth`, `rate_limit`,
`quota`, `network`, `server` or `other`). Never put a secret in a message.
Any other exception becomes an abstention for that clip.

A `Setting` is `Setting(key, label, type="text" | "secret" | "number" |
"select" | "boolean", help=, default=, required=, options=, minimum=,
maximum=, placeholder=, affects_verdict=)`. Secrets never affect the
verdict; set `affects_verdict=False` on anything else that cannot (a
timeout).

### A speech-to-text provider in one file

A speech-to-text type implements only `transcribe` on top of
`SpeechToTextJudge`, which turns the transcript into the verdict.
`judges/http.py` uploads the clip and maps every HTTP failure to the right
outcome. This is the ElevenLabs type, shortened (`judges/elevenlabs.py`):

```python
from wakewright_worker.audio import Clip
from wakewright_worker.judges import Setting, Settings, TemporaryFailure, text_setting
from wakewright_worker.judges.http import upload
from wakewright_worker.judges.speech import SpeechToTextJudge


class ElevenLabsJudge(SpeechToTextJudge):
    id = "elevenlabs"
    name = "ElevenLabs Scribe"
    version = "elevenlabs+1"
    external = True
    settings = (
        Setting("api_key", "API key", type="secret", required=True),
        Setting("model", "Model", default="scribe_v3", required=True),
        Setting("language", "Language", help="Optional, such as en."),
    )

    def transcribe(self, clip: Clip, settings: Settings) -> str:
        key = text_setting(settings, "api_key")
        if not key:
            raise TemporaryFailure("no API key", reason="auth")
        data = {"model_id": text_setting(settings, "model"), "tag_audio_events": "false"}
        if language := text_setting(settings, "language"):
            data["language_code"] = language
        body = upload(
            "https://api.elevenlabs.io/v1/speech-to-text", clip,
            key=key, headers={"xi-api-key": key}, data=data, timeout=30,
        )
        return str(body.get("text") or "")
```

Steps:

1. Write `src/wakewright_worker/judges/<provider>.py` like the above. Keep
   the type's `id` stable; start `version` at `<id>+1` and bump it when
   the request or parsing changes.
2. Add a factory to `BUILTIN` in `judges/registry.py` and the id to
   `JUDGE_NAMES` in `config.py` (a test checks they match).
3. Test it against a local fake HTTP server, as `tests/test_cloud.py` does:
   the request it sends, a yes and a no, each failure status, and that the
   key never appears in a message. No test may reach the network.
4. Add a row to the table above and, for a new external service, a line to
   [privacy](privacy.md).

A third-party package could add types the same way; the registry is a plain
mapping so that a later release can extend it from Python entry points.

A worker written in another language advertises types and returns results
as [the worker protocol](workers.md) describes.
