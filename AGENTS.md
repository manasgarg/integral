# Project instructions

Speak in plain English.

## TypeScript workflow

- Use the project-local Node.js and npm tooling. Do not rely on globally
  installed formatters, linters, compilers, or test runners.
- Run `npm run check` before committing a completed increment. The gate checks
  formatting, TypeScript types, typed lint rules, tests and coverage, behavior
  references, and package metadata.
- Run `npm run format` after editing supported source or documentation files.
  Never auto-format files under `behavior/`; their literal tab indentation is
  part of the executable product contract.
- Keep TypeScript strict. Do not weaken compiler options or lint rules to make a
  change pass. Narrow unknown values, model data explicitly, and keep unsafe
  assertions at validated system boundaries.
- Prefer Node.js built-ins over adding dependencies when they provide the
  required behavior. Use `node:test` for automated tests and keep tests
  deterministic and isolated from external services.
- Add tests for changed behavior and include the relevant stable behavior ID in
  each test name.
- Pin development-tool versions exactly. Review lockfile changes and do not add
  overlapping tools that perform the same job.
- Use `npm run package:check` after changing package entry points or published
  files, and use `npm run pack:check` to inspect the package tarball before a
  release.

## Git workflow

- This project uses Git from the beginning.
- Commit each coherent, completed increment as work progresses.
- Before committing, inspect the working tree and include only changes that
  belong to the current increment.
- Use a concise commit message that states the completed outcome.
- Do not leave completed work uncommitted unless the user asks for that.

## Behavior specifications

Behavior specifications are the executable product contract and should be
organized the same way as test cases.

- Keep all behavior specifications under `behavior/`.
- Group closely related behaviors in one file. Split files by product area,
  not by individual behavior.
- Give every behavior a unique, stable ID formed from an uppercase product-area
  prefix, a hyphen, and eight randomly generated uppercase hexadecimal
  characters, for example `CHAT-7A3F19C2`.
- The random suffix must not encode sequence, file position, title, or priority.
  Adding, moving, or removing a behavior must never change another behavior's
  ID.
- Check the whole `behavior/` directory for a collision before assigning a new
  ID.
- Never change or reuse an assigned behavior ID. When a behavior is removed,
  record its ID in the retired-ID list in `behavior/README.md`.
- Use one level-two heading per behavior in the form
  `## <ID> — <short description>`.
- Express each behavior as Given/When/Then, using literal tab indentation.
- Write `Given` with no indentation, each `When` with one tab, and each `Then`
  with two tabs. This allows several sibling `When` clauses to share one
  `Given`.
- Put every `And` or `Or` condition on its own line. Indent it beneath the
  clause it extends: one tab for a `Given` condition, two tabs for a `When`
  condition, and three tabs for a `Then` condition.
- Keep setup, action, and outcome distinct. Do not combine Given, When, Then,
  And, or Or clauses on one line.
- Tests should reference the behavior ID they implement.

Use this exact layout:

```text
## CHAT-7A3F19C2 — Hold an interactive conversation

Given the server is healthy
	And the terminal is interactive
	When the user runs `rr talk`
		And submits a non-empty message
		Then rr sends the message to Pi
			And displays Pi's response
```

Each behavior file may start with a level-one heading and a short scope note,
but normative outcomes belong in identified Given/When/Then behaviors.
