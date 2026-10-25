#!/usr/bin/env node
const { spawn } = require('child_process');
const cp = spawn('npx', ['cloudflared', 'tunnel', '--url', 'http://localhost:3000'], {
  stdio: ['ignore', 'pipe', 'pipe']
});
cp.stdout.on('data', d => {
  const s = d.toString();
  process.stdout.write(s);
  const m = s.match(/https:\/\/[a-z-]+\.trycloudflare\.com/);
  if (m) {
    console.log('\n═══════════════════════════════════');
    console.log(`  🎥 VOOM PUBLIC URL: ${m[0]}`);
    console.log('═══════════════════════════════════\n');
  }
});
cp.stderr.on('data', d => process.stderr.write(d.toString()));