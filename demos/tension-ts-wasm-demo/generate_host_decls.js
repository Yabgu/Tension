#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const baseDir = __dirname;
const manifestPath = path.join(baseDir, 'host_bindings.json');
const outDir = path.join(baseDir, 'assembly');
const outPath = path.join(outDir, 'host.ts');

function mapType(t){
  // pass-through for known AssemblyScript types
  return t;
}

function gen(){
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let parts = [];

  // namespaces
  for(const ns of Object.keys(manifest)){
    parts.push(`declare namespace ${ns} {`);
    for(const fn of Object.keys(manifest[ns])){
      const info = manifest[ns][fn];
      const params = (info.params||[]).map((p,i)=>`arg${i}: ${mapType(p)}`).join(', ');
      parts.push(`  export function ${fn}(${params}): ${mapType(info.result)};`);
    }
    parts.push('}');
    parts.push('');
  }

  // Build wrappers explicitly below
  const wrappers = [];
  for(const ns of Object.keys(manifest)){
    for(const fn of Object.keys(manifest[ns])){
      const info = manifest[ns][fn];
      const params = info.params||[];
      const paramList = params.map((p,i)=>`arg${i}: ${mapType(p)}`).join(', ');
      const argsOnly = params.map((p,i)=>`arg${i}`).join(', ');
      const result = mapType(info.result);
      const sig = `function ${fn}(${paramList})${result?`: ${result}`:''} {
  return ${ns}.${fn}(${argsOnly});
}`;
      wrappers.push(sig);
    }
  }

  const content = parts.join('\n') + '\n\n' + wrappers.join('\n\n') + '\n';

  if(!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, content, 'utf8');
  console.log('Generated', outPath);
}

gen();
