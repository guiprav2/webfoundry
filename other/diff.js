export function applyPatch(patchText, files, { strict = true } = {}) {
  let lines = patchText.split(/\r?\n/);
  let i = 0;

  let pushback = null;
  function nextLine() {
    if (pushback !== null) {
      let x = pushback;
      pushback = null;
      return x;
    }
    return lines[i++] ?? null;
  }
  function unread(line) {
    pushback = line;
  }

  while (i < lines.length) {
    let line = nextLine();
    if (line === "*** Begin Patch") {
      let update = nextLine();
      let m = /^\*\*\* Update File: (.+)$/.exec(update);
      if (!m) throw new Error("Malformed patch: missing Update File");
      let filename = m[1].trim();

      let original = files[filename];
      if (original == null)
        throw new Error(`File not provided: ${filename}`);

      let newText = applyFilePatch(filename, original, nextLine, unread, strict);
      files[filename] = newText;

      let end = nextLine();
      if (end !== "*** End Patch")
        throw new Error("Malformed patch: missing End Patch");
    }
  }

  return files;
}

function applyFilePatch(filename, original, nextLine, unread, strict) {
  let out = original.split(/\r?\n/);

  while (true) {
    let line = nextLine();
    if (line == null || line === "*** End Patch") {
      if (line === "*** End Patch") unread(line);
      break;
    }

    // CHATGPT HUNK HEADER
    if (line.trim() !== "@@") continue;

    // Minimal hunk format — no positions
    // Apply changes sequentially

    let oldPos = 0;
    let newPos = 0;

    while (true) {
      let l = nextLine();
      if (l == null || l.trim() === "@@" || l === "*** End Patch") {
        unread(l);
        break;
      }

      if (l.startsWith(" ")) {
        let expect = l.slice(1);
        if (strict) {
          if (out[oldPos] !== expect)
            throw new Error(
              `Context mismatch in ${filename}\nExpected: "${expect}"\nFound: "${out[oldPos]}"`
            );
        }
        oldPos++;
        newPos++;
      }

      else if (l.startsWith("-")) {
        let expect = l.slice(1);
        if (strict) {
          if (out[oldPos] !== expect)
            throw new Error(
              `Remove mismatch in ${filename}\nExpected: "${expect}"\nFound: "${out[oldPos]}"`
            );
        }
        out.splice(oldPos, 1);
      }

      else if (l.startsWith("+")) {
        out.splice(newPos, 0, l.slice(1));
        newPos++;
      }

      else {
        throw new Error(`Invalid hunk line in ${filename}: ${l}`);
      }
    }
  }

  return out.join("\n");
}
