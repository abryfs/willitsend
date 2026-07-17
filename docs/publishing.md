# Publishing willitsend to the MCP directories

This repo ships the metadata every MCP directory needs. Two steps require
interactive credentials and can only be run by a maintainer: the npm publish and
the one-time MCP Registry login. Everything else — the manifests, the version
sync, the CI workflow — is already wired up.

## What lives where

| File | Directory it feeds |
| --- | --- |
| `server.json` | Official [MCP Registry](https://registry.modelcontextprotocol.io) (`io.github.abryfs/willitsend`) |
| `smithery.yaml` | [Smithery](https://smithery.ai) |
| `glama.json` | [Glama](https://glama.ai/mcp) (claims maintainership; Glama auto-indexes from GitHub) |
| `package.json` `mcpName` | npm ownership marker the registry verifies against |

Keep `version` in `server.json` (both the top-level field and `packages[0].version`)
equal to the npm-published version. The `publish-mcp` workflow does this
automatically; if you publish by hand, set them yourself.

## One-time / per-release: npm

The official registry hosts metadata only — the runnable artifact must live on
npm first.

```sh
npm ci
npm run build          # produces dist/
npm login              # interactive
npm publish            # publishConfig.access=public is set
```

Verify: <https://www.npmjs.com/package/willitsend>

After this, the default bin resolves the MCP server, so `npx -y willitsend`
starts the stdio server. The CLI is `willitsend-cli`
(`npx -y -p willitsend willitsend-cli --help`).

## Per-release: official MCP Registry

```sh
brew install mcp-publisher     # or grab the release binary from
                               # github.com/modelcontextprotocol/registry/releases
mcp-publisher login github     # interactive device-code auth as abryfs
mcp-publisher publish          # reads server.json
```

Verify:

```sh
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.abryfs/willitsend"
```

## Automate both (recommended)

`.github/workflows/publish-mcp.yml` runs the npm publish and the registry
publish on any `v*` tag. It authenticates to the registry with GitHub OIDC (no
secret needed for the `io.github.abryfs/*` namespace). Add one repo secret first:

- `NPM_TOKEN` — an npm automation token with publish rights.

Then cut a release:

```sh
git tag v0.1.0
git push origin v0.1.0
```

## Seed the remaining directories

- **Smithery**: `smithery.yaml` is in place → `smithery mcp publish https://github.com/abryfs/willitsend -n abryfs/willitsend`, or use the smithery.ai dashboard.
- **Glama**: auto-indexes from GitHub; `glama.json` claims maintainership. Nothing to submit — check glama.ai/mcp after a crawl.
- **PulseMCP**: submit at pulsemcp.com (it also crawls the official registry).
- **mcp.so**: Submit button / GitHub issue.
- **awesome-mcp-servers** (<https://github.com/punkpeye/awesome-mcp-servers>): open a PR adding this line alphabetically under Communication (or a Messaging/Telephony section), adjusting the emoji legend to match the current README:

  ```markdown
  - [abryfs/willitsend](https://github.com/abryfs/willitsend) 📇 🏠 - Deterministic preflight for outbound SMS/iMessage: catches silent carrier filtering, GSM-7/UCS-2 segment blowups, and dropped iMessage features before your agent sends. Zero-dependency, no telemetry.
  ```

  Legend: 📇 = TypeScript, 🏠 = runs locally (stdio).
