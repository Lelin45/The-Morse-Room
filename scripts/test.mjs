import {readdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

// Keep the dependency-free website suite separate from the optional Expo project.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const files=(await readdir(resolve(root,'tests'))).filter(name=>name.endsWith('.test.mjs')).sort();
const child=spawn(process.execPath,['--test',...files.map(name=>resolve(root,'tests',name))],{
  cwd:root,stdio:'inherit',
});
child.on('error',()=>{console.error('The website tests could not start.');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
