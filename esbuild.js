// Bundles the extension into a single file so the published .vsix does not
// carry node_modules. Run with --watch during development, --production to
// minify for a release.
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** Reports bundle failures in a form the VS Code problem matcher understands. */
const reportPlugin = {
  name: 'report',
  setup(build) {
    build.onEnd((result) => {
      for (const error of result.errors) {
        const at = error.location;
        console.error(
          at
            ? `✘ ${at.file}:${at.line}:${at.column}: ${error.text}`
            : `✘ ${error.text}`
        );
      }
      if (result.errors.length === 0) {
        console.log(`bundle ok${watch ? ' (watching)' : ''}`);
      }
    });
  }
};

async function main() {
  const context = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    // Provided by the editor at runtime; bundling it would break activation.
    external: ['vscode'],
    minify: production,
    sourcemap: !production,
    logLevel: 'silent',
    plugins: [reportPlugin]
  });

  if (watch) {
    await context.watch();
  } else {
    await context.rebuild();
    await context.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
