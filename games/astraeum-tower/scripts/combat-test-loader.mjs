const themeSdk = new URL(
  "../../sample/node_modules/@multiplayer-game/theme-sdk/dist/index.js",
  import.meta.url
);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@multiplayer-game/theme-sdk") {
    return { url: themeSdk.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
