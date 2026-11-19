# 0021 Listening judges: asking an audio model about the wake word

- Status: accepted
- Date: 2026-11-19
- Amends: [0019 Configurable, weighted judges](0019-configurable-weighted-judges.md)

## Context

ADR 0019 has two kinds of judge type: wake word models, and speech to text,
which transcribes a clip and then looks for the wake word in the transcript.
Listening to clips by hand shows a failure the second kind cannot avoid: the
wake word models hear "Alexa" correctly, but a transcript spells it as
another word, so speech to text says no to a clip that contains the wake
word. A transcript is an answer to a different question ("what does this
audio say?") from the one a judge answers.

Models that accept audio (OpenAI's audio models, Gemini, others behind an
OpenAI-compatible proxy such as LiteLLM) can be asked the judge's question
directly. Their weakness is the opposite one: asked "does this contain X?",
a model tends to agree (acquiescence bias), most of all when the audio is
unclear.

## Decision

- A third kind of judge type, **`listening`**, shown as "Listening model":
  it sends the clip to a model that accepts audio and asks whether someone
  says the wake word. The first type of the kind is **Audio question**
  (`audio-question`), through any OpenAI-compatible `/chat/completions`
  endpoint, with the clip as an `input_audio` content part.
- **The answer is a contract, not free text**: JSON with `heard` (yes, no
  or unsure) and `said`, a short note of what the model heard. Structured
  output is asked for where the endpoint takes it, and the answer is parsed
  leniently either way. "unsure" is an abstention. `said` is kept where a
  transcript is and shown as the model's note, never as a transcript.
- **An unreadable answer is the model's fault for that clip**, so it is an
  abstention with the reason, unless the model keeps failing the contract
  (three in a row for one judge's settings): then it is a fault of the
  settings, and the judge is paused like any other setting fault, so clips
  are not written off.
- **The built-in prompt is neutral by design**: the wake word is as likely
  absent as present, a similar or partial word is no, speech from a TV or
  speaker counts, and "unsure" beats a guess. It is part of the type's
  version (by hash), so changing it judges again. An empty prompt setting
  means the built-in prompt, so a judge follows improvements to it.
- **Default weight 0.5**, between a wake word model (0.3) and speech to text
  (1.0), until its verdicts have been checked against clips listened to by
  hand. The minimum weight stays 1.0: one listening judge alone is not
  enough evidence.
- **Worker protocol 3** adds the `listening` kind and a `long_text` setting
  type (for the prompt) to what a worker may offer. A protocol 2 parent
  would refuse such an offer, so the version changes and it answers 426
  with a clear message instead; the parent speaks 2 and 3, since a
  protocol 2 worker's messages are unchanged in 3.

## Consequences

- Speech to text and listening judges fail in different ways, and the
  weighted outcome can use both. The clip page and Judges page say which is
  which, so a model's note is not mistaken for what was said.
- A listening judge sends clips to a third party, like the cloud
  speech-to-text types: it is `external`, starts off and asks for
  confirmation before it is turned on ([privacy](../privacy.md)).
- The answer contract and the prompt are shared (`judges/listening.py`), so
  another listening type (a provider's own API, a local audio model) is a
  request and a settings schema.
- The parent still has no code per type. It learnt one new kind and one new
  setting type, as data.
