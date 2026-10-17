# Vendored shell grammars

These WebAssembly grammar files are packaged with the sidecar, so command
analysis does not require network access or an installed shell parser.

| File | npm source | License |
| --- | --- | --- |
| `tree-sitter-bash.wasm` | `tree-sitter-bash@0.25.1` | MIT, `LICENSE.bash` |
| `tree-sitter-powershell.wasm` | `tree-sitter-powershell@0.26.4` | MIT, `LICENSE.powershell` |

The files are the prebuilt WASM assets distributed in those npm releases.
`web-tree-sitter@0.25.10` supplies the runtime; the packaging helper copies its
`tree-sitter.wasm` and MIT license next to these grammars in `lib/grammars`.

To update, fetch the pinned npm tarballs, replace each prebuilt `.wasm` and its
license, update this table and the dependency pin where applicable, and run the
shell parser and parser asset packaging tests. Never download grammars at
runtime. Unsupported syntax and initialization failures require approval.
