# Judges

A judge answers one question about a clip: does it contain its wake word?
Wakewright asks several judges and combines their weighted votes into an
outcome for each clip. This page explains the outcome, how to set judges
up on the Judges page, and how to write a new kind of judge. The
decision behind it is [ADR 0019](adr/0019-configurable-weighted-judges.md).

## Judge types and judges

- A **judge type** is code in the worker that can judge a clip. It is one
  of three **kinds**:
  - a **wake word model** (openWakeWord, microWakeWord) scores the clip
    against a model of the wake word;
  - **speech to text** (Parakeet on the worker's CPU, any OpenAI-compatible
    transcription API, ElevenLabs Scribe) asks "what does this audio
    say?", then Wakewright checks the transcript for the wake word;
  - a **listening model** (Audio question, through any OpenAI-compatible
    chat API) asks a model that accepts audio "does someone in this audio
    say the wake word?" and takes its yes, no or unsure.

  Each worker advertises the types it offers, with a description of their
  settings.

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
of one speech-to-text judge (or of two listening judges). A new judge
starts at its kind's default weight: 1.0 for speech to text, 0.5 for a
listening model and 0.3 for a wake word model. With the default weights:

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
why on its card. The cloud types sort an error answer like this:

| Failure                                                                        | Shown as                      | Tried again                                         |
| ------------------------------------------------------------------------------ | ----------------------------- | --------------------------------------------------- |
| refused key (401, 403)                                                         | Failing: invalid API key      | after 15 minutes, doubling to 6 hours               |
| quota or credit used up (any 402; quota, billing or credit wording with a 4xx) | Paused until the quota resets | when the service says, else 1 hour doubling         |
| rate limited (429)                                                             | Rate limited                  | when the service says, else 30 s doubling to 15 min |
| network, timeout, 408, 425, 5xx                                                | Failing: … ; next try at …    | 30 s doubling to 30 minutes                         |
| wrong address or model (404), a refused setting, any other 4xx                 | Failing: …                    | 2 minutes doubling to 1 hour                        |
| the service would not take this clip (400, 413, 422)                           | can't tell (recorded)         | not retried                                         |

The rule for the cloud types: "can't tell" is recorded only when the fault
can be this clip. Anything about the account, the settings or the service
pauses the judge, so clips are never written off while credit runs out.

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

## The listening type

| Type                                                       | Settings                                                                | Notes                                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Audio question (OpenAI-compatible chat) (`audio-question`) | API base URL †, API key, model †, prompt †, reasoning effort †, timeout | `POST {base}/chat/completions` with the clip as an `input_audio` part; OpenAI's audio models, or Gemini through LiteLLM |

The request is one user message with two content parts: the clip,
`{"type": "input_audio", "input_audio": {"data": "<base64 WAV>", "format": "wav"}}`,
and the prompt as text. A LiteLLM proxy turns the audio part into inline
audio for Gemini. No temperature is sent. The model must answer with JSON:

```json
{ "said": "a few words on what it heard", "heard": "yes" }
```

- `heard` **yes** or **no** is the verdict; **unsure** is a "can't tell",
  with the model's note kept.
- `said` is stored where a transcript would be, and the clip page shows it
  as the model's note, not a transcript: it is the model's description,
  not a word-for-word record.
- The request asks for this JSON Schema as structured output
  (`response_format` of type `json_schema`). An endpoint that refuses it
  (a 400 or 422 naming `response_format`, a JSON schema or structured
  output) is asked again without it, and from then on, while the worker
  runs, always without it. Either way the answer is read leniently: in a
  code fence, with text around it, `heard` in any case.
- An answer that still cannot be read is a "can't tell" for that clip,
  with what came back. Three in a row from one judge's settings mean the
  model is not following the contract at all (the wrong model, or a
  prompt asking for something else), so after that the judge is paused
  ("Failing: the model's last 3 answers were not the JSON asked for") and
  clips are no longer written off, until an answer can be read again.
- **Reasoning effort** is sent as `reasoning_effort` only when set; "Leave
  to the model" sends nothing. A service that refuses the value (LiteLLM
  answers 400 "Invalid `reasoning_effort`") pauses the judge with its
  message. It can change answers, so changing it judges again.
- **Prompt**: empty uses the built-in prompt, which the form shows and can
  copy for you to edit. `{wake_word}` is replaced with the wake word as
  said, from its id (`okay_nabu` becomes "Okay Nabu"), the same
  normalisation speech to text matches against. A custom prompt must still
  ask for the JSON above. The built-in prompt's hash is part of the type's
  version, so a release that changes it judges every clip again with the
  judges that use it.
- Errors go through the same rules as the speech-to-text types (the table
  above): no credit or quota pauses the judge, a 404 is a wrong address or
  model, and a 400 that names the model, the reasoning effort or the
  response format is a refused setting.

### Listening or speech to text?

Speech to text answers "what does this audio say?"; a single misheard
word ("Alexa" written as "Alexis") turns a clip with the wake word into a
no. A listening model is asked about the wake word itself, so it can say
yes when it hears the wake word but would transcribe it wrongly. Use both:
they fail differently, which is what weighting is for.

The catch is **acquiescence bias**: a model asked "does this contain X?"
leans towards yes, and more so on unclear audio. The built-in prompt is
written against it. It says the wake word is as likely to be absent as
present, that only the whole word clearly spoken counts, that a
similar-sounding word, part of the word or the word only implied is "no",
that speech from a TV or speaker counts the same as a person in the room,
and to answer "unsure" rather than guess. That is also why a listening
judge starts at weight 0.5, below speech to text: check how it votes on
clips you have listened to before you trust it more. Turn the judge on,
let it work through the backlog, and compare its verdicts with the others
on the clip list's dissent filter.

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
    kind: Kind              # "wake_word_model", "speech_to_text" or "listening"
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

A `Setting` is `Setting(key, label, type="text" | "long_text" | "secret" |
"number" | "select" | "boolean", help=, default=, required=, options=,
minimum=, maximum=, placeholder=, affects_verdict=)`. `long_text` is text
on several lines, up to 8000 characters (a prompt); its `placeholder` can
be the text an empty value stands for, and the form offers to copy it.
Secrets never affect the verdict; set `affects_verdict=False` on anything
else that cannot (a timeout).

A listening type subclasses `ListeningJudge` (`judges/listening.py`),
which holds the built-in prompt, the answer contract and its parsing; it
implements `judge` with its own request.

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
