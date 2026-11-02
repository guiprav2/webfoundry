import { minimatch } from 'https://esm.run/minimatch@10.2.6';
import { parse as parseBash } from 'https://esm.run/unbash@5.0.0';
import { parseWfInvocation, formatWfResult } from './wf-commands.js';
import { execWfCommand } from '../controllers/Companion.js';

// Async project shell. Paths are project-relative. Every directory keeps a
// `.keep` file, including directories that also contain other files.
let globOpts = { dot: false };

export function createShell(fs) {
  let cwd = '';

  async function run(script) {
    let ast = parseBash(String(script || ''));
    if (ast.errors?.length) {
      return { code: 1, stdout: '', stderr: ast.errors.map(err => err.message).join('\n') + '\n' };
    }
    let index = makeIndex(fs);
    return evalStatements(index, ast.commands);
  }

  async function evalStatements(index, statements) {
    let stdout = '';
    let stderr = '';
    let code = 0;
    for (let statement of statements || []) {
      let one = await evalStatement(index, statement);
      stdout += one.stdout;
      stderr += one.stderr;
      code = one.code;
    }
    return { code, stdout, stderr };
  }

  async function evalStatement(index, statement) {
    let node = statement.command;
    if (node.type === 'AndOr') return evalAndOr(index, node);
    return evalPipelineNode(index, node, null);
  }

  async function evalAndOr(index, node) {
    let stdout = '';
    let stderr = '';
    let code = 0;
    for (let i = 0; i < node.commands.length; i++) {
      if (i > 0) {
        let op = node.operators[i - 1];
        if (op === '&&' && code) break;
        if (op === '||' && !code) break;
      }
      let one = await evalPipelineNode(index, node.commands[i], null);
      stdout += one.stdout;
      stderr += one.stderr;
      code = one.code;
    }
    return { code, stdout, stderr };
  }

  async function evalPipelineNode(index, node, stdin) {
    if (!node) return { code: 0, stdout: '', stderr: '' };
    if (node.type === 'Pipeline') return evalPipeline(index, node, stdin);
    if (node.type === 'Negation') {
      let inner = await evalPipelineNode(index, node.command, stdin);
      inner.code = inner.code ? 0 : 1;
      return inner;
    }
    if (node.type === 'Command') return evalSimple(index, node, stdin);
    if (node.type === 'Redirected') {
      return routeCommand(index, node.redirects, stdin, () => evalPipelineNode(index, node.command, null));
    }
    if (node.type === 'Subshell' || node.type === 'BraceGroup') return evalStatements(index, node.body.commands);
    return { code: 1, stdout: '', stderr: `unsupported shell syntax: ${node.type}\n` };
  }

  async function evalPipeline(index, node, stdin) {
    let input = stdin;
    let stderr = '';
    let code = 0;
    let stdout = '';
    for (let i = 0; i < node.commands.length; i++) {
      let result = await evalPipelineNode(index, node.commands[i], input);
      code = result.code;
      let last = i === node.commands.length - 1;
      if (last) {
        stdout = result.stdout;
        stderr += result.stderr;
        break;
      }
      if (node.operators[i] === '|&') input = result.stdout + result.stderr;
      else {
        input = result.stdout;
        stderr += result.stderr;
      }
    }
    return { code, stdout, stderr };
  }

  async function evalSimple(index, command, stdin) {
    try {
      return await routeCommand(index, command.redirects || [], stdin, async input => {
        if (!command.name) return { code: 0, stdout: '', stderr: '' };
        let args = [];
        for (let arg of command.args || []) {
          if (arg.type === 'Word') args.push(arg.value);
        }
        try {
          return await dispatch(index, command.name.value, args, input);
        } catch (err) {
          let message = (err && err.message) || String(err);
          if (!message.endsWith('\n')) message += '\n';
          return { code: err && err.code || 1, stdout: '', stderr: message };
        }
      });
    } catch (err) {
      let message = (err && err.message) || String(err);
      if (!message.endsWith('\n')) message += '\n';
      return { code: err && err.code || 1, stdout: '', stderr: message };
    }
  }

  async function routeCommand(index, redirects, stdin, produce) {
    let input = stdin;
    let fd = { 1: { kind: 'pipe' }, 2: { kind: 'err' } };
    for (let redir of redirects) {
      if (redir.type === 'HereDoc' || redir.type === 'HereString') {
        input = heredocText(redir);
        continue;
      }
      let op = redir.operator;
      let target = redir.target ? resolvePath(cwd, redir.target.value) : '';
      let src = redir.descriptor?.type === 'FileDescriptor' ? redir.descriptor.value : null;
      if (op === '<' ) {
        let text = await readFile(index, target);
        if (text == null) throw shellError(`no such file or directory: ${target}`, 1);
        input = text;
        continue;
      }
      if (op === '>' || op === '>>' || op === '>|') {
        let n = src == null ? 1 : src;
        if (op !== '>>') await writeFile(index, target, '');
        fd[n] = { kind: 'file', path: target, append: true };
        continue;
      }
      if (op === '&>' || op === '&>>') {
        if (op === '&>') await writeFile(index, target, '');
        let spec = { kind: 'file', path: target, append: true };
        fd[1] = spec;
        fd[2] = { ...spec };
        continue;
      }
      if (op === '>&' || op === '<&') {
        let word = redir.target?.value || '';
        if (/^\d+$/.test(word)) {
          let from = src == null ? 1 : src;
          fd[from] = { ...(fd[Number(word)] || { kind: 'pipe' }) };
        } else if (op === '>&') {
          await writeFile(index, target, '');
          let spec = { kind: 'file', path: target, append: true };
          fd[1] = spec;
          fd[2] = { ...spec };
        }
      }
    }
    let result = await produce(input);
    let stdout = result.stdout || '';
    let stderr = result.stderr || '';
    stdout = await sink(index, fd[1], stdout, true);
    if (fd[2].kind === 'pipe') stdout += stderr, stderr = '';
    else if (fd[2].kind === 'file') stderr = await sink(index, fd[2], stderr, true);
    return { code: result.code, stdout, stderr };
  }

  async function sink(index, target, text, keepEmpty) {
    if (!target || target.kind === 'pipe' || target.kind === 'err') return text;
    let prev = target.append ? ((await readFile(index, target.path)) || '') : '';
    await writeFile(index, target.path, prev + text);
    return keepEmpty ? '' : text;
  }

  async function dispatch(index, name, args, stdin) {
    if (name === 'pwd') return ok((cwd || '.') + '\n');
    if (name === 'cd') return cmdCd(index, args);
    if (name === 'ls') return cmdLs(index, args);
    if (name === 'grep') return cmdGrep(index, args, stdin);
    if (name === 'cat') return cmdCat(index, args, stdin);
    if (name === 'mkdir') return cmdMkdir(index, args);
    if (name === 'rm') return cmdRm(index, args);
    if (name === 'mv') return cmdMv(index, args);
    if (name === 'cp') return cmdCp(index, args);
    if (name === 'echo') return cmdEcho(args);
    if (name === 'head') return cmdHeadTail(index, args, true, stdin);
    if (name === 'tail') return cmdHeadTail(index, args, false, stdin);
    if (name === 'find') return cmdFind(index, args);
    if (name === 'sed') return cmdSed(index, args, stdin);
    if (name === 'wc') return cmdWc(index, args, stdin);
    if (name === 'touch') return cmdTouch(index, args);
    if (name === 'wf') return cmdWf(args);
    throw shellError(`command not found: ${name}`, 127);
  }

  async function cmdCd(index, args) {
    let target = resolvePath(cwd, args[0] || '');
    if (target && !(await isDir(index, target))) throw shellError(`cd: not a directory: ${target || '/'}`, 1);
    cwd = target;
    return ok('');
  }

  async function cmdLs(index, args) {
    let parsed = parseOpts(args, { a: 'bool', A: 'bool' });
    let showKeep = parsed.opts.a || parsed.opts.A;
    let paths = parsed.rest.length ? parsed.rest : ['.'];
    let blocks = [];
    for (let raw of paths) {
      let expanded = await expand(index, cwd, raw);
      for (let path of expanded) {
        if (await isDir(index, path)) {
          let names = await listDir(index, path, showKeep);
          blocks.push(names.map(entry => entry.kind === 'dir' ? entry.name + '/' : entry.name).join('\n'));
        } else if (await existsFile(index, path)) {
          blocks.push(baseName(path));
        } else {
          throw shellError(`ls: no such file or directory: ${raw}`, 2);
        }
      }
    }
    let text = blocks.filter(Boolean).join('\n\n');
    return ok(text ? text + '\n' : '');
  }

  async function cmdCat(index, args, stdin) {
    if (!args.length) {
      if (stdin == null) throw shellError('cat: no paths given', 1);
      return ok(stdin);
    }
    let out = '';
    for (let raw of args) {
      if (raw === '-') {
        out += stdin || '';
        continue;
      }
      let expanded = await expand(index, cwd, raw);
      for (let path of expanded) {
        if (await isDir(index, path)) throw shellError(`cat: ${path}: Is a directory`, 1);
        let text = await readFile(index, path);
        if (text == null) throw shellError(`cat: no such file or directory: ${path}`, 1);
        out += text;
      }
    }
    return ok(out);
  }

  async function cmdGrep(index, args, stdin) {
    let parsed = parseGrepArgs(args);
    let before = parsed.before;
    let after = parsed.after;
    if ((before != null && before < 0) || (after != null && after < 0)) {
      throw shellError('grep: invalid context length argument', 2);
    }
    if (!parsed.patterns.length) throw shellError('grep: no pattern given', 2);
    let fileArgs = parsed.files;
    if (!fileArgs.length && stdin == null) throw shellError('grep: no paths given', 2);
    let source = parsed.patterns.map(pattern => parsed.fixed ? escapeRegExp(pattern) : pattern).join('|');
    if (parsed.word) source = `\\b(?:${source})\\b`;
    let regex;
    try {
      regex = new RegExp(source, parsed.ignoreCase ? 'i' : '');
    } catch (err) {
      throw shellError(`grep: ${err.message}`, 2);
    }
    let files = [];
    let stdinFiles = [];
    let stderr = '';
    let code = 0;
    for (let raw of fileArgs) {
      if (raw === '-') {
        stdinFiles.push(stdin || '');
        continue;
      }
      let expanded = await expand(index, cwd, raw);
      for (let path of expanded) {
        if (await isDir(index, path)) {
          if (!parsed.recursive) {
            stderr += `grep: ${path}: Is a directory\n`;
            code = 2;
            continue;
          }
          for (let file of await filesUnder(index, path)) {
            if (grepSkip(file, parsed)) continue;
            files.push(file);
          }
        } else if (isKeep(path) && !raw.endsWith('.keep')) {
          continue;
        } else if (await existsFile(index, path)) {
          if (!grepSkip(path, parsed)) files.push(path);
        } else if (!parsed.quietErrors) {
          stderr += `grep: no such file or directory: ${path}\n`;
          code = 2;
        } else {
          code = 2;
        }
      }
    }
    if (!fileArgs.length) stdinFiles.push(stdin || '');
    files = [...new Set(files)];
    let prefixNames = parsed.withFilename || (!parsed.noFilename && (parsed.recursive || files.length + stdinFiles.length > 1));
    let groups = [];
    let any = false;
    let sep = (before || after) ? '\n--\n' : '\n';
    let scan = async (label, contents) => {
      if (parsed.onlyMatching) {
        let rows = grepOnly(regex, contents, parsed.inverse);
        if (!rows.length) return;
        any = true;
        groups.push(rows.map(row => (prefixNames && label ? label + ':' : '') + (parsed.lineNumber ? row.lineNumber + ':' : '') + row.text).join('\n'));
        return;
      }
      let matched = grepContents({
        inverse: parsed.inverse,
        nameOnly: parsed.namesOnly,
        lineNumber: parsed.lineNumber,
        before: before || 0,
        after: after || 0,
      }, regex, contents);
      if (parsed.namesOnly) {
        if (matched && label) {
          any = true;
          groups.push(label);
        }
        return;
      }
      if (!matched.length) return;
      any = true;
      groups.push(matched.map(group => rowsOf(group).map(row => formatGrepRow(label, row, parsed.lineNumber, prefixNames && !!label)).join('\n')).join(sep));
    };
    for (let file of files) {
      let contents = await fs.read(file);
      if (contents == null) {
        if (!parsed.quietErrors) stderr += `grep: no such file or directory: ${file}\n`;
        code = 2;
        continue;
      }
      await scan(file, contents);
    }
    for (let text of stdinFiles) await scan(parsed.withFilename ? '(standard input)' : '', text);
    if (!any && !code) code = 1;
    let joiner = parsed.namesOnly ? '\n' : sep;
    let stdout = groups.length ? groups.join(joiner) + '\n' : '';
    if (code === 1 && !stdout && !stderr) stderr = 'grep: no matches\n';
    return { code, stdout, stderr };
  }

  async function cmdMkdir(index, args) {
    let parsed = parseOpts(args, { p: 'bool' });
    if (!parsed.rest.length) throw shellError('mkdir: missing operand', 1);
    for (let raw of parsed.rest) {
      let path = resolvePath(cwd, raw);
      if (!path) continue;
      if (await existsFile(index, path)) throw shellError(`mkdir: cannot create directory '${path}': File exists`, 1);
      let parts = path.split('/');
      let acc = [];
      for (let part of parts) {
        acc.push(part);
        let dir = acc.join('/');
        if (await existsFile(index, dir)) throw shellError(`mkdir: cannot create directory '${path}': Not a directory`, 1);
        await writeKeep(index, dir);
      }
    }
    return ok('');
  }

  async function cmdRm(index, args) {
    let parsed = parseOpts(args, { r: 'bool', R: 'bool', f: 'bool' });
    let recursive = parsed.opts.r || parsed.opts.R;
    if (!parsed.rest.length && !parsed.opts.f) throw shellError('rm: missing operand', 1);
    for (let raw of parsed.rest) {
      let expanded = hasGlob(raw) ? await expand(index, cwd, raw) : [resolvePath(cwd, raw)];
      if (hasGlob(raw) && !expanded.length) {
        if (!parsed.opts.f) throw shellError(`rm: no such file or directory: ${raw}`, 1);
        continue;
      }
      for (let path of expanded) {
        if (isKeep(path)) throw shellError(`rm: refusing to remove ${path}; remove the directory with rm -r`, 1);
        if (await isDir(index, path)) {
          if (!recursive) throw shellError(`rm: cannot remove '${path}': Is a directory`, 1);
          await fs.remove(path + '/');
          dropPrefix(await index.all(), path + '/');
        } else if (await existsFile(index, path)) {
          await fs.remove(path);
          (await index.all()).delete(path);
        } else if (!parsed.opts.f) {
          throw shellError(`rm: no such file or directory: ${path}`, 1);
        }
      }
    }
    return ok('');
  }

  async function cmdMv(index, args) {
    if (args.length < 2) throw shellError('mv: missing operand', 1);
    let srcRaw = args.slice(0, -1);
    let destRaw = args[args.length - 1];
    let dest = resolvePath(cwd, destRaw);
    let sources = [];
    for (let raw of srcRaw) sources.push(...await expand(index, cwd, raw));
    let destIsDir = await isDir(index, dest);
    if (sources.length > 1 && !destIsDir) throw shellError(`mv: target '${dest}' is not a directory`, 1);
    for (let src of sources) {
      assertWritable(src);
      let target = destIsDir ? joinPath(dest, baseName(src)) : dest;
      assertWritable(target);
      if (await isDir(index, src)) {
        await ensureParents(index, target + '/.keep');
        await fs.move(src + '/', target + '/');
        retargetPrefix(await index.all(), src + '/', target + '/');
      } else {
        if (!(await existsFile(index, src))) throw shellError(`mv: no such file or directory: ${src}`, 1);
        await ensureParents(index, target);
        await fs.move(src, target);
        let paths = await index.all();
        paths.delete(src);
        paths.add(target);
      }
    }
    return ok('');
  }

  async function cmdCp(index, args) {
    let parsed = parseOpts(args, { r: 'bool', R: 'bool' });
    if (parsed.rest.length < 2) throw shellError('cp: missing operand', 1);
    let dest = resolvePath(cwd, parsed.rest[parsed.rest.length - 1]);
    let sources = [];
    for (let raw of parsed.rest.slice(0, -1)) sources.push(...await expand(index, cwd, raw));
    let destIsDir = await isDir(index, dest);
    if (sources.length > 1 && !destIsDir) throw shellError(`cp: target '${dest}' is not a directory`, 1);
    for (let src of sources) {
      let target = destIsDir ? joinPath(dest, baseName(src)) : dest;
      if (await isDir(index, src)) {
        if (!(parsed.opts.r || parsed.opts.R)) throw shellError(`cp: -r not specified; omitting directory '${src}'`, 1);
        let paths = [...await index.all()].filter(path => path === src + '/.keep' || path.startsWith(src + '/'));
        for (let path of paths) {
          let next = target + path.slice(src.length);
          assertWritable(next);
          let text = await fs.read(path);
          await writeFile(index, next, text == null ? '' : text);
        }
      } else {
        let text = await readFile(index, src);
        if (text == null) throw shellError(`cp: no such file or directory: ${src}`, 1);
        assertWritable(target);
        await writeFile(index, target, text);
      }
    }
    return ok('');
  }

  function cmdEcho(args) {
    let newline = true;
    let messages = args;
    if (args[0] === '-n') {
      newline = false;
      messages = args.slice(1);
    }
    return ok(messages.join(' ') + (newline ? '\n' : ''));
  }

  async function cmdHeadTail(index, args, head, stdin) {
    let parsed = parseOpts(args, { n: 'num' });
    let count = parsed.opts.n == null ? 10 : parsed.opts.n;
    let texts = [];
    if (!parsed.rest.length) {
      if (stdin == null) throw shellError(`${head ? 'head' : 'tail'}: no paths given`, 1);
      texts.push(stdin);
    }
    for (let raw of parsed.rest) {
      if (raw === '-') {
        texts.push(stdin || '');
        continue;
      }
      for (let path of await expand(index, cwd, raw)) {
        if (await isDir(index, path)) throw shellError(`${head ? 'head' : 'tail'}: ${path}: Is a directory`, 1);
        let text = await readFile(index, path);
        if (text == null) throw shellError(`${head ? 'head' : 'tail'}: no such file or directory: ${path}`, 1);
        texts.push(text);
      }
    }
    let out = '';
    for (let text of texts) {
      let lines = text.split('\n');
      if (text.endsWith('\n')) lines.pop();
      let slice = head ? lines.slice(0, count) : lines.slice(Math.max(lines.length - count, 0));
      out += slice.join('\n') + (slice.length ? '\n' : '');
    }
    return ok(out);
  }

  async function cmdFind(index, args) {
    let start = '.';
    let names = [];
    let types = null;
    for (let i = 0; i < args.length; i++) {
      let arg = args[i];
      if (arg === '-name' || arg === '-path') {
        let glob = args[++i];
        if (glob == null) throw shellError(`find: missing argument to ${arg}`, 1);
        names.push({ kind: arg, glob });
        continue;
      }
      if (arg === '-type') {
        let kind = args[++i];
        if (kind !== 'f' && kind !== 'd') throw shellError('find: -type expects f or d', 1);
        types = kind;
        continue;
      }
      if (arg.startsWith('-')) throw shellError(`find: unknown predicate: ${arg}`, 1);
      start = arg;
    }
    start = resolvePath(cwd, start);
    let paths = [...await index.all()];
    let dirs = new Set();
    let files = [];
    for (let path of paths) {
      if (start && path !== start && !path.startsWith(start + '/')) continue;
      if (isKeep(path)) {
        dirs.add(path.slice(0, -'/.keep'.length));
        continue;
      }
      files.push(path);
    }
    let lines = [];
    if (!start) lines.push('.');
    if (types !== 'f') lines.push(...dirs);
    if (types !== 'd') lines.push(...files);
    lines = lines.filter(path => {
      if (!names.length) return !isKeep(path);
      return names.every(item => {
        let subject = item.kind === '-name' ? baseName(path) : path;
        return minimatch(subject, item.glob, globOpts);
      });
    }).sort();
    return ok(lines.length ? lines.join('\n') + '\n' : '');
  }

  async function cmdSed(index, args, stdin) {
    let quiet = false;
    let script = null;
    let files = [];
    for (let i = 0; i < args.length; i++) {
      let arg = args[i];
      if (arg === '--') {
        files.push(...args.slice(i + 1));
        break;
      }
      if (arg === '-n') {
        quiet = true;
        continue;
      }
      if (arg === '-e') {
        script = args[++i];
        if (script == null) throw shellError('sed: -e requires a script', 1);
        continue;
      }
      if (arg.startsWith('-e') && arg.length > 2) {
        script = arg.slice(2);
        continue;
      }
      if (arg.startsWith('-')) throw shellError(`sed: unknown option: ${arg}`, 1);
      if (script == null) script = arg;
      else files.push(arg);
    }
    if (script == null) throw shellError('sed: no script', 1);
    let range = script.match(/^(\d+)(?:,(\d+))?p$/);
    if (!range) throw shellError('sed: only an address print script is supported, such as sed -n \'10,40p\'', 1);
    let start = Number(range[1]);
    let end = range[2] ? Number(range[2]) : start;
    let texts = [];
    if (!files.length) {
      if (stdin == null) throw shellError('sed: no paths given', 1);
      texts.push(stdin);
    }
    for (let raw of files) {
      for (let path of await expand(index, cwd, raw)) {
        let text = await readFile(index, path);
        if (text == null) throw shellError(`sed: no such file or directory: ${path}`, 1);
        texts.push(text);
      }
    }
    let out = '';
    for (let text of texts) {
      let lines = text.split('\n');
      if (text.endsWith('\n')) lines.pop();
      for (let i = 0; i < lines.length; i++) {
        let selected = i + 1 >= start && i + 1 <= end;
        if (!quiet) out += lines[i] + '\n';
        if (selected) out += lines[i] + '\n';
      }
    }
    return ok(out);
  }

  async function cmdWc(index, args, stdin) {
    let parsed = parseOpts(args, { l: 'bool', w: 'bool', c: 'bool' });
    let texts = [];
    if (!parsed.rest.length) {
      if (stdin == null) throw shellError('wc: no paths given', 1);
      texts.push(['', stdin]);
    }
    for (let raw of parsed.rest) {
      if (raw === '-') {
        texts.push(['', stdin || '']);
        continue;
      }
      for (let path of await expand(index, cwd, raw)) {
        let text = await readFile(index, path);
        if (text == null) throw shellError(`wc: no such file or directory: ${path}`, 1);
        texts.push([path, text]);
      }
    }
    let wantLines = !!parsed.opts.l;
    let wantWords = !!parsed.opts.w;
    let wantChars = !!parsed.opts.c;
    if (!wantLines && !wantWords && !wantChars) {
      wantLines = true;
      wantWords = true;
      wantChars = true;
    }
    let fields = [];
    if (wantLines) fields.push('l');
    if (wantWords) fields.push('w');
    if (wantChars) fields.push('c');
    let out = '';
    for (let [path, text] of texts) {
      let counts = {
        l: (text.match(/\n/g) || []).length,
        w: text.split(/\s+/).filter(Boolean).length,
        c: text.length,
      };
      out += fields.map(field => counts[field]).join(' ');
      if (path) out += ' ' + path;
      out += '\n';
    }
    return ok(out);
  }

  async function cmdWf(args) {
    let verbose = false;
    try {
      let parsed = parseWfInvocation(args);
      verbose = parsed.verbose;
      if (parsed.help) return { code: parsed.code, stdout: parsed.stdout, stderr: parsed.stderr };
      let command = parsed.command;
      let payload = { name: command.name || parsed.subcmd, params: command.params || {} };
      let result = await execWfCommand(payload);
      return formatWfResult(parsed.spec, result, args);
    } catch (err) {
      let text = verbose || err?.verbose ? (err?.stack || err?.message || String(err)) : ((err && err.message) || String(err));
      if (!text.endsWith('\n')) text += '\n';
      return { code: 1, stdout: '', stderr: text };
    }
  }

  async function cmdTouch(index, args) {
    if (!args.length) throw shellError('touch: missing operand', 1);
    for (let raw of args) {
      let path = resolvePath(cwd, raw);
      assertWritable(path);
      if (await isDir(index, path)) throw shellError(`touch: cannot touch '${path}': Is a directory`, 1);
      if (!(await existsFile(index, path))) await writeFile(index, path, '');
      else await ensureParents(index, path);
    }
    return ok('');
  }

  async function writeFile(index, path, text) {
    assertWritable(path);
    await ensureParents(index, path);
    await fs.write(path, text);
    (await index.all()).add(path);
  }

  async function writeKeep(index, dir) {
    let keep = dir + '/.keep';
    let paths = await index.all();
    if (paths.has(keep)) return;
    await ensureParents(index, keep);
    await fs.write(keep, '');
    paths.add(keep);
  }

  async function ensureParents(index, path) {
    let parts = path.split('/');
    parts.pop();
    let acc = [];
    let paths = await index.all();
    for (let part of parts) {
      acc.push(part);
      let keep = acc.join('/') + '/.keep';
      if (paths.has(keep)) continue;
      await fs.write(keep, '');
      paths.add(keep);
    }
  }

  async function readFile(index, path) {
    if (!(await existsFile(index, path))) return null;
    return await fs.read(path);
  }

  async function existsFile(index, path) {
    if (!path || isDirPath(path)) return false;
    return (await index.all()).has(path);
  }

  async function isDir(index, path) {
    if (!path) return true;
    let prefix = path + '/';
    for (let item of await index.all()) {
      if (item.startsWith(prefix)) return true;
    }
    return false;
  }

  async function listDir(index, dir, showKeep) {
    let prefix = dir ? dir + '/' : '';
    let entries = new Map();
    for (let path of await index.all()) {
      if (prefix && !path.startsWith(prefix)) continue;
      if (!prefix && path.startsWith('/')) continue;
      let rest = prefix ? path.slice(prefix.length) : path;
      if (!rest) continue;
      let slash = rest.indexOf('/');
      if (slash === -1) {
        if (rest === '.keep' && !showKeep) continue;
        if (!entries.has(rest)) entries.set(rest, 'file');
      } else {
        entries.set(rest.slice(0, slash), 'dir');
      }
    }
    return [...entries.entries()]
      .map(([name, kind]) => ({ name, kind }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  }

  async function filesUnder(index, dir) {
    let prefix = dir ? dir + '/' : '';
    let files = [];
    for (let path of await index.all()) {
      if (prefix && !path.startsWith(prefix)) continue;
      if (isKeep(path)) continue;
      if (await isDir(index, path)) continue;
      files.push(path);
    }
    return files.sort();
  }

  return {
    get cwd() { return cwd; },
    run,
  };
}

export function formatResult(result) {
  let text = result.stdout || '';
  if (result.stderr) text += result.stderr;
  if (text.length > 40000) text = text.slice(0, 40000) + '\n… output truncated\n';
  if (!text) text = result.code ? `exit ${result.code}\n` : '';
  return text;
}

function makeIndex(fs) {
  let paths = null;
  return {
    async all() {
      if (!paths) paths = new Set(await fs.list());
      return paths;
    },
  };
}

function ok(stdout) {
  return { code: 0, stdout, stderr: '' };
}

function shellError(message, code) {
  let err = new Error(message);
  err.code = code;
  return err;
}

function assertWritable(path) {
  if (path.endsWith('.html') || path.endsWith('.html/')) {
    throw shellError(`refusing to write ${path}; HTML is edited in the page editor`, 1);
  }
  if (path === 'webfoundry' || path.startsWith('webfoundry/')) {
    throw shellError(`refusing to write ${path}`, 1);
  }
}

function isKeep(path) {
  return path === '.keep' || path.endsWith('/.keep');
}

function isDirPath(path) {
  return path.endsWith('/');
}

function baseName(path) {
  let parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function joinPath(dir, name) {
  return dir ? dir + '/' + name : name;
}

function resolvePath(cwd, input) {
  let text = input || '';
  if (text.startsWith('/')) text = text.slice(1);
  let parts = cwd ? cwd.split('/').filter(Boolean) : [];
  if (!text || text === '.') return parts.join('/');
  for (let part of text.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function hasGlob(text) {
  return /[*?[{]/.test(text);
}

async function expand(index, cwd, raw) {
  let path = resolvePath(cwd, raw);
  if (!hasGlob(raw)) return [path];
  let matches = [];
  for (let item of await index.all()) {
    if (minimatch(item, path, globOpts)) matches.push(item);
    if (!isKeep(item)) continue;
    let dir = item.slice(0, -'/.keep'.length);
    if (dir && minimatch(dir, path, globOpts)) matches.push(dir);
  }
  matches = [...new Set(matches)].sort();
  return matches.length ? matches : [path];
}

function rowsOf(group) {
  return Object.keys(group).map(key => Number(key)).sort((a, b) => a - b).map(lineNumber => {
    let row = group[lineNumber];
    return { lineNumber, line: row.line, match: row.match };
  });
}

function parseOpts(args, spec) {
  let opts = {};
  let rest = [];
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-' || arg === '--') {
      rest.push(arg);
      continue;
    }
    let cluster = arg.slice(1);
    for (let c = 0; c < cluster.length; c++) {
      let flag = cluster[c];
      let kind = spec[flag];
      if (!kind) throw shellError(`unknown option: -${flag}`, 1);
      if (kind === 'bool') {
        opts[flag] = true;
        continue;
      }
      let inline = cluster.slice(c + 1);
      let value = inline || args[++i];
      if (value == null || value === '') throw shellError(`option -${flag} requires a value`, 1);
      opts[flag] = Number(value);
      if (Number.isNaN(opts[flag])) throw shellError(`option -${flag} requires a number`, 1);
      break;
    }
  }
  return { opts, rest };
}

function grepContents(options, regex, contents) {
  if (options.nameOnly) {
    let lines = contents.split('\n');
    for (let line of lines) {
      let matched = line.match(regex);
      if ((options.inverse && !matched) || (!options.inverse && matched)) return true;
    }
    return false;
  }
  let lines = contents.split('\n');
  let matches = [];
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    let matched = line.match(regex);
    let hit = (options.inverse && !matched) || (!options.inverse && matched);
    if (!hit) continue;
    let lineNumber = index + 1;
    let result = {};
    if (matches.length) {
      let last = matches[matches.length - 1];
      let minimumLineNumber = Math.max(1, lineNumber - options.before - 1);
      if (last[lineNumber] || last[minimumLineNumber]) result = last;
    }
    result[lineNumber] = { line, match: true };
    if (options.before > 0) {
      let slice = lines.slice(Math.max(index - options.before, 0), index);
      for (let i = 0; i < slice.length; i++) {
        let lineNum = index - slice.length + i + 1;
        if (!result[lineNum]) result[lineNum] = { line: slice[i], match: false };
      }
    }
    if (options.after > 0) {
      let slice = lines.slice(index + 1, Math.min(index + options.after + 1, lines.length));
      for (let i = 0; i < slice.length; i++) {
        let lineNum = index + 2 + i;
        if (!result[lineNum]) result[lineNum] = { line: slice[i], match: false };
      }
    }
    if (!matches.includes(result)) matches.push(result);
  }
  return matches;
}

function formatGrepRow(file, row, lineNumber, prefixNames) {
  let prefix = prefixNames ? file + ':' : '';
  if (lineNumber) return prefix + row.lineNumber + (row.match ? ':' : '-') + row.line;
  return prefix + row.line;
}

function heredocText(redir) {
  if (redir.type === 'HereString') return (redir.target?.value || '') + '\n';
  let text = redir.body?.text || '';
  if (redir.operator === '<<-') text = text.split('\n').map(line => line.replace(/^\t+/, '')).join('\n');
  return text;
}

function escapeRegExp(text) {
  return String(text).replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
}

function parseGrepArgs(args) {
  let parsed = {
    patterns: [],
    files: [],
    ignoreCase: false,
    inverse: false,
    namesOnly: false,
    lineNumber: false,
    recursive: false,
    fixed: false,
    word: false,
    onlyMatching: false,
    withFilename: false,
    noFilename: false,
    quietErrors: false,
    before: null,
    after: null,
    include: [],
    exclude: [],
    excludeDir: [],
  };
  let sawPattern = false;
  let take = (i, flag) => {
    let value = args[i + 1];
    if (value == null) throw shellError(`grep: ${flag} requires an argument`, 2);
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg === '--') {
      if (!sawPattern && !parsed.patterns.length) {
        if (args[i + 1] == null) throw shellError('grep: no pattern given', 2);
        parsed.patterns.push(args[i + 1]);
        parsed.files.push(...args.slice(i + 2));
      } else {
        parsed.files.push(...args.slice(i + 1));
      }
      break;
    }
    if (arg.startsWith('--')) {
      let eq = arg.indexOf('=');
      let key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      let inline = eq === -1 ? null : arg.slice(eq + 1);
      if (key === 'include' || key === 'exclude' || key === 'exclude-dir') {
        let value = inline == null ? take(i, arg) : inline;
        if (inline == null) i += 1;
        if (key === 'include') parsed.include.push(value);
        else if (key === 'exclude') parsed.exclude.push(value);
        else parsed.excludeDir.push(value);
        continue;
      }
      if (key === 'regexp' || key === 'e') {
        let value = inline == null ? take(i, arg) : inline;
        if (inline == null) i += 1;
        parsed.patterns.push(value);
        sawPattern = true;
        continue;
      }
      if (key === 'before-context' || key === 'after-context' || key === 'context') {
        let value = inline == null ? take(i, arg) : inline;
        if (inline == null) i += 1;
        let n = Number(value);
        if (Number.isNaN(n)) throw shellError(`grep: ${arg} requires a number`, 2);
        if (key !== 'after-context') parsed.before = n;
        if (key !== 'before-context') parsed.after = n;
        continue;
      }
      if (key === 'ignore-case') parsed.ignoreCase = true;
      else if (key === 'invert-match') parsed.inverse = true;
      else if (key === 'files-with-matches') parsed.namesOnly = true;
      else if (key === 'line-number') parsed.lineNumber = true;
      else if (key === 'recursive' || key === 'dereference-recursive') parsed.recursive = true;
      else if (key === 'fixed-strings') parsed.fixed = true;
      else if (key === 'word-regexp') parsed.word = true;
      else if (key === 'only-matching') parsed.onlyMatching = true;
      else if (key === 'with-filename') parsed.withFilename = true;
      else if (key === 'no-filename') parsed.noFilename = true;
      else if (key === 'extended-regexp' || key === 'basic-regexp' || key === 'binary-files') {}
      else if (key === 'no-messages') parsed.quietErrors = true;
      else throw shellError(`grep: unknown option: --${key}`, 2);
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      let cluster = arg.slice(1);
      for (let c = 0; c < cluster.length; c++) {
        let flag = cluster[c];
        if ('vilnrRIFHwHoEs'.includes(flag)) {
          if (flag === 'v') parsed.inverse = true;
          else if (flag === 'i') parsed.ignoreCase = true;
          else if (flag === 'l') parsed.namesOnly = true;
          else if (flag === 'n') parsed.lineNumber = true;
          else if (flag === 'r' || flag === 'R') parsed.recursive = true;
          else if (flag === 'I') {}
          else if (flag === 'F') parsed.fixed = true;
          else if (flag === 'H') parsed.withFilename = true;
          else if (flag === 'h') parsed.noFilename = true;
          else if (flag === 'w') parsed.word = true;
          else if (flag === 'o') parsed.onlyMatching = true;
          else if (flag === 'E') {}
          else if (flag === 's') parsed.quietErrors = true;
          continue;
        }
        if (flag === 'e') {
          let inline = cluster.slice(c + 1);
          let value = inline || take(i, '-e');
          if (!inline) i += 1;
          parsed.patterns.push(value);
          sawPattern = true;
          break;
        }
        if (flag === 'A' || flag === 'B' || flag === 'C') {
          let inline = cluster.slice(c + 1);
          let value = inline || take(i, '-' + flag);
          if (!inline) i += 1;
          let n = Number(value);
          if (Number.isNaN(n)) throw shellError(`grep: -${flag} requires a number`, 2);
          if (flag !== 'A') parsed.before = n;
          if (flag !== 'B') parsed.after = n;
          break;
        }
        throw shellError(`grep: unknown option: -${flag}`, 2);
      }
      continue;
    }
    if (!sawPattern && !parsed.patterns.length) {
      parsed.patterns.push(arg);
      sawPattern = true;
    } else {
      parsed.files.push(arg);
    }
  }
  return parsed;
}

function grepSkip(path, parsed) {
  let base = baseName(path);
  if (parsed.exclude.some(glob => minimatch(base, glob, globOpts))) return true;
  if (parsed.include.length && !parsed.include.some(glob => minimatch(base, glob, globOpts))) return true;
  if (!parsed.excludeDir.length) return false;
  let parts = path.split('/');
  parts.pop();
  return parts.some(part => parsed.excludeDir.some(glob => minimatch(part, glob, globOpts)));
}

function grepOnly(regex, contents, inverse) {
  let lines = contents.split('\n');
  if (contents.endsWith('\n')) lines.pop();
  let rows = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
    let matcher = new RegExp(regex.source, flags);
    let found = regex.source ? [...line.matchAll(matcher)] : [];
    if (inverse) {
      if (!found.length) rows.push({ lineNumber: i + 1, text: line });
      continue;
    }
    for (let match of found) {
      if (!match[0]) continue;
      rows.push({ lineNumber: i + 1, text: match[0] });
    }
  }
  return rows;
}

function dropPrefix(paths, prefix) {
  for (let path of [...paths]) {
    if (path.startsWith(prefix)) paths.delete(path);
  }
}

function retargetPrefix(paths, from, to) {
  let moved = [];
  for (let path of [...paths]) {
    if (!path.startsWith(from)) continue;
    moved.push([path, to + path.slice(from.length)]);
  }
  for (let [path, next] of moved) {
    paths.delete(path);
    paths.add(next);
  }
}
