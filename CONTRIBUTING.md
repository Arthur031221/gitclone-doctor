# Contributing

Use Node 20 or newer and Git. The runtime CLI has no production dependencies.

Run the offline test suite with `npm test`. The tests cover target validation, config isolation, report redaction, process limits and cleanup, verdict branches, and real Git requests to a local smart-HTTP fixture.

The optional media script uses VHS, and the share card renderer uses the Playwright skill installation. Regenerate the terminal capture from the project root with `vhs scripts/demo.tape`. The tape runs the real local demo twice. These tools are not required to run or test the CLI.

Keep any new report fields to fixed values, booleans, numeric HTTP statuses, and observed protocol names. Do not return raw stderr, headers, config values, trace output, or exception messages.
