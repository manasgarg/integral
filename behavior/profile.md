# Pi profile repository

These behaviors cover only Integral's initialization and projection of one
opaque host-managed repository at Pi's native user-profile directory. Profile
contents and synchronization with any remote repository are outside Integral's
responsibility in this behavior increment.

<!-- Automation note (PROFILE-6A93810F): This behavior defines planned Pi profile bootstrap functionality; executable coverage will land with implementation. -->
<!-- Automation note (PROFILE-3083AEEE): This behavior defines planned native Pi profile projection functionality; executable coverage will land with implementation. -->

## PROFILE-6A93810F — Initialize one opaque Pi profile repository

Given the deployment has never created a Pi profile repository
	When `integral server start` starts a Pi-capable server
		Or the runner first attempts to provision Pi
		Then integral creates one ordinary governed host repository through the existing repository protocol
			And names its connection `pi-profile`
			And gives it the host-managed `direct` write policy
			And records `/home/pi/.pi/agent` as its immutable mount path
			And initializes its canonical branch as `main` with an empty commit
			And performs repository creation and connection registration as one serialized operation
			And records durably that profile initialization completed
			And does not add or interpret any profile content
	When concurrent components attempt the first initialization
		Then exactly one canonical repository and one initial commit are created
			And every component observes the same durable repository identity

Given profile initialization completed previously
	And the `pi-profile` repository was later soft-deleted
	When integral starts again
		Then it does not create a replacement profile repository
			And leaves restoration to the ordinary governed repository lifecycle

## PROFILE-3083AEEE — Mount the profile at Pi's native directory

Given the `pi-profile` repository is active and available
	When integral provisions an interactive or isolated scheduled Pi session
		Then it materializes a writable per-run checkout through the ordinary governed repository protocol
			And places the checkout at `/home/pi/.pi/agent` before Pi starts
			And records the exact profile commit with the run
			And exposes the checkout through the ordinary governed repository tools and lifecycle
			And does not apply profile-specific parsing, validation, building, installation, or interpretation on the host

Given the `pi-profile` repository is unavailable or soft-deleted
	When integral provisions a Pi session
		Then it applies the ordinary governed repository omission and availability behavior
			And starts Pi with an empty native user-profile directory
			And reports that `pi-profile` is unavailable without exposing its host path

Given the `pi-profile` repository was soft-deleted
	When Pi or an operator requests its restoration
		Then integral accepts only `/home/pi/.pi/agent` as its restored mount path
			And otherwise applies the ordinary governed repository restoration behavior
