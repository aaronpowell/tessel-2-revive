// Run a shell command on the Tessel over USB, using t2-cli's own USB transport.
//
//   node tools/usb-exec.js "uci show wireless"
//
// `t2 root` / `t2 ssh` are LAN-only, so this is the only way to get a shell on a
// board that has no network yet -- e.g. straight after a restore, before WiFi is
// joined. Set T2_CLI_DIR to use a t2-cli checkout other than the bundled submodule.
'use strict';

const path = require('path');
const CLI = process.env.T2_CLI_DIR || path.join(__dirname, '..', 'repos', 't2-cli');

const usb = require(path.join(CLI, 'lib', 'usb-connection.js'));

const command = process.argv.slice(2).join(' ');
if (!command) {
  console.error('usage: node tools/usb-exec.js "<shell command>"');
  process.exit(2);
}

const scanner = usb.startScan();
let done = false;

const bail = (msg, code) => {
  if (done) {
    return;
  }
  done = true;
  usb.stopScan();
  if (msg) {
    console.error(msg);
  }
  process.exit(code);
};

setTimeout(() => bail('TIMEOUT: no USB Tessel responded', 3), 45000);

scanner.on('connection', (connection) => {
  connection.open()
    .then(() => {
      connection.exec(['/bin/sh', '-c', command], (err, proc) => {
        if (err) {
          return bail(`EXEC ERROR: ${err.message}`, 1);
        }

        let out = '';
        let errOut = '';

        proc.stdout.on('data', (d) => out += d.toString());
        proc.stderr.on('data', (d) => errOut += d.toString());

        proc.once('close', (code) => {
          process.stdout.write(out);
          if (errOut) {
            process.stdout.write(`\n--- stderr ---\n${errOut}`);
          }
          console.log(`\n--- exit ${code} ---`);
          bail(null, 0);
        });
      });
    })
    .catch((err) => bail(`OPEN ERROR: ${err.message}`, 1));
});
