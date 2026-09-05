# demo-app — deliberately broken code

**This directory is not part of the application. Do not deploy it, import it,
or copy from it.** Every file here contains bugs on purpose.

It exists to validate PR Analyzer end-to-end against a **real** pull request:
open a PR from this branch, point the analyzer at it, and check that the
findings it reports match the list below. Unit tests and the built-in demo
fixture both stub out GitHub; this is the only way to confirm the whole path
— fetch, parse, rank, anchor, post a review comment, then re-review and see
what got fixed — actually works against the live API.

## What the analyzer should find

**`demo-app/api/orders.js`** — 11 static SQL rules, one per function:

| Function | Rule | Severity |
|---|---|---|
| `findOrdersByCustomer` | SQL built by string interpolation | critical |
| `purgeCancelled` | DELETE with no WHERE clause | critical |
| `listAll` | SELECT * over-fetches | high |
| `listAll` | ORDER BY with no LIMIT | low |
| `searchByEmail` | LIKE '%…' cannot use an index | high |
| `findByLoweredName` | LOWER() wrapped around a filtered column | medium |
| `customersWithoutOrders` | NOT IN (SELECT …) has a NULL trap | medium |
| `joinLegacy` | Implicit comma join | medium |
| `pageDeep` | OFFSET 5000 scans and discards rows | medium |
| `enrichOrders` | Query inside a loop (N+1) | high |
| `allProducts` | Unbounded findMany | high |

`listAll` trips two rules from one statement, which is intended — both are
real and independently actionable.

**`demo-app/components/`** — 3 graph checks:

- `CheckoutPanel` passes `itemCount="3"` where `OrderSummary` declares
  `itemCount: number` → **prop type mismatch**
- `CheckoutPanel` passes `discountPercent` which `PromoBanner` does not
  accept → **prop name mismatch**
- `useEffect` reads `cartId` but has `[]` deps → **missing hook dependency**

The two prop problems sit on **different elements** on purpose: the parser
checks names first and only checks literal types when every name matched, so
putting both on one element would silently exercise only half the rule.

**`demo-app/api/auth.js`** — targets for the in-depth (AI) review, which
static rules cannot catch: a credential in source, a promise never awaited, an
unguarded dereference, a swallowed error, and a destructive route with no auth
check. These are model output, so the exact set will vary between runs — that
is expected, and why they are not listed as a fixed count.

The credential in that file is **not a real key**. It is written in an
obviously fake format specifically so it does not trip GitHub push protection
or a vendor's secret scanner.

**`demo-app/legacy/`** — a PHP controller, so the third parser participates
and the run reports `php+javascript+react`.

## Testing the re-review loop

1. Open a PR from this branch and analyze it — this is the baseline.
2. Fix one finding (parameterizing the query in `findOrdersByCustomer` is the
   clearest), commit, and push.
3. Hit **Refresh**. It should report that finding as **fixed** and leave the
   rest **still open**.
4. Revert the fix and push again. It should now read **regressed**, not "new"
   — fingerprints are derived from normalized code, so a risk that returns is
   recognised as the same one.
