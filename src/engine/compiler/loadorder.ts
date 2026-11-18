// Emuera Config.getFiles: with SortWithFilename the files of a directory are sorted (Array.Sort, culture compare),
// then each sub-directory (also sorted) is visited recursively. Without it the OS enumeration order is used,
// which for us is the order the caller supplied.
const coll = new Intl.Collator('en');

export function sortLoadOrder<T extends { path: string }>(files: T[]): T[] {
  type Dir = { files: T[]; dirs: Map<string, Dir> };
  const root: Dir = { files: [], dirs: new Map() };
  for (const f of files) {
    const parts = f.path.split(/[\\/]/);
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let n = d.dirs.get(parts[i]);
      if (!n) d.dirs.set(parts[i], (n = { files: [], dirs: new Map() }));
      d = n;
    }
    d.files.push(f);
  }
  const out: T[] = [];
  const walk = (d: Dir) => {
    out.push(...d.files.slice().sort((a, b) => coll.compare(a.path, b.path)));
    for (const k of [...d.dirs.keys()].sort((a, b) => coll.compare(a, b))) walk(d.dirs.get(k)!);
  };
  walk(root);
  return out;
}

/**
 * Profile 'puchi' (PuchiEmuera = Emuera 1.821 Config.getFiles): with SortWithFilename the SUB-DIRECTORIES of a directory are visited first and then its own files, both sorted with
 * string.Compare(x, y, OrdinalIgnoreCase) (upper-cased UTF-16 code units, so '.' sorts before '_' and digits before letters). EM+EE does the opposite (own files first, culture compare),
 * which matters when two files define the same function: the first definition wins, and eraSumireTeru's COM/COMABLE_DUMMY.ERB says outright that a same-named function in COM/COMABLE.ERB
 * "hides" it; with the culture compare the dummy (every command available) came first and the whole command list showed every command.
 */
export function sortLoadOrderPuchi<T extends { path: string }>(files: T[]): T[] {
  type Dir = { files: T[]; dirs: Map<string, Dir> };
  const root: Dir = { files: [], dirs: new Map() };
  for (const f of files) {
    const parts = f.path.split(/[\\/]/);
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let n = d.dirs.get(parts[i]);
      if (!n) d.dirs.set(parts[i], (n = { files: [], dirs: new Map() }));
      d = n;
    }
    d.files.push(f);
  }
  const key = (x: string) => x.toUpperCase();
  const cmp = (a: string, b: string) => {
    const x = key(a),
      y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const base = (p: string) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
  const out: T[] = [];
  const walk = (d: Dir) => {
    for (const k of [...d.dirs.keys()].sort(cmp)) walk(d.dirs.get(k)!);
    out.push(...d.files.slice().sort((a, b) => cmp(base(a.path), base(b.path))));
  };
  walk(root);
  return out;
}
