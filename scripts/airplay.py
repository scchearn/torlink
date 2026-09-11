#!/usr/bin/env python3
"""AirPlay helper for torlnk: scan for Apple TVs, cast a URL, stop playback.

Shells out from Node (players.ts) the same way vlc/mpv are spawned.
Uses the pyatv library directly since the atvremote CLI is broken on
Python 3.14. Requires pyatv 0.18.x + the pyatv_compat shim from the iptv
project for tvOS 26 AirPlay v2 protocol support.

Usage:
  python airplay.py scan            # print "id\tname" lines for each Apple TV
  python airplay.py play <id> <url> # cast URL to the named Apple TV
  python airplay.py stop <id>       # tear down playback on the named Apple TV

Errors print a human traceback to stderr and one machine-readable line as
the LAST stderr line: TORLNK_ERR: <message>. Node surfaces that line to the
UI; everything else is diagnostics.
"""
import asyncio
import sys
import os

# The pyatv_compat shim lives in the iptv project; add it to the path if available.
# Without it, play_url fails on tvOS 26 (AirPlay v2 protocol changed).
_COMPAT_DIR = os.environ.get("TORLINK_PYATV_COMPAT_DIR", "")
if _COMPAT_DIR:
    sys.path.insert(0, _COMPAT_DIR)

# A device that accepts the queue command but never reports playback state is
# the one failure mode worth retrying: the session was accepted, the receiver
# just wedged (seen after rapid recasts). One recast on a fresh session fixes
# it; anything else should fail loudly.
_STATE_TIMEOUT_MSG = "Apple TV did not report playback state"
_RECAST_ATTEMPTS = 2


def fail(msg: str) -> None:
    print(f"TORLNK_ERR: {msg}", file=sys.stderr)
    sys.exit(1)


async def _find(loop, device_id):
    import pyatv
    devs = await pyatv.scan(loop)
    config = next((d for d in devs if d.identifier == device_id), None)
    if not config:
        fail(f"Device {device_id} not found")
    return config


async def _connect(loop, config):
    import pyatv
    from pyatv.storage.file_storage import FileStorage
    storage = FileStorage.default_storage(loop)
    await storage.load()
    return await pyatv.connect(config, loop, storage=storage)


async def scan(loop):
    import pyatv
    devs = await pyatv.scan(loop)
    for d in devs:
        os_name = getattr(d.device_info.operating_system, "name", "")
        if os_name == "TvOS":
            model = str(getattr(d.device_info, "model", "") or "")
            print(f"{d.identifier}\t{d.name}\t{model}")


async def play_once(loop, device_id, url, position=0.0, report_pos=False):
    """One connect + play_url cycle. Returns after playback ends (or raises).

    On SIGTERM (torlnk's stop path kills the helper before running `stop`),
    close the session cleanly instead of dying mid-RTSP so the ATV drops
    playback immediately rather than hanging on a dead socket.

    With report_pos, prints "POS:<seconds>" lines on stdout as the receiver
    reports its playback position, so Node can detect user seeks (the ATV's
    remote scrub) and restart the transcode at the new spot.
    """
    import pyatv
    import signal
    config = await _find(loop, device_id)

    restore = None
    atv = None
    interrupted = asyncio.Event()
    prev_term = signal.getsignal(signal.SIGTERM)

    def _on_term(signum, frame):
        interrupted.set()

    signal.signal(signal.SIGTERM, _on_term)
    try:
        # Install the compat shim if available (tvOS 26 AirPlay v2 support).
        try:
            from pyatv_compat import install
            restore = install(pyatv)
        except ImportError:
            pass

        atv = await _connect(loop, config)
        play_task = asyncio.ensure_future(atv.stream.play_url(url, position=position))
        stop_task = asyncio.ensure_future(interrupted.wait())
        pos_task = (
            asyncio.ensure_future(_report_positions(atv)) if report_pos else None
        )
        tasks = {play_task, stop_task} | ({pos_task} if pos_task else set())
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        if stop_task in done:
            # torlnk asked us to stop: tear the session down and exit 0.
            try:
                await atv.remote_control.stop()
            except Exception:
                pass
            play_task.cancel()
            if pos_task:
                pos_task.cancel()
            return
        # play_url returned on its own (playback ended or raised).
        stop_task.cancel()
        if pos_task:
            pos_task.cancel()
        # Propagate a play_url exception, if that's what completed.
        play_task.result()
        atv.close()
        atv = None
    finally:
        signal.signal(signal.SIGTERM, prev_term)
        if atv is not None:
            try:
                atv.close()
            except Exception:
                pass
        if restore:
            restore()


async def _report_positions(atv):
    """Poll the compat protocol's metadata for the receiver's play position.

    The compat shim stashes the AirPlayV2Compat instance on the stream; its
    metadata() returns the last nowPlayingInfo (elapsedTime/duration) pushed
    on the encrypted event channel. Print POS lines for Node's seek watcher.
    """
    import sys
    last = -1.0
    while True:
        await asyncio.sleep(2)
        try:
            compat = getattr(atv.stream, "_compat_protocol", None)
            if compat is None:
                continue
            info = compat.metadata()
            elapsed = info.get("elapsedTime")
            if elapsed is None:
                continue
            if abs(elapsed - last) >= 1.0:
                last = elapsed
                print(f"POS:{elapsed:.1f}", flush=True)
        except Exception:
            # Session may be gone; keep polling until the outer task is cancelled.
            continue


async def play(loop, device_id, url, position=0.0, report_pos=False):
    last_err = None
    for attempt in range(_RECAST_ATTEMPTS):
        try:
            await play_once(loop, device_id, url, position=position, report_pos=report_pos)
            return
        except RuntimeError as e:
            if _STATE_TIMEOUT_MSG not in str(e):
                fail(str(e))
            last_err = e
            print(f"play attempt {attempt + 1}/{_RECAST_ATTEMPTS} failed: {e}", file=sys.stderr)
            await asyncio.sleep(2)
    fail(str(last_err))


async def stop(loop, device_id):
    """Tear down AirPlay playback: connect, close the stream session, exit."""
    import pyatv
    config = await _find(loop, device_id)

    restore = None
    atv = None
    try:
        try:
            from pyatv_compat import install
            restore = install(pyatv)
        except ImportError:
            pass
        atv = await _connect(loop, config)
        # remote_control.stop() relays a stop across protocols; for AirPlay the
        # stream session closes and the receiver drops playback.
        await atv.remote_control.stop()
        atv.close()
        atv = None
    except Exception as e:
        # Stop is best-effort: the device may already be idle or unreachable.
        # Report but exit 0 — the UI treats stop as always-succeeding.
        print(f"stop: {e}", file=sys.stderr)
    finally:
        if atv is not None:
            try:
                atv.close()
            except Exception:
                pass
        if restore:
            restore()


def main():
    args = sys.argv[1:]
    if not args:
        fail("Usage: airplay.py scan | play <id> <url> [--position S] [--report-pos] | stop <id>")

    loop = asyncio.new_event_loop()
    try:
        if args[0] == "scan":
            loop.run_until_complete(scan(loop))
        elif args[0] == "play" and len(args) >= 3:
            device_id, url = args[1], args[2]
            position = 0.0
            report_pos = False
            extra = args[3:]
            i = 0
            while i < len(extra):
                if extra[i] == "--position" and i + 1 < len(extra):
                    try:
                        position = float(extra[i + 1])
                    except ValueError:
                        fail(f"Invalid --position value: {extra[i + 1]}")
                    i += 2
                elif extra[i] == "--report-pos":
                    report_pos = True
                    i += 1
                else:
                    fail(f"Unknown play option: {extra[i]}")
            loop.run_until_complete(play(loop, device_id, url, position=position, report_pos=report_pos))
        elif args[0] == "stop" and len(args) == 2:
            loop.run_until_complete(stop(loop, args[1]))
        else:
            fail("Usage: airplay.py scan | play <id> <url> [--position S] [--report-pos] | stop <id>")
    finally:
        loop.close()


if __name__ == "__main__":
    main()
