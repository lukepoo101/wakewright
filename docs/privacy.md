# Privacy

Wakewright keeps short 3-second recordings from around the moments your
voice assistant heard, or nearly heard, its wake word. They may include
anyone in the room, including guests and children.

- **Audio stays on your machine.** Clips are stored only in Wakewright's
  data volume. Wakewright runs no servers of its own and sends no
  telemetry, crash reports or usage data ([ADR 0007](adr/0007-no-telemetry.md)).
  Its only outbound connections are to the devices you add, to download
  models, and to cloud services **you** set up as judges (below).
- **Cloud judges send clips to a third party.** A judge of a type marked
  "Sends clips to a third party" (OpenAI-compatible transcription,
  ElevenLabs Scribe) uploads every clip it judges to that service, from the
  worker. None is set up by default; such a judge starts off and turning
  it on asks you to confirm. Before you do, read the service's terms and
  data settings: some plans let the provider keep audio or use it to train
  models (ElevenLabs' free plan is reported to, by default: check your
  account's data settings), and some offer zero retention. A daily limit
  caps how many clips it sends, and the Workers page can keep the type to
  one worker. Deleting the judge stops it at once; what was already sent is
  under the service's own retention rules. A self-hosted Whisper server
  through the OpenAI-compatible type keeps clips on your own machines.
- **Nothing is deleted automatically.** Clips are kept until you delete
  them. (Deleting clips from the UI comes in a later version; until then,
  removing the data volume removes everything.)
- **Pause** in the top bar stops collection at once. Clips a device saves
  while paused are never stored. Pausing changes nothing on the device,
  except that a running collection session ends and puts its settings
  back.
- **Collection sessions record more.** While one runs, its tablet wakes
  on almost anything said nearby, and every wake and near miss is kept, so
  tell the people in the room. The tablet also acts on what it hears, as
  it always does when it wakes.
- **Behind a login.** The web UI and every clip need the admin account,
  or, with `WAKEWRIGHT__AUTH__MODE=none`, the sign-in of the reverse proxy
  in front of it.
  Audio is served with `Cache-Control: private`, so shared caches do not
  keep it.
- **Device passwords and judges' API keys** are stored encrypted with a
  key that is not in the database
  ([configuration.md](configuration.md#the-secret-key)). An API key is
  never shown again after it is saved and goes only to a worker allowed to
  run that judge.
- **Logs** contain device names, addresses and errors, never audio,
  transcripts, passwords or API keys.

Text you can show the household:

> This system keeps short 3-second recordings from around the moments your
> voice assistant heard, or nearly heard, its wake word. They may include
> anyone in the room. Recordings stay on this computer and are used only to
> make the wake word work better. (If you set up a cloud judge, say which
> service also receives them.) They are kept until someone deletes them.
> Recording can be paused at any time.
