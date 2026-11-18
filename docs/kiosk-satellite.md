# Kiosk Satellite devices

Wakewright collects from [Kiosk Satellite](https://github.com/jxlarrea/kiosk-satellite)
through its remote administration API. It only reads: it logs in, reads the
device's health and settings, lists the saved wake word activations and
fetches their audio. It never changes a setting or installs anything.

## Turn on wake word diagnostics

A device keeps clips only while **wake word diagnostics** are on. With them
on, it keeps its last 10 wake word activations and its last 10 near misses
(the score reached 75% of the threshold without firing), each with a
3-second clip. Turning them off deletes those recordings on the device.

1. On the device, open Kiosk Satellite's settings (swipe in from the left
   edge), or open the device's remote admin page in a browser.
2. Go to **Voice Satellite**, then **Wake word diagnostics**.
3. Turn on **Enable wake word diagnostics**.

The device's card in Wakewright says "Diagnostics: On" at its next check
(within five minutes, or at once with **Check now**).

## What Wakewright needs

- **Address**: the device's IP address or host name. A bare address gets
  `http://` and port 2324. If you turned on HTTPS in Kiosk Satellite, enter
  `https://…`; the certificate must be one the Wakewright host trusts (a
  self-signed certificate is not accepted yet).
- **Password**: the remote administration password set in Kiosk Satellite
  under Device, Remote Administration. Wakewright stores it encrypted and
  uses it to get a one-day login token.

## How collection works

Wakewright asks each device for its saved clips every 10 seconds
(`WAKEWRIGHT__COLLECTOR__INTERVAL_SECONDS`) and copies the ones it does not
have. Because a device keeps only 10 of each kind, clips are lost if more
than 10 arrive while Wakewright is stopped or cannot reach the device; the
device card then says "Some clips may have been missed".

**Pause** in the top bar stops collection. Clips a device saves while
collection is paused are never stored, even after you resume. Pausing does
not change anything on the device.

## What a clip shows

- **Score and threshold** are the device's own record of the clip. Each
  engine scores on its own scale: microWakeWord and openWakeWord report a
  probability from 0 to 1, vsWakeWord a match score with thresholds around 10. So every clip names its engine, the Clips list can be filtered by
  engine, and the score bar always shows the score against that clip's own
  threshold: the mark in the middle is the threshold, and a score of twice
  the threshold or more fills the bar. Bars of different engines compare
  fairly; the numbers only within one engine.
- **Device settings then** (engine, wake words, sensitivity, fine-tune) are
  shown only when Wakewright read them from the device within 5 minutes of
  the moment the clip was recorded, and they name the clip's own engine.
  Wakewright reads them again whenever new clips arrive, so a clip collected
  as it happens has them. A device that is added hands over the clips it
  already saved, perhaps days old and recorded under other settings; those,
  and clips collected after a long outage, say the settings are not known.
  [ADR 0014](adr/0014-device-settings-of-a-clip.md) explains the choice.
- **Clipping** is the number of samples at full scale, as the device
  counted them, always shown on the clip's page. A clip is flagged
  **Clipped** only when at least 3 of them are in a row (Wakewright measures
  the runs from the audio). A single full-scale sample is a peak touching
  the limit for 1/16,000 of a second and is not audible; distortion comes
  from the waveform being flattened against the limit, which takes
  consecutive samples. 3 is the threshold Audacity's
  [Find Clipping](https://manual.audacityteam.org/man/find_clipping.html)
  uses by default.
- **Wake words**: a device can hold the same wake word in both of its
  slots; Wakewright lists each wake word once.

## When a device shows a problem

| Message                                | What to do                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| Cannot connect to the device           | Check the address, that the device is on, and that remote administration is running. |
| The device did not answer in time      | Usually a sleeping device or weak Wi-Fi; Wakewright retries with growing intervals.  |
| The device rejected the password       | Edit the device and enter the current remote administration password.                |
| The device is refusing logins for now  | Too many wrong passwords were tried; wait a few minutes.                             |
| The device's answer was not understood | The address may point at something else, or the app may need updating.               |
| The stored password cannot be read     | Wakewright's secret key changed; edit the device and enter its password again.       |
| Wake word diagnostics are off          | Turn them on as above.                                                               |
