# Project instructions

Speak in plain English.

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
