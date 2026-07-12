# Blink the two on-board user LEDs (green "user1" and blue "user2"), matching
# blinky.js which toggles tessel.led[2] and tessel.led[3].
#
# Tessel 2 has no Python hardware package, so we drive the LEDs the same way the
# JavaScript `tessel` library does internally: by writing "1"/"0" to the Linux
# sysfs brightness files. Deployed Tessel apps run as root, so these are
# writable. Use "Run on device" to try it live, or "Push to device" to run it on
# every boot. Written to work on both Python 2 and 3.
import time

LED_PATHS = [
    "/sys/devices/leds/leds/tessel:green:user1/brightness",
    "/sys/devices/leds/leds/tessel:blue:user2/brightness",
]


def set_led(path, on):
    with open(path, "w") as handle:
        handle.write("1" if on else "0")


on = False
while True:
    on = not on
    for path in LED_PATHS:
        set_led(path, on)
    time.sleep(0.1)
