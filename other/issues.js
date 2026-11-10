#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { Argument, Command } from 'commander';
import { Document, parseDocument } from 'yaml';

let ISSUES_DIR = path.resolve(import.meta.dirname, '..', 'issues');
let STATES = ['todo', 'wip', 'done', 'wont-do'];
let OPEN_STATES = ['todo', 'wip'];
let FRONT_MATTER = /^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;

function issuePath(id) {
  if (!/^[\w][\w.-]*$/.test(id)) throw new Error(`Invalid issue ID: ${id}`);
  return path.join(ISSUES_DIR, `${id}.md`);
}

function existingIssuePath(id) {
  let file = issuePath(id);
  if (!fs.existsSync(file)) throw new Error(`No such issue: ${id}`);
  return file;
}

function printIssue(file) {
  process.stdout.write(fs.readFileSync(file, 'utf8'));
}

function parseIssue(file) {
  let text = fs.readFileSync(file, 'utf8');
  let match = text.startsWith('---') && text.match(FRONT_MATTER);
  if (!match || match.index !== 0) throw new Error(`Missing front-matter: ${file}`);
  let doc = parseDocument(match[1]);
  if (doc.errors.length) throw new Error(`Invalid front-matter in ${file}: ${doc.errors[0].message}`);
  return { doc, body: text.slice(match[0].length) };
}

function requireEditor() {
  if (!process.env.EDITOR) throw new Error('$EDITOR is not set');
}

function runEditor(file) {
  // Through sh so that values like EDITOR="code --wait" work.
  let { status, signal, error } = spawnSync('sh', ['-c', `${process.env.EDITOR} "$1"`, 'sh', file], { stdio: 'inherit' });
  if (error) throw error;
  if (status !== 0) throw new Error(`$EDITOR exited with ${signal || `status ${status}`}`);
}

function promptComment() {
  requireEditor();
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issues-'));
  try {
    let file = path.join(dir, 'comment.md');
    fs.writeFileSync(file, '');
    runEditor(file);
    return fs.readFileSync(file, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let program = new Command('issues').description('Manage project issues as front-matter + Markdown files');

program
  .command('add')
  .description('Create an issue and open it with $EDITOR')
  .argument('<issue_id>')
  .argument('<brief_description...>')
  .option('-b, --bare', 'do not launch $EDITOR after scaffolding')
  .option('--tag <tag>', 'tag the issue (repeatable)', (tag, tags) => [...tags, tag], [])
  .action((id, brief, opts) => {
    let file = issuePath(id);
    if (!opts.bare) requireEditor();
    let doc = new Document({ id, brief: brief.join(' '), state: 'todo', tags: opts.tag, created: new Date().toISOString() });
    fs.mkdirSync(ISSUES_DIR, { recursive: true });
    try {
      fs.writeFileSync(file, `---\n${doc.toString({ lineWidth: 0 })}---\n`, { flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') throw new Error(`Issue already exists: ${id}`);
      throw err;
    }
    if (!opts.bare) {
      try {
        runEditor(file);
      } catch (err) {
        throw new Error(`${err.message}; issue left at ${file}`);
      }
    }
    printIssue(file);
  });

program
  .command('mark')
  .description('Set the state of an issue')
  .argument('<issue_id>')
  .addArgument(new Argument('[state]').choices(STATES).default('todo'))
  .action((id, state) => {
    let file = existingIssuePath(id);
    let { doc, body } = parseIssue(file);
    doc.set('state', state);
    fs.writeFileSync(file, `---\n${doc.toString({ lineWidth: 0 })}---\n${body}`);
    printIssue(file);
  });

program
  .command('rm')
  .description('Irrevocably remove an issue')
  .argument('<issue_id>')
  .action(id => {
    let file = existingIssuePath(id);
    printIssue(file);
    fs.unlinkSync(file);
  });

program
  .command('list')
  .description('List open issues')
  .action(() => {
    let files = fs.existsSync(ISSUES_DIR) ? fs.readdirSync(ISSUES_DIR).filter(x => x.endsWith('.md')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
    for (let name of files) {
      let { doc } = parseIssue(path.join(ISSUES_DIR, name));
      let state = doc.get('state');
      if (OPEN_STATES.includes(state)) console.log(`${state} | ${name.slice(0, -'.md'.length)} | ${doc.get('brief')}`);
    }
  });

program
  .command('comment')
  .description('Append a comment to an issue; opens $EDITOR when --brief is omitted')
  .argument('<issue_id>')
  .requiredOption('--author <name>', 'comment author')
  .option('--brief <text>', 'comment text')
  .action((id, opts) => {
    let file = existingIssuePath(id);
    let comment = (opts.brief ?? promptComment()).replace(/\s+$/, '');
    if (!comment) throw new Error('Empty comment; nothing was added');
    fs.appendFileSync(file, `\n---\n\nComment by ${opts.author} on ${new Date().toISOString()}:\n\n${comment}\n`);
    printIssue(file);
  });

program
  .command('edit')
  .description('Open an issue with $EDITOR')
  .argument('<issue_id>')
  .action(id => {
    let file = existingIssuePath(id);
    requireEditor();
    runEditor(file);
    printIssue(file);
  });

program
  .command('read')
  .description('Print an issue')
  .argument('<issue_id>')
  .action(id => printIssue(existingIssuePath(id)));

try {
  program.parse();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
