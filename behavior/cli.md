# CLI behaviors

These behaviors cover command discovery and implementation information.


## CLI-6001FE46 — Show top-level help

Given integral is installed
	When the user runs `integral`, `integral --help`, `integral -h`, or `integral help`
		Then the command exits successfully
			And lists `server`, `talk`, `queue`, `schedule`, `connection`, `image`, `config`, and `version`
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

## CLI-5D8A1C72 — Let a trusted host operator edit and rebuild the Pi image

Given a user has local authority to operate an Integral deployment
	When the user runs `integral image edit`
		Then Integral opens a temporary working copy of the active Dockerfile in the configured editor
			And validates the resulting recipe and foundational-image boundary before changing canonical state
			And durably commits a changed valid Dockerfile to the host-managed image-recipe repository with the local operator as actor
			And leaves the active recipe unchanged when the editor exits unsuccessfully, the file is unchanged, or validation fails
			And does not create an approval request
	When the user runs `integral image rebuild`
		Then Integral directly starts a fresh build of the active recipe with pull and layer-cache reuse disabled
			And applies the same build isolation, validation, floating dependency resolution, inventory capture, and immutable image selection as an approved rebuild
			And records the local operator, recipe commit, prior image digest, build result, installed package inventory, and resulting image digest in the audit history
			And does not create an approval request
	When the user requests help for `integral image`, `integral image edit`, or `integral image rebuild`
		Then Integral explains that these are privileged local operator actions
			And distinguishes them from Pi and remote automation requests that require approval
			And performs no edit or build
