// Run a shell command on the Tessel over LAN/SSH using t2-cli's own transport.
//
//   node tools/lan-exec.js <host-or-ip> "uci show wireless"
//
// Uses the provisioned key at ~/.tessel/id_rsa. Set T2_CLI_DIR to use a t2-cli
// checkout other than the bundled submodule.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const cliRoot = process.env.T2_CLI_DIR || path.join(__dirname, '..', 'repos', 't2-cli');
const host = process.argv[2];
const command = process.argv.slice(3).join(' ');

if (!host || !command) {
  console.error('usage: node tools/lan-exec.js <host> "<shell command>"');
  process.exit(2);
}

const LANConnection = require(path.join(cliRoot, 'lib', 'lan-connection.js')).LANConnection;

const conn = new LANConnection({
  host,
  port: 22,
  auth: {
    host,
    port: 22,
    username: 'root',
    passphrase: '',
    privateKey: fs.readFileSync(path.join(os.homedir(), '.tessel', 'id_rsa')),
  },
});

conn.open()
  .then(() => {
    conn.exec(['/bin/sh', '-c', command], (err, proc) => {
      if (err) {
        console.error(`EXEC ERROR: ${err.message}`);
        process.exit(1);
      }

      proc.on('data', (d) => process.stdout.write(String(d)));
      proc.stderr.on('data', (d) => process.stdout.write(String(d)));
      proc.on('close', () => process.exit(0));
    });
  })
  .catch((err) => {
    console.error(`OPEN ERROR: ${err.message}`);
    process.exit(1);
  });
