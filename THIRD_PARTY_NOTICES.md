# Third-party notices

The repository's MIT license applies to original Sun-Ray Lab source and its
procedural SUNLIGHT demonstration geometry. It does not relicense dependencies,
Jim Sanborn's *Kryptos*, reference photographs, or locally imported models.

## Runtime dependencies

- **Three.js** — Copyright 2010–2025 three.js authors, MIT.
  [Included license](docs/licenses/three.txt), [upstream](https://github.com/mrdoob/three.js).
- **three-mesh-bvh** — Copyright 2018 Garrett Johnson, MIT.
  [Included license](docs/licenses/three-mesh-bvh.txt), [upstream](https://github.com/gkjohnson/three-mesh-bvh).
- **Google Draco** — Apache License 2.0. The asset preparation script copies
  decoder files from the installed Three.js package into the generated build;
  they are not checked into this repository.
  [Included license](docs/licenses/draco.txt), [upstream](https://github.com/google/draco).

The lockfile records all packages. Build and development dependencies retain
the licenses distributed in their packages.

## Optional local assets

Bret L. Bowen's original model README permits distribution only as its original
ZIP. The converted and modified GLB models and model-derived layout are not
included in this repository. Importing a local copy does not grant permission
to redistribute it. The original application used a macOS system font when
rebuilding that screen; no system font or those derived models are bundled.

An optional local photograph is by Carol M. Highsmith, **Kryptos sculpture**,
Library of Congress item **2011631531**. The Library's rights advisory is
“No known restrictions on publication.” Suggested credit: Photographs in the
Carol M. Highsmith Archive, Library of Congress, Prints and Photographs Division.
[Catalog record and rights advisory](https://www.loc.gov/pictures/item/2011631531/).

The included demo uses original code-generated stencil outlines, with no
external font, extracted sculpture geometry, or photograph.
