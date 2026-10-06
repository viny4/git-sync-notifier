// Shared helpers: a tiny assertion harness, throwaway git repositories, and a
// `vscode` stub so the bundled extension can be driven from plain Node.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const results = { pass: 0, fail: 0 };

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? results.pass++ : results.fail++;
  console.log(
    `  ${ok ? '✓' : '✗ FAIL'} ${label}` +
      (ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  );
  return ok;
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Commit `content` to `file` as `author`, with no dependency on global config. */
function commitAs(repo, author, file, content, message) {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, 'add', '.');
  git(
    repo,
    '-c',
    `user.name=${author}`,
    '-c',
    `user.email=${author}@example.com`,
    'commit',
    '-q',
    '-m',
    message
  );
}

/** A bare "remote" plus a clone of it, with one commit pushed. */
function makeRepoPair(root, name, branch = 'main') {
  git(root, 'init', '-q', '--bare', '-b', branch, `${name}.git`);
  const bare = path.join(root, `${name}.git`);
  git(root, 'clone', '-q', bare, name);
  const work = path.join(root, name);
  commitAs(work, 'Dev', 'a.txt', 'a\n', 'initial');
  git(work, 'push', '-q', '-u', 'origin', branch);
  return { bare, work };
}

/** Pushes `count` commits to `bare` through a throwaway second clone. */
function pushUpstreamCommits(root, bare, name, count, branch = 'main', author = 'Peer') {
  const peer = path.join(root, `${name}-peer-${Date.now()}`);
  git(root, 'clone', '-q', bare, path.basename(peer));
  for (let i = 0; i < count; i++) {
    commitAs(peer, author, 'b.txt', `b${i}\n`, `upstream change ${i}`);
  }
  git(peer, 'push', '-q', 'origin', branch);
  return peer;
}

/**
 * Minimal `vscode` module. Everything the extension touches is here; anything
 * it starts touching will throw loudly rather than silently pass.
 */
function makeVsCodeStub({ workspaceFolders = [], repositories, answers = {} } = {}) {
  const recorded = { toasts: [], logs: [], quickPicks: [], statusText: '' };

  const gitApi = repositories && {
    repositories: repositories.map((root) => ({ rootUri: { fsPath: root, scheme: 'file' } })),
    onDidOpenRepository: (listener) => {
      recorded.openRepositoryListener = listener;
      return { dispose() {} };
    },
    onDidCloseRepository: () => ({ dispose() {} })
  };

  const stub = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    FileType: { Directory: 2, File: 1 },
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    MarkdownString: class {
      constructor() {
        this.value = '';
      }
      appendMarkdown(markdown) {
        this.value += markdown;
        return this;
      }
    },
    Uri: {
      file: (fsPath) => ({ fsPath, scheme: 'file' }),
      joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts), scheme: 'file' })
    },
    extensions: {
      getExtension: (id) =>
        gitApi && id === 'vscode.git'
          ? { isActive: true, exports: { getAPI: () => gitApi } }
          : undefined
    },
    commands: {
      executeCommand: async () => undefined,
      registerCommand: () => ({ dispose() {} })
    },
    workspace: {
      workspaceFolders: workspaceFolders.map((fsPath) => ({
        uri: { fsPath, scheme: 'file' },
        name: path.basename(fsPath)
      })),
      fs: {
        readDirectory: async (uri) =>
          fs
            .readdirSync(uri.fsPath, { withFileTypes: true })
            .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1])
      },
      getConfiguration: () => ({ get: (key, fallback) => answers.config?.[key] ?? fallback }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} })
    },
    window: {
      activeTextEditor: undefined,
      createStatusBarItem: () => ({
        set text(value) {
          recorded.statusText = value;
        },
        get text() {
          return recorded.statusText;
        },
        set tooltip(value) {
          recorded.tooltip = value;
        },
        get tooltip() {
          return recorded.tooltip;
        },
        set backgroundColor(_value) {},
        set name(_value) {},
        set command(_value) {},
        show() {},
        hide() {
          recorded.statusText = '(hidden)';
        },
        dispose() {}
      }),
      createOutputChannel: () => ({
        appendLine: (line) => recorded.logs.push(line),
        show() {},
        dispose() {}
      }),
      showInformationMessage: async (message, ...buttons) => {
        recorded.toasts.push(message);
        recorded.lastButtons = buttons;
        return answers.informationMessage?.(message, buttons);
      },
      showWarningMessage: async (message, ...buttons) => {
        recorded.toasts.push(`WARN: ${message}`);
        return answers.warningMessage?.(message, buttons);
      },
      showQuickPick: async (items, options) => {
        recorded.quickPicks.push({ items, options });
        return answers.quickPick?.(items, options);
      },
      showTextDocument: async () => undefined,
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      onDidChangeWindowState: () => ({ dispose() {} })
    }
  };

  return { stub, recorded };
}

/** Loads the bundled extension with `vscode` replaced by the stub. */
function loadExtension(stub, bundlePath) {
  const original = Module._load;
  Module._load = (request, parent, isMain) =>
    request === 'vscode' ? stub : original(request, parent, isMain);
  const resolved = require.resolve(bundlePath);
  delete require.cache[resolved];
  const extension = require(resolved);
  return {
    extension,
    restore: () => {
      Module._load = original;
    }
  };
}

function fakeContext() {
  const store = new Map();
  return {
    subscriptions: [],
    workspaceState: {
      get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
      update: async (key, value) => void store.set(key, value)
    }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  results,
  check,
  section,
  tempDir,
  git,
  commitAs,
  makeRepoPair,
  pushUpstreamCommits,
  makeVsCodeStub,
  loadExtension,
  fakeContext,
  sleep
};
