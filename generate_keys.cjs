const { spawn } = require('child_process');

const child = spawn('npx.cmd', ['tauri', 'signer', 'generate', '-w', 'updater_key'], {
  cwd: process.cwd()
});

child.stdout.on('data', (data) => {
  const str = data.toString();
  console.log('STDOUT:', str);
  if (str.includes('password')) {
    child.stdin.write('\n'); // First enter for password
    setTimeout(() => {
      child.stdin.write('\n'); // Second enter for confirm password
    }, 500);
  }
});

child.stderr.on('data', (data) => {
  console.error('STDERR:', data.toString());
});

child.on('close', (code) => {
  console.log(`child process exited with code ${code}`);
});
