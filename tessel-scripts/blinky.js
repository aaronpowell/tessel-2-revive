const tessel = require('tessel');

// Blink the two on-board LEDs. Use "Run on device" to try it live, or
// "Push to device" to have it run every time the Tessel boots.
setInterval(() => {
  tessel.led[2].toggle();
  tessel.led[3].toggle();
}, 100);