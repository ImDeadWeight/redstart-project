# Third-party notices

Redstart is distributed under the MIT License (see
[`redstart-nest/LICENSE.txt`](redstart-nest/LICENSE.txt)). The installers ship
third-party software alongside it. This file records what that software is and
under what terms, as those licenses require.

Two categories matter, and they are kept separate because they arrive by
different routes and are verified differently:

1. **Bundled native binaries** — copied into the installer by
   `electron-builder.json` from paths that are *not* in this repository. These
   are the ones a reader cannot verify from a clone, so they are enumerated
   here explicitly.
2. **npm dependencies** — resolved from `package-lock.json` and packaged into
   `app.asar`. These are machine-enumerable; the summary and generation command
   are below.

---

## 1. Bundled native binaries

### llama-server and its runtime libraries

Redstart Nest bundles `llama-server.exe` and its accompanying runtime DLLs,
built from **TurboQuant+** — a fork of **llama.cpp** that adds advanced weight
and KV-cache quantization.

- Upstream project: llama.cpp — <https://github.com/ggerganov/llama.cpp>
- Fork used for the bundled build: TurboQuant —
  <https://github.com/TheTom/llama-cpp-turboquant>
- License: MIT
- Copyright (c) 2023-2026 The ggml authors

Verified directly against the fork's own `LICENSE` file (not assumed from
upstream) — the fork does not add a separate copyright holder line, and its
copyright year range is 2023-2026, not the 2023-2024 carried by upstream at
the time this fork was taken.

These binaries are **not committed to this repository** — the
`redstart-nest/llama-cpp-turboquant/` tree and `redstart-nest/deps/` are
git-ignored and assembled at build time (see
[docs/development.md](docs/development.md)). They are present only in built
installers.

The MIT license text applying to the above:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

### elevate.exe

Bundled at the installer root and used to create Windows Firewall inbound rules
when network mode is enabled, so UAC prompts once per rule rather than
repeatedly.

Identified from the shipped binary's own version resource
(`redstart-nest/deps/windows/elevate.exe`: CompanyName "Johannes Passing",
ProductName "Elevate Application", Copyright "(C) 2007") and matched to its
upstream source:

- Origin: <https://github.com/jpassing/elevate>
- Author: Johannes Passing
- License: MIT, per the repository's `LICENSE.md`

Copyright line (the repository's `LICENSE.md` leaves both fields blank, so the
year is taken from the binary's own compiled resource above):

> Copyright (c) 2007 Johannes Passing

**Noted for the record, not a blocker:** the individual source files
(`Elevate/main.c`, `Elevate/stdafx.h`) carry a leftover LGPL 2.1+ header
comment that was never updated. `LICENSE.md` and those source files were added
in the same initial commit (2013-10-19), so this reads as boilerplate the
author carried over and didn't edit, not a later relicense — the repository's
top-level `LICENSE.md` is treated as authoritative here, consistent with
standard practice. If this is ever challenged, the fallback position is to
treat `elevate.exe` as LGPL 2.1+ and satisfy that license's terms instead.

The MIT license text applying to the above:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

### NVIDIA CUDA runtime (cuBLAS)

`redstart-nest/deps/windows/` bundles `cublas64_13.dll` and
`cublasLt64_13.dll` for GPU-accelerated inference. Identified from the
binaries' own version resources: CompanyName "NVIDIA Corporation", "NVIDIA
CUDA BLAS Library, Version 13.5.1", Copyright "NVIDIA Corporation 2010-2026".

**This is NOT MIT.** These are redistributable components of the CUDA Toolkit,
governed by the NVIDIA CUDA Toolkit End User License Agreement, Attachment A
(cuBLAS is explicitly listed there as redistributable):

- License: NVIDIA CUDA Toolkit EULA, Attachment A —
  <https://docs.nvidia.com/cuda/eula/index.html>
- Copyright (c) 2010-2026 NVIDIA Corporation

Obligations that attach to redistributing these files, per that agreement:

- NVIDIA's copyright and proprietary notices must not be removed from the
  files.
- No reverse engineering, decompiling, or disassembling the SDK or copies of
  it.
- The application redistributing these files must have material additional
  functionality beyond the redistributed component itself (Redstart's own
  inference stack, gateway, and UI satisfy this).
- Downstream users must be bound by terms no less restrictive than NVIDIA's
  agreement — Redstart's own MIT license does not itself grant broader rights
  to these specific files, so this file's notice is what carries that
  obligation forward.

<!-- VERIFY BEFORE PUBLISHING: confirm the CUDA Toolkit version actually used
     to build the bundled 13.5.1 binaries has an EULA at the URL above with
     unchanged Attachment A terms — NVIDIA revises the EULA per toolkit
     release, and the canonical URL always reflects the current one, not
     necessarily the one that shipped with 13.5.1. Pull the EULA.txt that
     ships inside that specific toolkit installer and compare before release. -->

### Microsoft Visual C++ Runtime

`redstart-nest/deps/windows/` also bundles `MSVCP140.dll`, `VCOMP140.DLL`,
`VCRUNTIME140.dll`, and `VCRUNTIME140_1.dll` (version 14.50.35719.0, per their
own version resources) — the Visual C++ 2015-2022 Redistributable runtime,
required by the native binaries built with MSVC.

- License: Microsoft Visual C++ Runtime license terms —
  <https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/>
- Copyright © Microsoft Corporation. All rights reserved.

These are Microsoft's standard redistributable runtime components — the same
files nearly every native Windows application built with MSVC ships alongside
itself — distributed unmodified, which is the ordinary case the redistributable
license terms are written for.

### Electron and Chromium

Redstart Nest and Redstart Twig are Electron applications; the installers
include the Electron runtime, which embeds Chromium and Node.js.

- Electron — MIT, Copyright (c) Electron contributors and Copyright (c) 2013-2020 GitHub Inc.
- Chromium — BSD-3-Clause and others, Copyright (c) The Chromium Authors
- Node.js — MIT, Copyright Node.js contributors

Electron ships its own `LICENSES.chromium.html` covering the full Chromium
dependency set. `electron-builder` places it in the packaged output; it should
remain there and must not be pruned.

---

## 2. npm dependencies

The packaged application includes the non-development dependency tree resolved
by `redstart-nest/package-lock.json` — **403 packages** as of the current
lockfile.

License distribution:

| License | Packages |
|---|---|
| MIT | 320 |
| ISC | 38 |
| BSD-2-Clause | 17 |
| BlueOak-1.0.0 | 6 |
| BSD-3-Clause | 6 |
| Apache-2.0 | 5 |
| MIT/X11 | 2 |
| (MIT OR GPL-3.0-or-later) | 1 |
| (MIT AND Zlib) | 1 |
| Python-2.0 | 1 |
| Unlicense | 1 |
| 0BSD | 1 |
| BSD (unversioned) | 1 |
| Stated in package LICENSE file | 1 |
| Not stated in package metadata | 2 |

All are permissive. `jszip` is dual-licensed MIT or GPL-3.0-or-later; **MIT is
the license elected here.** No package in the shipped tree is copyleft-only.

### Direct runtime dependencies

| Package | Version | License |
|---|---|---|
| `@modelcontextprotocol/server-filesystem` | 2026.7.10 | MIT (stated in the package's own LICENSE file) |
| `@mozilla/readability` | 0.6.0 | Apache-2.0 |
| `@types/qrcode` | 1.5.6 | MIT |
| `bonjour-service` | 1.4.3 | MIT |
| `docx` | 9.7.1 | MIT |
| `electron-updater` | 6.8.9 | MIT |
| `exceljs` | 4.4.0 | MIT |
| `linkedom` | 0.18.13 | ISC |
| `mammoth` | 1.12.0 | BSD-2-Clause |
| `pdf-parse` | 2.4.5 | Apache-2.0 |
| `pdfkit` | 0.15.2 | MIT |
| `pg` | 8.22.0 | MIT |
| `qrcode` | 1.5.4 | MIT |
| `react` | 19.2.7 | MIT |
| `react-dom` | 19.2.7 | MIT |
| `sql.js` | 1.14.1 | MIT |

### Apache-2.0 packages

Apache-2.0 requires that any `NOTICE` file distributed with a work be
reproduced. Where an Apache-2.0 dependency ships a `NOTICE`, its contents are
included in the generated appendix described below rather than restated here.

### Full attribution appendix

Enumerating 403 packages by hand guarantees drift. Generate the complete list —
package, version, license, copyright holder, and full license text — as part of
the release process:

```bash
npx license-checker-rseidelsohn \
  --production \
  --relativeLicensePath \
  --files licenses/npm \
  --out licenses/npm-licenses.json
```

The generated `licenses/` folder is included in the installer through
`electron-builder.json`'s `extraResources`.

<!-- Add to electron-builder.json extraResources:
     { "from": "licenses", "to": "licenses", "filter": ["**/*"] }
     and add LICENSE.txt + THIRD-PARTY-NOTICES.md alongside it, so the
     compliance files are present in an installed copy and not only in the
     repository. -->

---

## Verifying this file is accurate

Attribution that lives only in the repository does not satisfy a distribution
requirement — the notices have to be *in the artifact*. Add to the release
checklist:

- [ ] `THIRD-PARTY-NOTICES.md`, `LICENSE.txt`, and `licenses/` are present in
      the installed application directory after running the installer.
- [ ] The npm license appendix was regenerated against the current lockfile,
      not carried over from a previous release.
- [ ] Every bundled native binary in `bin/` has an entry in section 1 above.
      A DLL that appears in the build output with no entry here is a blocker,
      not a footnote.
- [ ] Electron's `LICENSES.chromium.html` survived packaging.
- [ ] The NVIDIA CUDA EULA URL in the cuBLAS entry above still matches the
      EULA shipped inside the CUDA Toolkit installer actually used to build
      the current `cublas64_*.dll` / `cublasLt64_*.dll`.

---

*Corrections welcome. If you believe your work is included here without proper
attribution, please open an issue or use the contact route in
[SECURITY.md](SECURITY.md) and it will be fixed.*
