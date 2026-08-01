# CLI behaviors

These behaviors cover command discovery and implementation information.

## CLI-001 — Show top-level help

Given rr is installed
	When the user runs `rr --help`
		Then the command exits successfully
			And lists `server`, `talk`, `auth`, and `version`
			And describes each command in plain English

## CLI-002 — Report the implementation version

Given rr is installed
	When the user runs `rr version`
		Then the command prints the rr version
			And prints the Node.js version
			And prints the supported Pi image tag
			And exits successfully
