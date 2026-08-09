# Circuit artifacts (gitignored)

The `/demo` page proves in-browser and fetches two artifacts from here:

- `ActaPresentation.wasm` — witness calculator (~6.5 MB)
- `acta_dev.zkey` — Groth16 proving key, DEV ceremony, not production (~21.5 MB)

They are build outputs, not source. Regenerate + copy from the repo root:

```sh
make setup            # compile circuit + dev ceremony (once)
make webdemo-assets   # cp into this directory
```
