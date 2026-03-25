# TypeScript TODO

## Setup

* initialize `typescript/` as a single `@kumofire/jobs` package
* create the initial `package.json`
* add `tsconfig`
* add `biome`
* add `vitest`
* add `tsdown`
* add minimal npm scripts
  * `build`
  * `test`
  * `lint`
  * `format`

## Minimal Implementation

* create the minimum source layout
* expose a single public method
* make that method return `hello kumofire/jobs!`
* add one minimal test for that method
* confirm the package can build cleanly

## Publish Setup

* prepare package metadata for npm publish
* decide which files should be published
* add a GitHub Actions workflow for npm publish
* configure publishing with npm token secret
* publish on version tags such as `v0.1.0`

## After Minimal Publish

* define the real public API surface
  * `createJobs`
  * `create`
  * `dispatch`
  * `consume`
  * `getStatus`
* define the protocol-facing types
* write lifecycle unit tests against an in-memory implementation first
* define the insertion points for storage and queue adapters
