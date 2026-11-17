const sample = new URL("../../games/sample/package.json", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (["@multiplayer-game/theme-sdk", "@multiplayer-game/local-preview"].includes(specifier)) {
    return nextResolve(specifier, { ...context, parentURL: sample });
  }
  return nextResolve(specifier, context);
}
