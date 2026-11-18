# User experience

Who Wakewright is for, the principles its screens follow, and the main
things people will do with it.

## Who it is for

- **The person who runs it.** Comfortable with Docker and a little YAML,
  not necessarily with machine learning. Wants fewer false and missed
  wakes without babysitting a system, and wants to see why it says what it
  says. Does routine things (reviewing a few clips, pausing) on a phone and
  setup and analysis on a desktop.
- **Everyone else in the home.** Talks to the satellites and will never
  open the UI. Needs to know what is recorded, that recording can be
  paused, and that a clip can be deleted on request
  ([privacy](../privacy.md) has wording to share).

## Principles

1. **Numbers with words.** Every metric has a plain sentence, and every
   sentence has its numbers one tap away.
2. **Show uncertainty.** Intervals, not bare points; "not enough data yet"
   is a normal state, with what would settle it.
3. **Nothing changes a device.** Every recommendation ends with the exact
   steps to apply it by hand and to switch back.
4. **Undo over confirm.** Confirm only what is hard to reverse, such as
   deleting in bulk.
5. **Phone for routine, desktop for analysis.** Review, pause and status
   work one-handed on a small screen.
6. **Calm.** Colour is for state; no animation for its own sake; no
   streaks or gamification.
7. **Accessible.** WCAG 2.2 AA: keyboard operation, visible focus, button
   alternatives to every gesture, and charts with a table view.

## Main user stories

Built:

- Add a Kiosk Satellite device by address and password, and see at once
  whether it is reachable, whether the password works and whether wake
  word diagnostics are on.
- Have clips collected automatically before the device's 10-clip buffer
  overwrites them, and be told when some may have been missed.
- Browse and play clips, filtered by device, kind and engine, with the
  device's score against its own threshold and the settings it was
  recorded under.
- Pause collection at once from the top bar, knowing that nothing
  recorded while paused is kept and nothing on the device changes.

Next (judging):

- Connect a worker and see on Home that it is connected and how many
  clips are waiting to be judged.
- See on each clip what each judge said, its score against its threshold,
  the transcript and the judge's version.
- Set judges up on a Judges page: their types, settings, weights and daily
  limits, with a test on one clip, and the margin and minimum that turn
  weighted votes into an outcome.
- Filter the clip list to **uncertain** outcomes, to clips where a judge
  dissents, and to the clips where the outcome disagrees with the device:
  likely false wakes and likely missed wake words.

Later:

- Review uncertain clips one clip at a time with a single key or tap, with
  the next clip already playing and undo for mistakes. A blind mode hides
  the judges' answers until you have given yours, for benchmark clips.
- See what is using storage and delete clips by filter, or everything.
- Read a per-device recommendation for the sensitivity setting, with the
  expected effect and its uncertainty, and apply it by hand.
- Compare a trained candidate with the device's current model, read one
  sentence saying whether it is better, and download it with install
  instructions.
- Run the worker on a Windows PC as a desktop app.
