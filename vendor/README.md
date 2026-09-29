# Vendored libraries

Committed so the app runs with no network access and no package manager.

| File | Library | Version | Licence | Source URL |
| --- | --- | --- | --- | --- |
| `zxing.min.js` | [ZXing-js](https://github.com/zxing-js/library) (`@zxing/library`, UMD build) | 0.21.3 | Apache-2.0 | `https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js` |
| `JsBarcode.all.min.js` | [JsBarcode](https://github.com/lindell/JsBarcode) | 3.11.6 | MIT | `https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js` |
| `qrcode.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 1.4.4 | MIT | `https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js` |

## SHA-256

```
52e032534c3f98976ad95cb8c20baf80ed0cc83d42590602a8cf1db16e2e22ed  JsBarcode.all.min.js
18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780  qrcode.js
d7cc8f69dd70bdcf3ac00c9ae572bf2acb9f4132ba379c72df842e4db918652d  zxing.min.js
```

## Refreshing

```sh
curl -fsSL -o vendor/zxing.min.js      https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js
curl -fsSL -o vendor/JsBarcode.all.min.js https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js
curl -fsSL -o vendor/qrcode.js         https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js
```

## API notes worth knowing before upgrading

These were established by probing the vendored builds, and `app.js` depends on them:

- **`ZXing.RGBLuminanceSource` takes one luminance byte per pixel — not RGBA canvas data.**
  Passing `ImageData.data` directly produces no error and simply never decodes. `app.js`
  converts to greyscale itself before constructing the source.
- **No `MultiFormatReader.decodeMultiple`** and no `GenericMultipleBarcodeReader` in this build,
  so multiple codes are found by scanning overlapping tiles rather than in one pass.
- **JsBarcode has no Code 93 encoder**, and the `.all` bundle ships no MSI/pharmacode extras
  beyond what `JsBarcode.getModule(name)` reports. The dropdown is built by probing `getModule`
  at runtime rather than hardcoding a list.
- **`JsBarcode.getModule(name)` returns a function with no `.encode` method**, so the raw module
  bit-string is not reachable through it. `app.js` measures the rendered symbol instead (from the
  SVG `width` attribute divided by the module width) to compute module counts.
- JsBarcode renders to both `<svg>` and `<canvas>`; the vector form is used for preview and SVG
  export, the canvas form for PNG export.
