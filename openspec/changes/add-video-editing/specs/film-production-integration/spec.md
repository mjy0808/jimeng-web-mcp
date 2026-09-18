## ADDED Requirements

### Requirement: Exact source video editing
The server SHALL submit an explicit Seedance 2.5 edit of one source video and preserve the approved prompt, source identity and interval.

#### Scenario: Valid edit
- **WHEN** Film Studio supplies a persisted submit ID, validated source, exact prompt and valid interval
- **THEN** submission binds source video and image references with edit_input
- **AND** recovery only queries that submit ID.

#### Scenario: Invalid input
- **WHEN** source hash, duration, interval or reference tokens are invalid
- **THEN** no billable or substitute request is submitted.

### Requirement: Non-destructive edit review
Film Studio SHALL retain the source Take and selection until explicit result selection.

#### Scenario: Result arrives
- **WHEN** full-duration output is validated
- **THEN** it becomes a pending Take with parent provenance
- **AND** current selection and scene cuts remain unchanged.

#### Scenario: Unexpected segment
- **WHEN** output duration differs from the source
- **THEN** it stays downloaded with a Chinese recovery error
- **AND** it is not imported as a full shot or silently spliced.
