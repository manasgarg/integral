# CLI behaviors

These behaviors cover command discovery, implementation information, and the
deliberate overlap between shell commands and local commands in `integral talk`.

## CLI-6001FE46 — Show top-level help

Given integral is installed
	When the user runs `integral`, `integral --help`, `integral -h`, or `integral help`
		Then the command exits successfully
			And lists `server`, `talk`, `status`, `model`, `queue`, `approval`, `schedule`, `connection`, `image`, `config`, and `version`
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

## CLI-D1B5816E — Keep conversation operations available in the CLI and talk

Given the integral coordinator is healthy
	And an operation concerns the default terminal conversation rather than host administration or terminal lifecycle
	When the user invokes `integral status` or enters `/status` in `integral talk`
		Then integral reports the same conversation and component status from either surface
	When the user invokes `integral model [<pattern>...]` or enters `/model [<pattern>...]` in `integral talk`
		Then integral uses the same model chooser and changes the same durable conversation selection from either surface
	When the user invokes `integral connection catalog` or enters `/connection catalog` in `integral talk`
		Then integral shows the same public connection types and authentication methods from either surface
	When the user invokes `integral connection ls` or enters `/connection ls` in `integral talk`
		Then integral shows the same connection names, types, authentication methods, and states from either surface
			And neither surface prints secret values
	When the user invokes `integral queue ls`, `integral queue edit <id> <text>`, or `integral queue delete <id>`
		And the user could instead enter the corresponding `/queue` command in `integral talk`
		Then integral reads or changes the same durable queue from either surface
	When the user invokes `integral approval ls` or enters `/approvals` in `integral talk`
		Then integral lists the same durable approval requests from either surface
	When the user invokes `integral approval approve <id>` or `integral approval deny <id>`
		And the user could instead enter the corresponding `/approve <id>` or `/deny <id>` command in `integral talk`
		Then integral decides the same durable approval request from either surface
			And applies the same validation, revalidation, authorization, persistence, and redaction rules
			And attributes the shell form to the trusted local operator
			And attributes the slash form to the attached human terminal
	When a shared operation succeeds or fails
		Then both surfaces report the same essential result or actionable error
			And the shell form exits without attaching a talk session
			And the slash form keeps the current talk session attached
			And the slash form handles the operation on the host without sending it to Pi
	When integral shows top-level CLI help or local talk help
		Then it identifies the equivalent spelling for every shared operation on the other surface
Given an operation is specific to host administration, scripting, or an attached terminal
	When integral shows top-level CLI help or local talk help
		Then `server`, `talk`, `schedule`, `image`, `config`, and `version` remain CLI-only
			And connection setup, credential rotation, and removal remain CLI-only
			And structured-output flags remain CLI-only
			And `/exit` remains talk-only
			And integral does not treat an arbitrary top-level CLI command as a local talk command

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
