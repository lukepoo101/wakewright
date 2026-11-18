# Privacy

Wakewright keeps short 3-second recordings from around the moments your
voice assistant heard, or nearly heard, its wake word. They may include
anyone in the room, including guests and children.

- **Audio stays on your machine.** Clips are stored only in Wakewright's
  data volume. Wakewright runs no servers of its own and sends no
  telemetry, crash reports or usage data ([ADR 0007](adr/0007-no-telemetry.md)).
  Its only outbound connections are to the devices you add.
- **Nothing is deleted automatically.** Clips are kept until you delete
  them. (Deleting clips from the UI comes in a later version; until then,
  removing the data volume removes everything.)
- **Pause** in the top bar stops collection at once. Clips a device saves
  while paused are never stored. Pausing changes nothing on the device.
- **Behind a login.** The web UI and every clip need the admin account,
  or, with `WAKEWRIGHT__AUTH__MODE=none`, the sign-in of the reverse proxy
  in front of it.
  Audio is served with `Cache-Control: private`, so shared caches do not
  keep it.
- **Device passwords** are stored encrypted with a key that is not in the
  database ([configuration.md](configuration.md#the-secret-key)).
- **Logs** contain device names, addresses and errors, never audio or
  passwords.

Text you can show the household:

> This system keeps short 3-second recordings from around the moments your
> voice assistant heard, or nearly heard, its wake word. They may include
> anyone in the room. Recordings stay on this computer and are used only to
> make the wake word work better. They are kept until someone deletes them.
> Recording can be paused at any time.
