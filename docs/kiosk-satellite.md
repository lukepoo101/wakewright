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
