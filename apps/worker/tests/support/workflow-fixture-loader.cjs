// Only test bundles use this loader; production sources and bundles stay untouched.
module.exports = function workflowFixtureLoader(source) {
  const { legacy, extraTimer } = this.getOptions();
  if (legacy) {
    const patch = 'patched("room-background-continuation-v1")';
    if (!source.includes(patch)) throw new Error("Legacy supervisor fixture needs an explicit update");
    source = source.replace(patch, "false");
  }
  if (extraTimer) {
    const entry = /export async function dotGoalWorkflow\([^\n]+\{\r?\n/;
    if (!entry.test(source)) throw new Error("Negative replay fixture needs an explicit update");
    source = source.replace(entry, '$&  await condition(() => false, "1 second");\n');
  }
  return source;
};
