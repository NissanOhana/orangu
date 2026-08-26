# Orangu brand assets

This directory contains the current raster mascot and favicon set. All images have transparent backgrounds.

## Assets

| File | Use |
|---|---|
| `mascot-main-transparent.png` | Master raster and README image |
| `mascot-main-320.png` | Landing-page large mascot |
| `mascot-96.png` | Shared landing, report, and localhost app mark |
| `favicon-512.png` | Large icon source |
| `favicon-180.png` | Apple touch icon |
| `favicon-64.png` | Mid-size icon |
| `favicon-32.png` | Small favicon |
| `favicon-16.png` | Smallest favicon |

`scripts/build.mjs` embeds the appropriate assets into generated public files. The report renderer embeds `mascot-96.png` once as a data URI and reuses it for every in-app logo placement.

## Regeneration

If the master changes, create the downscaled set with a high-quality image resampler and then run `npm run build`:

```bash
for size in 512 180 64 32 16; do
  sips -Z "$size" design/brand/mascot-main-transparent.png --out "design/brand/favicon-$size.png"
done
sips -Z 320 design/brand/mascot-main-transparent.png --out design/brand/mascot-main-320.png
sips -Z 96 design/brand/mascot-main-transparent.png --out design/brand/mascot-96.png
npm run build
```

Keep the master background transparent and verify the mark at 16px before replacing generated assets.

## License

The Orangu mascot artwork is released under CC0.
