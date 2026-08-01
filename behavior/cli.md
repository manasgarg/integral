# CLI behaviors

These behaviors cover command discovery and implementation information.

## CLI-6001FE46 — Show top-level help

Given integral is installed
	When the user runs `integral`, `integral --help`, `integral -h`, or `integral help`
		Then the command exits successfully
			And lists `server`, `talk`, `queue`, `connection`, `config`, and `version`
			And does not list a separate `auth` or `credential` command
			And describes each command in plain English
	When npm reads the package metadata
		Then the package is named `@pirogram/integral`
			And it exposes `integral` through `bin/integral.js`
			And it does not expose an `rr` binary

## CLI-04301CCA — Report the implementation version

Given integral is installed
	When the user runs `integral version`
		Then the command prints the integral version
			And prints the Node.js version
			And reports that Pi is resolved to the latest runtime version when needed
			And exits successfully
	When the user runs `integral --version` or `integral -V`
		Then the command prints the same implementation versions
			And exits successfully

## CLI-A7D3E91B — Accept short help on every command

Given integral is installed
	When the user adds `-h` to any integral command or subcommand
		Then integral prints the applicable help
			And exits successfully
			And does not perform the command operation
