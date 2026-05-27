# Contributing

Thanks for contributing to BIOME!

## Branching Strategy

```
main        ← stable releases, tagged (v0.1.0, v0.2.0, ...)
  └── dev   ← integration branch, where work lands first
       └── feature/short-name   ← individual features/fixes
       └── fix/short-name       ← bug fixes
```

- **`main`** — Only merges from `dev`. Represents the last stable release. Tags mark releases.
- **`dev`** — Active development. All PRs target this branch.
- **`feature/xxx`** — Branched from `dev`, merged back into `dev`.
- **`fix/xxx`** — Bug fixes, same flow.

## Workflow

1. Branch from `dev`:
   ```
   git checkout dev && git pull
   git checkout -b feature/my-thing
   ```

2. Make changes, commit as usual.

3. Push your branch and open a PR against `dev`.

4. When `dev` is stable and tested, merge `dev` into `main` and tag:
   ```
   git checkout main && git merge dev
   git tag -a v0.3.0 -m "v0.3.0: description"
   git push origin main --tags
   ```

## Commit Messages

Short imperative style:
- `Fix AI plant cap bypass in topUpWithGrass`
- `Add tournament bracket visualization`
- `Shuffle simulation iteration order`

## Testing

Open `index.html` in a browser and run a game or tournament. Check browser console for errors. No automated test suite yet — PRs welcome.