# CLI behaviors

These behaviors cover command discovery and implementation information.

## CLI-6001FE46 — Show top-level help

Given rr is installed
	When the user runs `rr`, `rr --help`, `rr -h`, or `rr help`
		Then the command exits successfully
			And lists `server`, `talk`, `connection`, `config`, and `version`
			And does not list a separate `auth` or `credential` command
			And describes each command in plain English

## CLI-04301CCA — Report the implementation version

Given rr is installed
	When the user runs `rr version`
		Then the command prints the rr version
			And prints the Node.js version
			And reports that Pi is resolved to the latest runtime version when needed
			And exits successfully
	When the user runs `rr --version` or `rr -V`
		Then the command prints the same implementation versions
			And exits successfully

## CLI-A7D3E91B — Accept short help on every command

Given rr is installed
	When the user adds `-h` to any rr command or subcommand
		Then rr prints the applicable help
			And exits successfully
			And does not perform the command operation
