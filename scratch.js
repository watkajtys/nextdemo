const fs = require('fs');
const content = fs.readFileSync('node_modules/@google/jules-sdk/dist/types.d.ts', 'utf8');
const m = content.match(/export interface SessionConfig\s*\{([\s\S]*?)\n\}\n/);
if(m) console.log(m[1].split('\n').filter(l => !l.trim().startsWith('/') && !l.trim().startsWith('*')).join('\n'));
