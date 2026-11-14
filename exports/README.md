# Generated exports

Generated game exports belong here and are ignored. The sample's theme exporter
produces an asset/manifest ZIP, not a playable game or multiplayer deployment.

From the Git root, after confirming credits:

```powershell
npm run credits --prefix games/sample
npm run theme:export --prefix games/sample -- --output ..\..\exports\sample-theme-assets.zip
```

The exporter refuses to overwrite an existing output. Sample Vite builds remain
in the ignored `games\sample\dist\` directory.
